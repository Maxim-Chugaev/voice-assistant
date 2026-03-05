import dotenv from "dotenv";

dotenv.config();

/** Параметры из .env и константы приложения */
export const config = {
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
  },
  porcupine: {
    accessKey: process.env.PORCUPINE_ACCESS_KEY,
    keywordPath: process.env.PORCUPINE_KEYWORD_PATH,
    builtinKeyword: (process.env.PORCUPINE_BUILTIN_KEYWORD ?? "jarvis").toLowerCase(),
  },
  gate: {
    /** Сколько миллисекунд после wake word отправлять речь в API */
    windowMs: Number(process.env.WAKE_WINDOW_MS ?? "8000"),
    /** Закрыть окно, если тишина дольше (мс) */
    silenceMs: Number(process.env.GATE_SILENCE_MS ?? "1200"),
    /** Порог RMS для «есть речь» (локальный VAD) */
    minRms: Number(process.env.MIN_RMS ?? "200"),
    /** Антидребезг: не реагировать на повторный wake word раньше (мс) */
    debounceMs: Number(process.env.WAKE_DEBOUNCE_MS ?? "1500"),
  },
  beep: {
    durationMs: Number(process.env.BEEP_DURATION_MS ?? "150"),
    freqHz: Number(process.env.BEEP_FREQ ?? "880"),
  },
  audio: {
    /** Частота выхода (ответы ассистента) — 24 kHz для OpenAI */
    outputSampleRate: 24000,
    /** Частота входа (микрофон, Porcupine) */
    inputSampleRate: 16000,
    channels: 1,
  },
  /** Устройство записи на Linux (arecord -D) / macOS (AUDIODEV) */
  audioDevice: process.env.AUDIO_DEVICE,
  /** Устройство воспроизведения (Linux): target для pw-play — pw-play --list-targets */
  audioOutputDevice: process.env.AUDIO_OUTPUT_DEVICE,
} as const;

export function requireEnv(name: string, value: string | undefined): string {
  if (!value?.trim()) {
    throw new Error(`Set ${name} in .env`);
  }
  return value;
}
