import { spawn, type ChildProcess } from "node:child_process";
import { platform } from "node:os";

const SAMPLE_RATE = 24000;
const CHANNELS = 1;

function getPlayerCommand(): { cmd: string; args: string[] } {
  if (platform() === "darwin") {
    return {
      cmd: "play",
      args: [
        "-q",
        "-t", "raw",
        "-r", String(SAMPLE_RATE),
        "-e", "signed-integer",
        "-b", "16",
        "-c", String(CHANNELS),
        "-",
      ],
    };
  }
  return {
    cmd: "pw-play",
    args: [
      "--raw",
      "--rate", String(SAMPLE_RATE),
      "--channels", String(CHANNELS),
      "--format", "s16",
      "-",
    ],
  };
}

export type ChildProcessWithStdin = ReturnType<typeof spawn>;

/**
 * Запускает плеер (sox play на macOS, pw-play на Linux).
 * onStdinError вызывается при EPIPE, чтобы можно было пересоздать плеер.
 */
export function spawnPlayer(
  onStdinError?: (err: NodeJS.ErrnoException) => void,
): ChildProcessWithStdin {
  const { cmd, args } = getPlayerCommand();
  const proc = spawn(cmd, args, {
    stdio: ["pipe", "ignore", "pipe"],
  });

  proc.stderr?.on("data", (d: Buffer) => {
    const msg = d.toString().trim();
    if (msg) console.error(`${cmd} stderr:`, msg);
  });
  proc.on("error", (err: Error) => {
    console.error(`Player (${cmd}) error:`, err.message);
  });
  proc.stdin?.on("error", (err: NodeJS.ErrnoException) => {
    if (err?.code === "EPIPE") {
      onStdinError?.(err);
      return;
    }
    console.error(`Player (${cmd}) stdin error:`, err.message);
  });

  return proc;
}

/**
 * Генерирует буфер PCM для короткого тонового сигнала (бип).
 */
export function createBeepBuffer(durationMs: number, freqHz: number): Buffer {
  const samples = Math.max(1, Math.floor((SAMPLE_RATE * durationMs) / 1000));
  const arr = new Int16Array(samples);
  const amplitude = 0.25 * 0x7fff;
  for (let i = 0; i < samples; i++) {
    const t = i / SAMPLE_RATE;
    arr[i] = Math.round(amplitude * Math.sin(2 * Math.PI * freqHz * t));
  }
  return Buffer.from(arr.buffer);
}

/**
 * Проигрывает бип в отдельном процессе плеера.
 * onDone вызывается после окончания (по таймауту).
 */
export function playBeep(
  beepBuffer: Buffer,
  durationMs: number,
  onDone?: () => void,
): void {
  const proc = spawnPlayer();
  proc.stdin?.once("error", () => {});
  proc.stdin?.write(beepBuffer, () => {
    proc.stdin?.end();
  });
  proc.on("close", () => {
    onDone?.();
  });
  setTimeout(() => {
    onDone?.();
  }, durationMs + 100);
}
