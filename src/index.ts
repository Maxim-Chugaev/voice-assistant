import {
  RealtimeAgent,
  RealtimeSession,
  type TransportLayerAudio,
} from "@openai/agents/realtime";
import { Porcupine } from "@picovoice/porcupine-node";
import { spawn, type ChildProcess } from "node:child_process";
import { platform } from "node:os";
import type { Readable } from "node:stream";
import dotenv from "dotenv";

dotenv.config();

const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const INPUT_SAMPLE_RATE = 16000;

/** Нативный микрофон: spawn arecord (Linux) или sox (macOS), stdout = PCM s16le 16kHz mono */
function createNativeMic(): {
  stream: Readable;
  stop: () => void;
} {
  const isLinux = platform() === "linux";
  const device = process.env.AUDIO_DEVICE;

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
  cp.on("close", (code, signal) => {
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

/** Команда для воспроизведения raw PCM s16le: Linux = pw-play (raw), macOS = sox play */
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
      "-", // читать PCM из stdin
    ],
  };
}

function spawnPlayer(
  onStdinError?: (err: NodeJS.ErrnoException) => void,
): ReturnType<typeof spawn> {
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


async function main() {
  const porcupineAccessKey = process.env.PORCUPINE_ACCESS_KEY;
  const porcupineKeywordPath = process.env.PORCUPINE_KEYWORD_PATH;
  const preferredBuiltinWakeWord = (
    process.env.PORCUPINE_BUILTIN_KEYWORD ?? "jarvis"
  ).toLowerCase();
  const wakeWindowMs = Number(process.env.WAKE_WINDOW_MS ?? "8000");
  const gateSilenceMs = Number(process.env.GATE_SILENCE_MS ?? "1200");
  const minRms = Number(process.env.MIN_RMS ?? "200");
  const wakeDebounceMs = Number(process.env.WAKE_DEBOUNCE_MS ?? "1500");

  if (!porcupineAccessKey) {
    throw new Error("Set PORCUPINE_ACCESS_KEY in .env");
  }

  const agent = new RealtimeAgent({
    name: "Assistant",
    instructions: "Ты полезный голосовой ассистент. Отвечай коротко и по делу.",
  });

  const session = new RealtimeSession(agent, {
    model: "gpt-realtime",
    transport: "websocket",
    config: {
      outputModalities: ["audio"],
      audio: {
        input: {
          format: "pcm16",
          transcription: {
            model: "gpt-4o-mini-transcribe",
          },
          turnDetection: {
            type: "semantic_vad",
            eagerness: "medium",
            createResponse: true,
            interruptResponse: true,
          },
        },
        output: {
          format: "pcm16",
        },
      },
    },
  });

  await session.connect({
    apiKey: process.env.OPENAI_API_KEY!,
  });

  console.log("Connected. Say wake-word to activate…");

  let porcupine: any = null;
  let activeWakeWordLabel = "";

  if (porcupineKeywordPath) {
    porcupine = new Porcupine(
      porcupineAccessKey,
      [porcupineKeywordPath],
      [0.65],
    );
    activeWakeWordLabel = `custom(${porcupineKeywordPath})`;
  } else {
    const keyword = preferredBuiltinWakeWord || "jarvis";
    porcupine = new Porcupine(
      porcupineAccessKey,
      [keyword],
      [0.65],
    );
    activeWakeWordLabel = keyword;
  }
  console.log(`Wake-word active: ${activeWakeWordLabel}`);
  const frameLength = porcupine.frameLength;
  const frameBytes = frameLength * 2;

  let assistantSpeaking = false;
  let gateOpenUntil = 0;
  let lastSpeechAt = 0;
  let lastWakeDetectedAt = 0;
  let hasUserSpeechInGate = false;
  let beepPlaying = false;
  let wakeBuffer = Buffer.alloc(0);

  const isSpeechChunk = (pcm16: Buffer): boolean => {
    if (pcm16.length < 2) return false;
    let sum = 0;
    const samples = pcm16.length >> 1;
    for (let i = 0; i < pcm16.length; i += 2) {
      const s = pcm16.readInt16LE(i);
      sum += s * s;
    }
    const rms = Math.sqrt(sum / Math.max(samples, 1));
    return rms >= minRms;
  };

  // 🎤 Микрофон: нативный spawn arecord (Linux) / sox (macOS), без node-record-lpcm16
  const { stream: micStream, stop: stopMic } = createNativeMic();

  micStream.on("data", (chunk: Buffer) => {
    wakeBuffer = Buffer.concat([wakeBuffer, chunk]);
    while (wakeBuffer.length >= frameBytes) {
      const frame = wakeBuffer.subarray(0, frameBytes);
      wakeBuffer = wakeBuffer.subarray(frameBytes);

      const pcmFrame = new Int16Array(
        frame.buffer,
        frame.byteOffset,
        frameLength,
      );
      const keywordIndex = porcupine.process(pcmFrame);
      if (keywordIndex >= 0) {
        const now = Date.now();
        const inDebounce = now - lastWakeDetectedAt < wakeDebounceMs;
        const gateAlreadyOpen = now <= gateOpenUntil && !assistantSpeaking;
        if (inDebounce || gateAlreadyOpen) {
          continue;
        }
        lastWakeDetectedAt = now;

        if (assistantSpeaking) {
          (session as any).interrupt?.();
          assistantSpeaking = false;
        }
        gateOpenUntil = now + wakeWindowMs;
        hasUserSpeechInGate = false;
        lastSpeechAt = now;
        console.log("Wake word detected");
        playBeep();
      }
    }

    if (assistantSpeaking || beepPlaying) return;
    if (Date.now() > gateOpenUntil) return;

    const hasSpeech = isSpeechChunk(chunk);
    if (hasSpeech) {
      hasUserSpeechInGate = true;
      lastSpeechAt = Date.now();
    } else if (hasUserSpeechInGate && Date.now() - lastSpeechAt > gateSilenceMs) {
      gateOpenUntil = 0;
    }

    const ab = chunk.buffer.slice(
      chunk.byteOffset,
      chunk.byteOffset + chunk.byteLength,
    ) as ArrayBuffer;
    session.sendAudio(ab);
  });

  // 🔊 Аудио ответ через внешний плеер (pw-play на Linux, sox play на macOS)
  let player: ReturnType<typeof spawn> | null = spawnPlayer((err) => {
    if (err?.code === "EPIPE") player = null;
  });

  const beepDurationMs = Number(process.env.BEEP_DURATION_MS ?? "150");
  const beepFreq = Number(process.env.BEEP_FREQ ?? "880");
  const beepBuffer = (() => {
    const samples = Math.max(
      1,
      Math.floor((SAMPLE_RATE * beepDurationMs) / 1000),
    );
    const arr = new Int16Array(samples);
    const amplitude = 0.25 * 0x7fff;
    for (let i = 0; i < samples; i++) {
      const t = i / SAMPLE_RATE;
      arr[i] = Math.round(
        amplitude * Math.sin(2 * Math.PI * beepFreq * t),
      );
    }
    return Buffer.from(arr.buffer);
  })();

  const playBeep = () => {
    if (beepPlaying) return;
    beepPlaying = true;
    const beepProc = spawnPlayer();
    beepProc.stdin?.once("error", () => {});
    beepProc.stdin?.write(beepBuffer, () => {
      beepProc.stdin?.end();
    });
    beepProc.on("close", () => {
      beepPlaying = false;
    });
    setTimeout(() => {
      beepPlaying = false;
    }, beepDurationMs + 100);
  };

  session.on("audio", (event: TransportLayerAudio) => {
    assistantSpeaking = true;
    const chunk = Buffer.from(new Uint8Array(event.data));
    if (!player || player.killed || player.stdin?.destroyed) {
      player = spawnPlayer((err) => {
        if (err?.code === "EPIPE") player = null;
      });
    }
    if (player?.stdin?.writable) {
      try {
        player.stdin.write(chunk);
      } catch (err: any) {
        if (err?.code !== "EPIPE") console.error("Player write error:", err?.message);
        player = null;
      }
    }
  });

  session.on("audio_stopped", () => {
    assistantSpeaking = false;
    const currentPlayer = player;
    // Задержка: даём последним аудио-чанкам время записаться, затем end() для flush.
    // Одновременно создаём новый плеер, чтобы первый чанк следующего ответа пошёл без задержки spawn.
    setTimeout(() => {
      if (currentPlayer?.stdin && !currentPlayer.stdin.destroyed) {
        try {
          currentPlayer.stdin.end();
        } catch {
          // ignore
        }
      }
      if (player === currentPlayer) {
        player = spawnPlayer((err) => {
          if (err?.code === "EPIPE") player = null;
        });
      }
    }, 150);
  });

  const shutdown = () => {
    stopMic();
    porcupine.release();
    if (player && !player.killed) {
      player.kill();
    }
    session.close();
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main();