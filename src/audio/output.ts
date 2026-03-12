import Speaker from "speaker";
import { config } from "../config.js";

const SAMPLE_RATE = config.audio.outputSampleRate;
const CHANNELS = config.audio.channels;
const BIT_DEPTH = 16;

export class PcmOutput {
  private speaker: Speaker;

  constructor() {
    this.speaker = new Speaker({
      channels: CHANNELS,
      bitDepth: BIT_DEPTH,
      sampleRate: SAMPLE_RATE,
    });
  }

  write(chunk: Buffer) {
    if ((this.speaker as unknown as { closed?: boolean }).closed) return;
    const ok = this.speaker.write(chunk);
    if (!ok) {
      // backpressure is handled internally by speaker; we don't queue manually
    }
  }

  beep(durationMs: number, freqHz: number) {
    const samples = Math.max(1, Math.floor((SAMPLE_RATE * durationMs) / 1000));
    const arr = new Int16Array(samples);
    const amplitude = 0.8 * 0x7fff;
    for (let i = 0; i < samples; i++) {
      const t = i / SAMPLE_RATE;
      arr[i] = Math.round(amplitude * Math.sin(2 * Math.PI * freqHz * t));
    }
    this.write(Buffer.from(arr.buffer));
  }

  close() {
    const maybeClosed = this.speaker as unknown as { closed?: boolean };
    if (maybeClosed.closed) return;
    this.speaker.end();
  }
}

