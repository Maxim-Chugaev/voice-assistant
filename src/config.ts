import dotenv from "dotenv";

dotenv.config();

/** Configuration derived from .env and app constants. */
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
    /** How many ms after wake word to stream mic audio into the API. */
    windowMs: Number(process.env.WAKE_WINDOW_MS ?? "8000"),
    /** Close gate if there is silence longer than this (ms). */
    silenceMs: Number(process.env.GATE_SILENCE_MS ?? "1200"),
    /** RMS threshold for "speech present" (local VAD). */
    minRms: Number(process.env.MIN_RMS ?? "200"),
    /** Debounce: ignore repeated wake words for this many ms. */
    debounceMs: Number(process.env.WAKE_DEBOUNCE_MS ?? "1500"),
  },
  beep: {
    durationMs: Number(process.env.BEEP_DURATION_MS ?? "150"),
    freqHz: Number(process.env.BEEP_FREQ ?? "880"),
  },
  audio: {
    /** Output sample rate (assistant replies) — 24 kHz for OpenAI. */
    outputSampleRate: 24000,
    /** Input sample rate (mic, Porcupine). */
    inputSampleRate: 16000,
    channels: 1,
  },
  /** Input device on Linux (arecord -D) / macOS (AUDIODEV). */
  audioDevice: process.env.AUDIO_DEVICE,
  /** Output device on Linux: pw-play target — see pw-play --list-targets. */
  audioOutputDevice: process.env.AUDIO_OUTPUT_DEVICE,
} as const;

export function requireEnv(name: string, value: string | undefined): string {
  if (!value?.trim()) {
    throw new Error(`Set ${name} in .env`);
  }
  return value;
}
