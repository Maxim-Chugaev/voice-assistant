import * as Echogarden from 'echogarden';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import type { SynthesisOptions } from 'echogarden';

const defaultOptions: Partial<SynthesisOptions> = {
  engine: 'kokoro',
  language: 'ru',
};

/**
 * Конвертация RawAudio в WAV (минимальный заголовок + данные).
 */
function rawAudioToWavBuffer(
  raw: { sampleRate: number; channels: Float32Array[] }
): Buffer {
  const numChannels = raw.channels.length;
  const numSamples = raw.channels[0].length;
  const bytesPerSample = 2;
  const dataSize = numSamples * numChannels * bytesPerSample;
  const headerSize = 44;
  const buffer = Buffer.alloc(headerSize + dataSize);
  let offset = 0;

  const write = (value: number, bytes: number) => {
    buffer.writeUIntLE(value, offset, bytes);
    offset += bytes;
  };

  buffer.write('RIFF', 0);
  write(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  write(16, 4);
  write(1, 2);
  write(numChannels, 2);
  write(raw.sampleRate, 4);
  write(raw.sampleRate * numChannels * bytesPerSample, 4);
  write(numChannels * bytesPerSample, 2);
  write(16, 2);
  buffer.write('data', 36);
  write(dataSize, 4);

  const out = new Int16Array(numSamples * numChannels);
  for (let i = 0; i < numSamples; i++) {
    for (let c = 0; c < numChannels; c++) {
      const s = Math.max(-1, Math.min(1, raw.channels[c][i]));
      out[i * numChannels + c] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
  }
  Buffer.from(out.buffer).copy(buffer, headerSize);
  return buffer;
}

/**
 * Локальный синтез речи (TTS) через echogarden и воспроизведение.
 * @param text текст для озвучки
 * @param options опции синтеза
 */
export async function speak(
  text: string,
  options: Partial<SynthesisOptions> = {}
): Promise<void> {
  if (!text.trim()) return;

  const result = await Echogarden.synthesize(text, {
    ...defaultOptions,
    ...options,
  });

  const audio = result.audio;
  const wavBuffer =
    audio && 'sampleRate' in audio && 'channels' in audio
      ? rawAudioToWavBuffer(audio)
      : Buffer.isBuffer(audio) || audio instanceof Uint8Array
        ? Buffer.from(audio as ArrayBuffer)
        : null;

  if (!wavBuffer || wavBuffer.length === 0) {
    console.warn('TTS: нет аудио для воспроизведения');
    return;
  }

  const wavPath = join(tmpdir(), `voice-assistant-tts-${Date.now()}.wav`);
  writeFileSync(wavPath, wavBuffer);

  try {
    await playWav(wavPath);
  } finally {
    try {
      unlinkSync(wavPath);
    } catch {
      // ignore
    }
  }
}

function playWav(wavPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const isMac = process.platform === 'darwin';
    const child = spawn(isMac ? 'afplay' : 'aplay', [wavPath], {
      stdio: 'ignore',
    });
    child.on('error', reject);
    child.on('close', (code: number | null) =>
      code === 0 ? resolve() : reject(new Error(`exit ${code}`))
    );
  });
}
