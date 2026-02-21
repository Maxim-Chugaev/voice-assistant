import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

import { createRequire } from 'module';
import { createWriteStream } from 'fs';
import { tmpdir } from 'os';
import readlineSync from 'readline-sync';
import { transcribe } from './stt.js';
import { speak } from './tts.js';
import { chat, type Message } from './chat.js';

const require = createRequire(import.meta.url);
const AudioRecorder = require('node-audiorecorder');

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
        thresholdStop: 0.5,
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

    console.log(durationHint);
    readlineSync.question('Нажмите Enter чтобы остановить запись… ');
    recorder.stop();
  });
}

async function main(): Promise<void> {
  ensureEnv();
  console.log('Голосовой помощник (ChatGPT + локальные STT/TTS)');
  console.log('Требуется SoX: brew install sox');
  console.log('');

  const history: Message[] = [];

  while (true) {
    const action = readlineSync.question(
      'Введите: 1 — записать голос, 2 — ввести текст, q — выход: '
    );
    if (action === 'q' || action === 'Q') {
      console.log('До свидания.');
      break;
    }

    let userText: string;

    if (action === '1') {
      try {
        const wavPath = await recordToFile('Говорите в микрофон…');
        console.log('Распознавание…');
        userText = await transcribe(wavPath);
        const { unlinkSync } = await import('fs');
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
