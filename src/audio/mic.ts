import { spawn, type ChildProcess } from "node:child_process";
import { platform } from "node:os";
import type { Readable } from "node:stream";

const INPUT_SAMPLE_RATE = 16000;

/**
 * Starts mic capture via arecord (Linux) or sox (macOS).
 * Returns a raw PCM 16 kHz mono s16le stream and a stop function.
 */
export function createMic(options: { device?: string }): {
  stream: Readable;
  stop: () => void;
} {
  const isLinux = platform() === "linux";
  const device = options.device;

  const cmd = isLinux ? "arecord" : "sox";
  const args: string[] = isLinux
    ? [
        "-q",
        "-r", String(INPUT_SAMPLE_RATE),
        "-c", "1",
        "-t", "raw",
        "-f", "S16_LE",
        "-",
      ]
    : [
        "-d",
        "--no-show-progress",
        "--rate", String(INPUT_SAMPLE_RATE),
        "--channels", "1",
        "--encoding", "signed-integer",
        "--bits", "16",
        "--type", "raw",
        "-",
      ];

  if (isLinux && device) {
    args.unshift("-D", device);
  }

  const spawnOpts: { stdio: ("ignore" | "pipe")[]; env?: NodeJS.ProcessEnv } = {
    stdio: ["ignore", "pipe", "pipe"],
  };
  if (!isLinux && device) {
    spawnOpts.env = { ...process.env, AUDIODEV: device };
  }

  const cp: ChildProcess = spawn(cmd, args, spawnOpts);
  const stream = cp.stdout!;

  cp.stderr?.on("data", (d: Buffer) => {
    const msg = d.toString().trim();
    if (msg) console.error(`${cmd} stderr:`, msg);
  });
  cp.on("error", (err: Error) => {
    console.error(`Mic (${cmd}) spawn error:`, err.message);
  });
  cp.on("close", (code) => {
    if (code != null && code !== 0) {
      console.error(
        `Mic (${cmd}) exited with code ${code}. Tip: run \`arecord -l\` and set AUDIO_DEVICE (e.g. plughw:1,0) if needed.`,
      );
    }
  });

  return {
    stream,
    stop: () => {
      if (cp.pid != null) cp.kill();
    },
  };
}

export { INPUT_SAMPLE_RATE };
