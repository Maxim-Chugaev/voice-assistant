## Голосовой ассистент (OpenAI Realtime + Porcupine)

Голосовой ассистент на **Node.js/TypeScript**, построенный на **OpenAI Realtime API**:
распознавание речи, чат и синтез голоса происходят внутри одной realtime-сессии.
Активация по локальному wake word через **Picovoice Porcupine**.

### Возможности

- **Локальный wake word**: по умолчанию слово `jarvis` (или другой доступный builtin, либо свой `.ppn`).
- **Gate-окно**: после wake word микрофон попадает в «окно» фиксированной длины и только в нём стримится в Realtime API.
- **Локальный VAD (RMS)**: внутри окна тишина/шум отсекаются и окно может закрыться раньше по `GATE_SILENCE_MS`.
- **Авто-завершение фразы**: на стороне OpenAI включён `semantic_vad` с `createResponse`, поэтому модель сама понимает, когда вы договорили.
- **Barge‑in**: если сказать wake word, пока ассистент говорит, текущий ответ прерывается и начинается новый.
- **Само-защита от самопереговора**: пока ассистент произносит ответ, микрофон не стримится в Realtime API.

## Требования

- **Node.js** 18+
- **OpenAI API key** — для Realtime API (`gpt-realtime`).
- **Picovoice Porcupine AccessKey** — для локального wake word.
- **Воспроизведение звука** (одно из):
  - **Linux**: PipeWire — `pw-play` (обычно уже есть при использовании PipeWire).
  - **macOS**: SoX — `brew install sox` (команда `play`).

## Установка

```bash
cd voice-assistant
yarn install
cp .env.example .env
# Отредактируйте .env и укажите:
# - OPENAI_API_KEY=sk-...
# - PORCUPINE_ACCESS_KEY=...
```

## Запуск

Собрать и запустить:

```bash
yarn build
yarn start
```

Или одномоментно (быстрый запуск после правок):

```bash
yarn dev
```

Проверка одного только wake word (без Realtime API):

```bash
yarn audio-test
```

## Как это работает

1. При старте создаётся `RealtimeAgent` и `RealtimeSession` с моделью `gpt-realtime` и конфигом:
   - `audio.input.format = "pcm16"`
   - `audio.input.transcription.model = "gpt-4o-mini-transcribe"`
   - `audio.input.turnDetection = semantic_vad + createResponse`
   - `audio.output.format = "pcm16"` (24 kHz)
2. Микрофон читает **16 kHz mono PCM16** через `node-record-lpcm16`.
3. Поток идёт в Porcupine (локально на CPU). При детекте wake word:
   - открывается gate‑окно на `WAKE_WINDOW_MS` миллисекунд,
   - запоминается время последней речи.
4. Пока окно открыто:
   - все аудиочанки стримятся в `session.sendAudio(...)`;
   - локальный RMS‑VAD (`MIN_RMS`) следит за наличием речи и может закрыть окно раньше после `GATE_SILENCE_MS` тишины.
5. Realtime‑модель сама детектит конец фразы (`semantic_vad`) и начинает говорить.
6. Событие `session.on("audio")` отдаёт PCM‑чанки, которые передаются в внешний плеер: на Linux — `pw-play`, на macOS — `sox play` (24 kHz, mono, s16le).

## Использование

1. Запустите ассистента (`yarn start` или `yarn dev`).
2. В консоли должно появиться:
   - `Connected. Say wake-word to activate…`
   - `Wake-word active: jarvis` (или ваше слово).
3. Скажите чётко wake word (например, **«jarvis»**), дождитесь в логах `Wake word detected`.
4. Сразу после wake word произнесите команду:
   - «какая сегодня погода»
   - «что умеешь»
   - «расскажи шутку»
5. Ассистент распознает фразу и вслух ответит.
6. Чтобы прервать текущий ответ и начать новый, снова скажите wake word.

## Переменные окружения (.env)

Смотри пример в `.env.example`. Кратко:

| Переменная | Описание |
| --- | --- |
| `OPENAI_API_KEY` | Ключ API OpenAI (обязательно). |
| `PORCUPINE_ACCESS_KEY` | AccessKey Picovoice (обязательно для wake word). |
| `PORCUPINE_BUILTIN_KEYWORD` | Встроенное wake word (по умолчанию `jarvis`). Если не поддерживается на вашей платформе, код сам подберёт другое из списка. |
| `PORCUPINE_KEYWORD_PATH` | Путь к кастомному `.ppn` (имеет приоритет над builtin). |
| `WAKE_WINDOW_MS` | Сколько миллисекунд после wake word стримить речь в Realtime API (по умолчанию 8000). |
| `GATE_SILENCE_MS` | Закрыть окно, если столько миллисекунд нет речи (по умолчанию 1200). |
| `MIN_RMS` | Порог RMS для локального VAD (по умолчанию 200). Меньше — чувствительнее к тихой речи. |
| `WAKE_DEBOUNCE_MS` | Антидребезг для wake word (по умолчанию 1500 мс). |
| `AUDIO_DEVICE` | Устройство записи (микрофон): Linux — `arecord -D`, macOS — через `AUDIODEV`. |
| `AUDIO_OUTPUT_DEVICE` | Устройство воспроизведения (колонки). **Linux**: target для `pw-play` (имя или id узла). Список: `wpctl status` или `pw-cli list-objects Node` — в разделе Sinks взять id или имя нужного вывода. По умолчанию — системное (часто Bluetooth). macOS: не задавать. |

## Типичные проблемы и подсказки

- **Wake word срабатывает не всегда**:
  - немного понизьте `MIN_RMS` (например, до `150`);
  - говорите wake word чуть громче и ближе к микрофону;
  - при необходимости сократите `WAKE_DEBOUNCE_MS`, если часто триггерите подряд осознанно.

- **Ответы иногда не приходят**:
  - убедитесь, что после `Wake word detected` вы действительно говорите в течение окна (`WAKE_WINDOW_MS`);
  - проверьте, что ключ `OPENAI_API_KEY` активен и имеет доступ к `gpt-realtime`.

- **Нет звука / ошибка при воспроизведении**:
  - Linux: убедитесь, что установлен PipeWire и в PATH есть `pw-play`.
  - macOS: установите SoX — `brew install sox` (нужна команда `play`).

- **На Linux звук идёт в Bluetooth-колонку, а нужны проводные (например Edifier по USB)**:
  - Список устройств вывода: выполните **`wpctl status`** (или `pw-cli list-objects Node`). В разделе **Audio → Sinks** найдите свой USB-выход (Edifier / USB Audio) и запомните **id** (число) или **имя** узла.
  - В `.env` задайте `AUDIO_OUTPUT_DEVICE` — этот id или имя, например: `AUDIO_OUTPUT_DEVICE=42` или `AUDIO_OUTPUT_DEVICE=alsa_output.usb-0bda_4014-00.analog-stereo`.
  - Перезапустите ассистента — воспроизведение пойдёт в выбранное устройство.

## Структура проекта

- `src/index.ts` — основной ассистент: Porcupine, wake word, gate‑окно, локальный VAD, RealtimeSession, вывод звука.
- `src/audio-test.ts` — минимальный тест Porcupine/wake word без подключения к OpenAI.
- `src/types/external-modules.d.ts` — декларации для внешних модулей без типов (`node-record-lpcm16`, `@picovoice/porcupine-node`).

## Лицензия

MIT
