import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import { transcribe } from './stt.js';
import { speak } from './tts.js';
import { chat, type Message } from './chat.js';


const WAKE_WORD = process.env.WAKE_WORD ?? 'альтрон';

function ensureEnv(): void {
  if (!process.env.OPENAI_API_KEY) {
    console.error('Задайте OPENAI_API_KEY в .env или в окружении.');
    console.error('Скопируйте .env.example в .env и укажите ключ.');
    process.exit(1);
  }
}

const SAMPLE_RATE = 16000;
const PCM_BYTES_PER_SEC = SAMPLE_RATE * 2;

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

/** Непрерывный захват: rec -t raw в stdout. */
function startContinuousRec(): { stream: NodeJS.ReadableStream; stop: () => void } {
  const proc = spawn('rec', [
    '-q', '-r', String(SAMPLE_RATE), '-c', '1', '-b', '16', '-t', 'raw', '-',
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  return { stream: proc.stdout!, stop: () => proc.kill('SIGTERM') };
}

/** Известные галлюцинации Whisper на тишине/шуме — игнорируем такой «транскрипт». */
const WHISPER_HALLUCINATION_MARKERS = [
  'редактор субтитров',
  'корректор',
  'спасибо за просмотр',
  'thanks for watching',
  'subscribe',
  'подпишись',
  'тревожная музыка',
  'спокойная музыка',
  // Whisper иногда возвращает подсказку (prompt) как «транскрипт», когда аудио тихое/неразборчивое
  'команды, вопросы, рецепты, погода',
  'пользователь говорит на русском',
];

function isWhisperHallucination(transcript: string): boolean {
  const t = transcript.toLowerCase().trim();
  if (!t) return true;
  return WHISPER_HALLUCINATION_MARKERS.some((m) => t.includes(m));
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
  const regex = new RegExp(`^(${w}|${stem}\\S*)\\s*`, 'i');
  return text.replace(regex, '').trim();
}

/** Непрерывный режим: поток в кольцо, проверка по таймеру — паузы нет. */
async function runWakeWordMode(history: Message[]): Promise<void> {
  const exitPhrases = ['стоп', 'выход', 'хватит'];
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

  const doCheck = async (): Promise<'exit' | 'wake' | null> => {
    if (checkBusy || collectingPhrase) return null;
    checkBusy = true;
    const snap = ring.getLast(CHECK_SEC);
    if (snap.length < PCM_BYTES_PER_SEC) {
      checkBusy = false;
      return null;
    }
    const wavPath = join(tmpdir(), `wake-${Date.now()}.wav`);
    try {
      pcmToWav(snap, wavPath);
      const text = await transcribe(wavPath);
      if (isWhisperHallucination(text)) {
        return null;
      }
      const t = text.toLowerCase().trim();
      if (exitPhrases.some((p) => t.includes(p))) return 'exit';
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
      if (!userText || isWhisperHallucination(userText) || userText.length < 2) {
        console.log('Не удалось распознать.');
        return;
      }
      console.log('Вы:', userText);
      history.push({ role: 'user', content: userText });
      try {
        console.log('Думаю…');
        const reply = await chat(history);
        history.push({ role: 'assistant', content: reply });
        console.log('Ответ:', reply);
        console.log('Озвучиваю…');
        await speak(reply);
      } catch (err) {
        console.error('Ошибка:', err);
        history.pop();
      }
    } finally {
      try { unlinkSync(wavPath); } catch { /* ignore */ }
    }
  };

  const schedule = (delay = CHECK_MS) => {
    checkTimer = setTimeout(async () => {
      const r = await doCheck();
      if (r === 'exit') {
        if (checkTimer) clearTimeout(checkTimer);
        stop();
        console.log('Выход.');
        return;
      }
      if (r === 'wake') {
        collectingPhrase = true;
        phraseChunks = [ring.getLast(2)];
        phraseEndAt = Date.now() + PHRASE_SEC * 1000;
        console.log('Wake word! Говорите…');
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
          console.log('');
          console.log(`Слушаю «${WAKE_WORD}»…`);
        }).catch(() => {
          console.log('');
          console.log(`Слушаю «${WAKE_WORD}»…`);
        });
      }
    }
  });

  stream.on('error', (e: Error) => console.error('Микрофон:', e));

  console.log(`Слушаю «${WAKE_WORD}» (непрерывно). «Стоп» — выход.`);
  console.log('');

  schedule(FIRST_CHECK_MS);

  await new Promise<void>((resolve) => {
    stream.on('close', resolve);
  }).finally(() => {
    if (checkTimer) clearTimeout(checkTimer);
  });
}

async function main(): Promise<void> {
  ensureEnv();
  console.log('Голосовой помощник');
  console.log('Скажите «' + WAKE_WORD + '» и команду. «Стоп» — выход.');
  console.log('');

  await runWakeWordMode([]);
  console.log('До свидания.');
}

main();
