import OpenAI from 'openai';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';

const TTS_MODEL = process.env.OPENAI_TTS_MODEL ?? 'tts-1';
const TTS_VOICE = (process.env.OPENAI_TTS_VOICE ?? 'nova') as 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';
const TTS_VOLUME = parseInt(process.env.TTS_VOLUME ?? '200', 10);

export async function generateAudio(text: string): Promise<string | null> {
  if (!text.trim()) return null;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY не задан.');

  const client = new OpenAI({ apiKey });
  const response = await client.audio.speech.create({
    model: TTS_MODEL,
    voice: TTS_VOICE,
    input: text,
    response_format: 'opus',
  });

  const buf = Buffer.from(await response.arrayBuffer());
  const filePath = join(tmpdir(), `tts-${Date.now()}-${Math.floor(Math.random() * 10000)}.opus`);
  writeFileSync(filePath, buf);
  return filePath;
}

export async function speak(text: string): Promise<void> {
  const filePath = await generateAudio(text);
  if (!filePath) return;

  try {
    await playAudioFile(filePath);
  } finally {
    try { unlinkSync(filePath); } catch { /* ignore */ }
  }
}

export function playAudioFile(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const isMac = process.platform === 'darwin';
    const child = spawn(isMac ? 'afplay' : 'mpv', isMac ? [path] : ['--no-video', `--volume=${TTS_VOLUME}`, path], {
      stdio: 'ignore',
    });
    child.on('error', reject);
    child.on('close', (code: number | null) =>
      code === 0 ? resolve() : reject(new Error(`exit ${code}`))
    );
  });
}
