import OpenAI from 'openai';
import { createReadStream } from 'fs';

const DEFAULT_WHISPER_PROMPT =
  'Голосовой помощник. Пользователь говорит на русском: команды, вопросы, рецепты, погода, альтрон.';

/**
 * Распознавание речи через OpenAI Whisper API.
 * prompt задаёт контекст и частые слова — улучшает качество для русского.
 */
export async function transcribe(inputPath: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY не задан (нужен для Whisper API).');
  const client = new OpenAI({ apiKey });
  const prompt = process.env.OPENAI_WHISPER_PROMPT ?? DEFAULT_WHISPER_PROMPT;
  const model = process.env.OPENAI_WHISPER_MODEL ?? 'whisper-1';
  const transcription = await client.audio.transcriptions.create({
    file: createReadStream(inputPath),
    model,
    language: 'ru',
    response_format: 'text',
    ...(prompt ? { prompt: prompt.slice(0, 500) } : {}),
  });
  const raw = (typeof transcription === 'string'
    ? transcription
    : String((transcription as { text?: string }).text ?? '')
  ).trim();
  console.log(
    '[transcribe]',
    JSON.stringify({
      model,
      text: raw,
    }),
  );
  if (isPromptEcho(raw, prompt)) return '';
  return raw;
}

/** Whisper на тишине/шуме возвращает промпт как «транскрипт» — отсекаем. */
function isPromptEcho(text: string, prompt: string): boolean {
  if (!text) return true;
  const t = text.toLowerCase().replace(/[.,!?;:\s]+/g, ' ').trim();
  const p = prompt.toLowerCase().replace(/[.,!?;:\s]+/g, ' ').trim();
  if (t.includes(p)) return true;
  if (p.includes(t) && t.length > p.length * 0.4) return true;
  return false;
}
