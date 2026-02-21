import * as Echogarden from 'echogarden';
import type { RecognitionOptions } from 'echogarden';

const defaultOptions: Partial<RecognitionOptions> = {
  language: 'ru',
  engine: 'whisper',
};

/**
 * Локальное распознавание речи (STT) через echogarden (Whisper).
 * @param inputPath путь к WAV-файлу или Buffer с аудио
 * @returns распознанный текст
 */
export async function transcribe(
  inputPath: string,
  options: Partial<RecognitionOptions> = {}
): Promise<string> {
  const result = await Echogarden.recognize(inputPath, {
    ...defaultOptions,
    ...options,
  });
  return result.transcript.trim();
}
