declare module 'echogarden' {
  export interface RawAudio {
    sampleRate: number;
    channels: Float32Array[];
  }

  export interface SynthesisOptions {
    engine?: string;
    language?: string;
    [key: string]: unknown;
  }

  export interface RecognitionOptions {
    engine?: string;
    language?: string;
    [key: string]: unknown;
  }

  export interface SynthesisResult {
    audio: RawAudio | Buffer | Uint8Array;
    timeline: unknown;
    language: string;
  }

  export interface RecognitionResult {
    transcript: string;
    timeline: unknown;
    wordTimeline?: unknown;
    language: string;
    inputRawAudio: RawAudio;
    isolatedRawAudio?: RawAudio;
    backgroundRawAudio?: RawAudio;
  }

  export function synthesize(
    input: string | string[],
    options?: SynthesisOptions,
    onSegment?: (data: unknown) => void | Promise<void>,
    onSentence?: (data: unknown) => void | Promise<void>
  ): Promise<SynthesisResult>;

  export function recognize(
    input: string | Buffer | Uint8Array | RawAudio,
    options?: RecognitionOptions
  ): Promise<RecognitionResult>;
}

