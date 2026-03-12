import { spawn, type ChildProcess } from "node:child_process";
import { platform } from "node:os";

const SAMPLE_RATE = 24000;
const CHANNELS = 1;

function getPlayerCommand(outputDevice?: string): { cmd: string; args: string[] } {
  if (platform() === "darwin") {
    if (outputDevice?.trim()) {
      return {
        cmd: "sox",
        args: [
          "-q",
          "-t", "raw",
          "-r", String(SAMPLE_RATE),
          "-e", "signed-integer",
          "-b", "16",
          "-c", String(CHANNELS),
          "-",
          "-t", "coreaudio",
          outputDevice.trim(),
        ],
      };
    }
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
  const pwArgs = [
    "--raw",
    "--rate", String(SAMPLE_RATE),
    "--channels", String(CHANNELS),
    "--format", "s16",
    "-",
  ];
  if (outputDevice?.trim()) {
    pwArgs.unshift("--target", outputDevice.trim());
  }
  return {
    cmd: "pw-play",
    args: pwArgs,
  };
}

export type ChildProcessWithStdin = ReturnType<typeof spawn>;

/**
 * Starts an external player (sox play on macOS, pw-play on Linux).
 * outputDevice: macOS — CoreAudio device name, Linux — pw-play target (see pw-play --list-targets).
 * onStdinError is called on EPIPE so the caller can recreate the player.
 */
export function spawnPlayer(
  onStdinError?: (err: NodeJS.ErrnoException) => void,
  outputDevice?: string,
): ChildProcessWithStdin {
  const { cmd, args } = getPlayerCommand(outputDevice);
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
 * Generates a PCM buffer for a short tone (beep).
 */
export function createBeepBuffer(durationMs: number, freqHz: number): Buffer {
  const samples = Math.max(1, Math.floor((SAMPLE_RATE * durationMs) / 1000));
  const arr = new Int16Array(samples);
  const amplitude = 0.8 * 0x7fff;
  for (let i = 0; i < samples; i++) {
    const t = i / SAMPLE_RATE;
    arr[i] = Math.round(amplitude * Math.sin(2 * Math.PI * freqHz * t));
  }
  return Buffer.from(arr.buffer);
}

/**
 * Plays a beep in a separate player process.
 * onDone is called when playback is finished (or after a timeout).
 */
export function playBeep(
  beepBuffer: Buffer,
  durationMs: number,
  onDone?: () => void,
  outputDevice?: string,
): void {
  const proc = spawnPlayer(undefined, outputDevice);
  let called = false;
  const finish = () => {
    if (called) return;
    called = true;
    onDone?.();
  };
  proc.stdin?.once("error", () => {});
  proc.stdin?.write(beepBuffer, () => {
    proc.stdin?.end();
  });
  proc.on("close", finish);
  setTimeout(finish, durationMs + 100);
}
