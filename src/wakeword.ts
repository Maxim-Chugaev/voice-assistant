import { Porcupine } from "@picovoice/porcupine-node";

export type WakeWordEngine = {
  process: (pcmFrame: Int16Array) => number;
  release: () => void;
  frameLength: number;
  frameBytes: number;
};

function wrapPorcupine(porcupine: InstanceType<typeof Porcupine>): WakeWordEngine {
  return {
    process: (pcm) => porcupine.process(pcm),
    release: () => porcupine.release(),
    frameLength: porcupine.frameLength,
    frameBytes: porcupine.frameLength * 2,
  };
}

/**
 * Инициализирует Porcupine: либо по пути к .ppn, либо встроенное слово (jarvis и т.д.).
 */
export function initWakeWord(
  accessKey: string,
  keywordPath: string | undefined,
  builtinKeyword: string,
): { engine: WakeWordEngine; label: string } {
  if (keywordPath) {
    const porcupine = new Porcupine(accessKey, [keywordPath], [0.65]);
    return {
      engine: wrapPorcupine(porcupine),
      label: `custom(${keywordPath})`,
    };
  }
  const keyword = builtinKeyword || "jarvis";
  const porcupine = new Porcupine(accessKey, [keyword], [0.65]);
  return {
    engine: wrapPorcupine(porcupine),
    label: keyword,
  };
}
