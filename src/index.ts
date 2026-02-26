import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import { transcribe } from './stt.js';
import { speak, generateAudio, playAudioFile } from './tts.js';
import { chat, chatStream, type Message } from './chat.js';

function ts(): string {
  return new Date().toLocaleTimeString('ru-RU', { hour12: false });
}
function log(...args: unknown[]): void {
  console.log(`[${ts()}]`, ...args);
}
function logErr(...args: unknown[]): void {
  console.error(`[${ts()}]`, ...args);
}

const WAKE_WORD = process.env.WAKE_WORD ?? 'альтрон';

function ensureEnv(): void {
  if (!process.env.OPENAI_API_KEY) {
    logErr('Задайте OPENAI_API_KEY в .env или в окружении.');
    logErr('Скопируйте .env.example в .env и укажите ключ.');
    process.exit(1);
  }
}

const SAMPLE_RATE = 16000;
const PCM_BYTES_PER_SEC = SAMPLE_RATE * 2;
const MIC_DEVICE = process.env.MIC_DEVICE;

/** Кольцевой буфер: последние N секунд PCM. */
class RingBuffer {
  private buf: Buffer;
  private size: number;
  private pos = 0;
  private filled = 0;

  constructor(seconds: number) {
    this.size = seconds * PCM_BYTES_PER_SEC;
    this.buf = Buffer.alloc(this.size);
  }

  push(chunk: Buffer): void {
    if (chunk.length >= this.size) {
      chunk.copy(this.buf, 0, chunk.length - this.size);
      this.pos = 0;
      this.filled = this.size;
      return;
    }
    const start = this.pos;
    if (chunk.length <= this.size - start) {
      chunk.copy(this.buf, start);
    } else {
      const first = this.size - start;
      chunk.copy(this.buf, start, 0, first);
      chunk.copy(this.buf, 0, first);
    }
    this.pos = (this.pos + chunk.length) % this.size;
    this.filled = Math.min(this.filled + chunk.length, this.size);
  }

  /** Последние `seconds` секунд (не больше реально записанного). */
  getLast(seconds: number): Buffer {
    const want = seconds * PCM_BYTES_PER_SEC;
    const take = Math.min(want, this.filled);
    if (take === 0) return Buffer.alloc(0);
    const start = (this.pos - take + this.size) % this.size;
    if (start + take <= this.size) return this.buf.subarray(start, start + take);
    return Buffer.concat([
      this.buf.subarray(start, this.size),
      this.buf.subarray(0, take - (this.size - start)),
    ]);
  }
}

function pcmToWav(pcm: Buffer, outPath: string): void {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  writeFileSync(outPath, Buffer.concat([h, pcm]));
}

/** RMS энергия PCM-буфера (16-bit LE mono). Тишина ~0–200, речь ~500–5000+. */
function pcmRms(pcm: Buffer): number {
  let sum = 0;
  const samples = pcm.length >> 1;
  for (let i = 0; i < pcm.length; i += 2) {
    const s = pcm.readInt16LE(i);
    sum += s * s;
  }
  return Math.sqrt(sum / (samples || 1));
}

const VAD_THRESHOLD = Math.max(50, Number(process.env.VAD_THRESHOLD) || 300);

/** Непрерывный захват: rec -t raw в stdout. */
function startContinuousRec(): { stream: NodeJS.ReadableStream; stop: () => void } {
  const args = ['-q', '-r', String(SAMPLE_RATE), '-c', '1', '-b', '16', '-t', 'raw', '-'];
  const env = { ...process.env };
  if (MIC_DEVICE) {
    env.AUDIODEV = MIC_DEVICE;
  }
  const proc = spawn('rec', args, { stdio: ['ignore', 'pipe', 'pipe'], env });
  proc.stderr?.on('data', (chunk: Buffer) => logErr('rec:', chunk.toString().trim()));
  proc.on('exit', (code: number | null, signal: string | null) => {
    if (code != null && code !== 0) logErr('rec завершился:', code, signal ?? '');
  });
  return { stream: proc.stdout!, stop: () => proc.kill('SIGTERM') };
}

/** Проверка, что в транскрипте есть wake word (учитываем искажения вроде "Альтрованная"). */
function transcriptHasWakeWord(transcript: string, wakeWord: string): boolean {
  const t = transcript.toLowerCase().trim();
  const stem = wakeWord.toLowerCase().slice(0, 5);
  return t.includes(wakeWord.toLowerCase()) || t.includes(stem);
}

/** Убираем wake word и его искажения с начала фразы перед отправкой в ChatGPT. */
function stripWakeWordFromStart(text: string, wakeWord: string): string {
  const w = wakeWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stem = w.slice(0, Math.min(5, w.length));
  const regex = new RegExp(`^(${w}|${stem}\\S*)[\\s,.:;!?-]*`, 'i');
  return text.replace(regex, '').trim();
}

/** Непрерывный режим: поток в кольцо, проверка по таймеру — паузы нет. */
async function runWakeWordMode(history: Message[]): Promise<void> {
  const RING_SEC = 6;
  const CHECK_SEC = 3;
  const CHECK_MS = 1500;
  const FIRST_CHECK_MS = 2500;
  const PHRASE_SEC = Math.max(4, Math.min(12, Number(process.env.WAKE_WORD_PHRASE_SECONDS) || 6));

  const { stream, stop } = startContinuousRec();
  const ring = new RingBuffer(RING_SEC);
  let checkBusy = false;
  let collectingPhrase = false;
  let phraseChunks: Buffer[] = [];
  let phraseEndAt = 0;
  let checkTimer: ReturnType<typeof setTimeout> | null = null;

  const doCheck = async (): Promise<'wake' | null> => {
    if (checkBusy || collectingPhrase) return null;
    checkBusy = true;
    const snap = ring.getLast(CHECK_SEC);
    if (snap.length < PCM_BYTES_PER_SEC) {
      checkBusy = false;
      return null;
    }
    const energy = pcmRms(snap);
    if (energy < VAD_THRESHOLD) {
      checkBusy = false;
      return null;
    }
    const wavPath = join(tmpdir(), `wake-${Date.now()}.wav`);
    try {
      pcmToWav(snap, wavPath);
      const text = await transcribe(wavPath);
      const t = text.toLowerCase().trim();
      if (!t) return null;
      if (transcriptHasWakeWord(text, WAKE_WORD)) return 'wake';
    } catch {
      /* ignore */
    } finally {
      try { unlinkSync(wavPath); } catch { /* ignore */ }
      checkBusy = false;
    }
    return null;
  };

  const processPhrase = async (pcm: Buffer): Promise<void> => {
    const wavPath = join(tmpdir(), `phrase-${Date.now()}.wav`);
    try {
      pcmToWav(pcm, wavPath);
      let userText = await transcribe(wavPath);
      userText = (userText ?? '').trim();
      userText = stripWakeWordFromStart(userText, WAKE_WORD) || userText;
      if (!userText || userText.length < 2) {
        log('Не удалось распознать.');
        return;
      }
      log('Вы:', userText);
      history.push({ role: 'user', content: userText });
      try {
        log('Думаю (потоковый ответ)…');
        const stream = await chatStream(history);
        let fullReply = '';
        let sentenceBuffer = '';

        let audioChain = Promise.resolve();

        process.stdout.write(`[${ts()}] Ответ: `);

        const pushSentence = (sentence: string) => {
          const text = sentence.trim();
          if (!text) return;
          const downloadPromise = generateAudio(text);
          audioChain = audioChain.then(async () => {
            try {
              const path = await downloadPromise;
              if (path) {
                await playAudioFile(path);
                try { unlinkSync(path); } catch { /* ignore */ }
              }
            } catch (err) {
              logErr('Ошибка аудио:', err);
            }
          });
        };

        for await (const token of stream) {
          process.stdout.write(token);
          fullReply += token;
          sentenceBuffer += token;

          if (sentenceBuffer.match(/[.?!;](\s|\n)+$/) || sentenceBuffer.match(/\n$/)) {
            pushSentence(sentenceBuffer);
            sentenceBuffer = '';
          }
        }

        if (sentenceBuffer.trim()) {
          pushSentence(sentenceBuffer);
        }

        console.log(); // newline

        await audioChain;

        history.push({ role: 'assistant', content: fullReply.trim() });
      } catch (err) {
        logErr('Ошибка:', err);
        history.pop();
        console.log();
      }
    } finally {
      try { unlinkSync(wavPath); } catch { /* ignore */ }
    }
  };

  const schedule = (delay = CHECK_MS) => {
    checkTimer = setTimeout(async () => {
      const r = await doCheck();
      if (r === 'wake') {
        collectingPhrase = true;
        phraseChunks = [ring.getLast(RING_SEC)];
        phraseEndAt = Date.now() + PHRASE_SEC * 1000;
        log('Wake word! Говорите…');
      }
      schedule();
    }, delay);
  };

  stream.on('data', (chunk: Buffer) => {
    ring.push(chunk);
    if (collectingPhrase) {
      phraseChunks.push(chunk);
      if (Date.now() >= phraseEndAt) {
        collectingPhrase = false;
        const full = Buffer.concat(phraseChunks);
        phraseChunks = [];
        processPhrase(full).then(() => {
          log('');
          log(`Слушаю «${WAKE_WORD}»…`);
        }).catch(() => {
          log('');
          log(`Слушаю «${WAKE_WORD}»…`);
        });
      }
    }
  });

  stream.on('error', (e: Error) => logErr('Микрофон:', e));

  log(`Слушаю «${WAKE_WORD}» (непрерывно).`);
  log('');

  schedule(FIRST_CHECK_MS);

  await new Promise<void>((resolve) => {
    stream.on('close', resolve);
  }).finally(() => {
    if (checkTimer) clearTimeout(checkTimer);
  });
}

async function main(): Promise<void> {
  ensureEnv();
  log('Голосовой помощник');
  log('Скажите «' + WAKE_WORD + '» и команду.');
  log('');

  await runWakeWordMode([]);
  log('До свидания.');
}

main();
