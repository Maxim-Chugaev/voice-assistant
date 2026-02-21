import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { createRequire } from 'module';
import { createWriteStream, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import readlineSync from 'readline-sync';
import { transcribe } from './stt.js';
import { speak } from './tts.js';
import { chat, type Message } from './chat.js';

const require = createRequire(import.meta.url);
const AudioRecorder = require('node-audiorecorder');

const WAKE_WORD = process.env.WAKE_WORD ?? 'альтрон';

function ensureEnv(): void {
  if (!process.env.OPENAI_API_KEY) {
    console.error('Задайте OPENAI_API_KEY в .env или в окружении.');
    console.error('Скопируйте .env.example в .env и укажите ключ.');
    process.exit(1);
  }
}

function recordToFile(durationHint: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const wavPath = join(tmpdir(), `voice-assistant-${Date.now()}.wav`);
    const fileStream = createWriteStream(wavPath);

    const recorder = new AudioRecorder(
      {
        program: 'rec',
        rate: 16000,
        channels: 1,
        type: 'wav',
        silence: 300,
        thresholdStop: 0.01,
        keepSilence: true,
      },
      console
    );

    recorder.start();

    const stream = recorder.stream();
    if (!stream) {
      fileStream.close();
      return reject(new Error('Не удалось получить аудиопоток от рекордера'));
    }

    stream.pipe(fileStream);
    stream.on('error', (err: Error) => {
      fileStream.close();
      reject(err);
    });
    fileStream.on('error', reject);

    fileStream.on('finish', () => {
      resolve(wavPath);
    });

    console.log('Запись через 2 сек…');
    setTimeout(() => {
      console.log(durationHint);
      readlineSync.question('Нажмите Enter чтобы остановить запись… ');
      recorder.stop();
    }, 2000);
  });
}

/** Запись чанка фиксированной длительности через sox rec (без автостопа по тишине). */
function recordChunk(durationSec: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const wavPath = join(tmpdir(), `voice-chunk-${Date.now()}.wav`);
    const proc = spawn('rec', [
      '-q',
      '-r', '16000',
      '-c', '1',
      '-t', 'wav',
      wavPath,
      'trim', '0', String(durationSec),
    ], { stdio: 'ignore' });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(wavPath);
      else reject(new Error(`rec exit ${code}`));
    });
  });
}

/** Объединение WAV-файлов через sox. */
function concatenateWavs(paths: string[], outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('sox', [...paths, outPath], { stdio: 'ignore' });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`sox exit ${code}`));
    });
  });
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

async function runWakeWordMode(history: Message[]): Promise<void> {
  const chunkDuration = Math.max(3, Math.min(15, Number(process.env.WAKE_WORD_CHUNK_SECONDS) || 6));
  const exitPhrases = ['стоп', 'выход', 'хватит'];

  console.log(`Слушаю wake word «${WAKE_WORD}». Скажите «стоп» для выхода.`);
  console.log('');

  while (true) {
    const chunkPath = await recordChunk(chunkDuration);
    let transcript: string;
    try {
      transcript = await transcribe(chunkPath);
    } catch (err) {
      try { unlinkSync(chunkPath); } catch { /* ignore */ }
      continue;
    }

    if (isWhisperHallucination(transcript)) {
      try { unlinkSync(chunkPath); } catch { /* ignore */ }
      continue;
    }

    const t = transcript.toLowerCase().trim();
    if (exitPhrases.some((p) => t.includes(p))) {
      try { unlinkSync(chunkPath); } catch { /* ignore */ }
      console.log('Выход из режима wake word.');
      return;
    }

    if (!transcriptHasWakeWord(transcript, WAKE_WORD)) {
      try { unlinkSync(chunkPath); } catch { /* ignore */ }
      continue;
    }

    console.log('Wake word! Записываю…');
    const chunk2Path = await recordChunk(chunkDuration);
    const chunk3Path = await recordChunk(chunkDuration);
    const fullPath = join(tmpdir(), `voice-full-${Date.now()}.wav`);

    try {
      await concatenateWavs([chunkPath, chunk2Path, chunk3Path], fullPath);
    } finally {
      try { unlinkSync(chunkPath); unlinkSync(chunk2Path); unlinkSync(chunk3Path); } catch { /* ignore */ }
    }

    let userText: string;
    try {
      userText = await transcribe(fullPath);
    } finally {
      try { unlinkSync(fullPath); } catch { /* ignore */ }
    }

    userText = userText.trim();
    userText = stripWakeWordFromStart(userText, WAKE_WORD) || userText;

    if (!userText || isWhisperHallucination(userText) || userText.length < 2) {
      console.log('Не удалось распознать запрос.');
      continue;
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

    console.log('');
    console.log(`Слушаю «${WAKE_WORD}»…`);
  }
}

async function main(): Promise<void> {
  ensureEnv();
  console.log('Голосовой помощник (ChatGPT + локальные STT/TTS)');
  console.log('Требуется SoX: brew install sox');
  console.log('');

  const history: Message[] = [];

  while (true) {
    const action = readlineSync.question(
      'Введите: 1 — записать голос, 2 — ввести текст, 3 — wake word (скажите «' + WAKE_WORD + '»), q — выход: '
    );
    if (action === 'q' || action === 'Q') {
      console.log('До свидания.');
      break;
    }

    let userText: string;

    if (action === '3') {
      await runWakeWordMode(history);
      continue;
    }

    if (action === '1') {
      try {
        const wavPath = await recordToFile('Говорите в микрофон…');
        console.log('Распознавание…');
        userText = await transcribe(wavPath);
        try {
          unlinkSync(wavPath);
        } catch {
          // ignore
        }
      } catch (err) {
        console.error('Ошибка записи/распознавания:', err);
        continue;
      }
    } else if (action === '2') {
      userText = readlineSync.question('Введите текст: ');
    } else {
      continue;
    }

    userText = userText.trim();
    if (!userText) {
      console.log('Текст пустой, попробуйте снова.');
      continue;
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
  }
}

main();
