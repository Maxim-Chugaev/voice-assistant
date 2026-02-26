import OpenAI from 'openai';
import { createReadStream } from 'fs';

const DEFAULT_WHISPER_PROMPT =
  'Просто распознавай русскую речь пользователя без добавления лишних слов.';

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
  const norm = (s: string) =>
    s.toLowerCase().replace(/[.,!?;:\s]+/g, ' ').trim();

  const t = norm(text);
  const p = norm(prompt);

  if (!t) return true;
  if (!p) return false;

  // Если нормализованный промпт полностью входит в нормализованный текст —
  // считаем это эхом промпта, даже если текст длиннее.
  if (t.includes(p)) return true;

  // Полное или почти полное совпадение по длине
  const lenRatio = t.length / p.length;
  if (lenRatio > 0.8 && lenRatio < 1.2) {
    const tWords = new Set(t.split(' '));
    const pWords = new Set(p.split(' '));
    let common = 0;
    for (const w of tWords) {
      if (pWords.has(w)) common++;
    }
    const overlapT = common / Math.max(tWords.size, 1);
    const overlapP = common / Math.max(pWords.size, 1);
    if (overlapT >= 0.7 && overlapP >= 0.7) return true;
  }

  // Текст почти целиком содержится в промпте
  if (p.includes(t) && t.length > p.length * 0.5) return true;

  return false;
}
