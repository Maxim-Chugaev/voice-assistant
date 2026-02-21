# Голосовой помощник

Голосовой помощник на **Node.js/TypeScript**, полностью на базе **OpenAI API**: ChatGPT (чат), Whisper (распознавание речи), TTS (синтез речи).

## Возможности

- **STT** — распознавание речи через OpenAI Whisper API.
- **TTS** — синтез речи через OpenAI TTS API (голос `nova` по умолчанию).
- **ChatGPT** — ответы генерирует OpenAI API.
- **Wake word** — непрерывное прослушивание, реагирует на «альтрон» (настраивается). VAD отсекает тишину — Whisper не вызывается зря.

## Требования

- **Node.js** 18+
- **SoX** — для записи с микрофона:
  - macOS: `brew install sox`
  - Linux: `sudo apt install sox libsox-fmt-all`
- **OpenAI API key** — для ChatGPT, Whisper и TTS.

## Установка

```bash
cd voice-assistant
yarn install
cp .env.example .env
# Отредактируйте .env и укажите OPENAI_API_KEY=sk-...
```

## Запуск

```bash
yarn dev
```

Или раздельно:

```bash
yarn build
yarn start
```

## Использование

При запуске помощник непрерывно слушает микрофон. Скажите **«альтрон»** (или другое wake word из `.env`) и сразу свой вопрос. Помощник распознает речь, отправит в ChatGPT, озвучит ответ. Скажите **«стоп»** для выхода.

## Переменные окружения (.env)

| Переменная | Описание |
|---|---|
| `OPENAI_API_KEY` | Ключ API OpenAI (обязательно) |
| `OPENAI_MODEL` | Модель чата (по умолчанию: `gpt-4o-mini`) |
| `WAKE_WORD` | Wake word (по умолчанию: `альтрон`) |
| `WAKE_WORD_PHRASE_SECONDS` | Длина записи фразы после wake word, сек (4–12, по умолчанию 6) |
| `VAD_THRESHOLD` | Порог VAD — RMS энергия аудио (по умолчанию 300). Тишина ~0–200, речь ~500+ |
| `OPENAI_WHISPER_PROMPT` | Подсказка для Whisper: контекст и частые слова (до ~224 токенов) |
| `OPENAI_WHISPER_MODEL` | Модель STT: `whisper-1` (по умолчанию) или `gpt-4o-transcribe` |
| `OPENAI_TTS_MODEL` | Модель TTS: `tts-1` (по умолчанию) или `tts-1-hd` |
| `OPENAI_TTS_VOICE` | Голос TTS: `alloy`, `echo`, `fable`, `onyx`, `nova` (по умолчанию), `shimmer` |

## Стоимость

Всё работает через OpenAI API:

- **Whisper** — ~$0.006/мин. VAD отсекает тишину, поэтому в тихой комнате запросы идут только когда вы говорите.
- **TTS** — ~$0.015/1000 символов (`tts-1`), ~$0.030 (`tts-1-hd`).
- **ChatGPT** — зависит от модели и длины диалога.

## Структура проекта

- `src/index.ts` — wake word, VAD, кольцевой буфер, основной цикл.
- `src/stt.ts` — распознавание речи (OpenAI Whisper API).
- `src/tts.ts` — синтез речи (OpenAI TTS API) и воспроизведение (afplay/mpv).
- `src/chat.ts` — запросы к ChatGPT (OpenAI API).

## Лицензия

MIT
