import {
  RealtimeAgent,
  RealtimeSession,
  type TransportLayerAudio,
} from "@openai/agents/realtime";
import { config, requireEnv } from "./config.js";
import { createMic } from "./audio/mic.js";
import {
  spawnPlayer,
  createBeepBuffer,
  playBeep as playBeepSound,
  type ChildProcessWithStdin,
} from "./audio/player.js";
import { initWakeWord } from "./wakeword.js";

/** Simple RMS‑based VAD: above threshold = treat chunk as speech. */
function hasSpeechInChunk(pcm: Buffer, minRms: number): boolean {
  if (pcm.length < 2) return false;
  let sum = 0;
  const samples = pcm.length >> 1;
  for (let i = 0; i < pcm.length; i += 2) {
    const s = pcm.readInt16LE(i);
    sum += s * s;
  }
  const rms = Math.sqrt(sum / Math.max(samples, 1));
  return rms >= minRms;
}

async function main() {
  const openaiKey = requireEnv("OPENAI_API_KEY", config.openai.apiKey);
  const porcupineKey = requireEnv("PORCUPINE_ACCESS_KEY", config.porcupine.accessKey);

  const agent = new RealtimeAgent({
    name: "Assistant",
    instructions: "You are a helpful voice assistant. Answer briefly and to the point.",
  });

  const session = new RealtimeSession(agent, {
    model: "gpt-realtime",
    transport: "websocket",
    config: {
      outputModalities: ["audio"],
      audio: {
        input: {
          format: "pcm16",
          transcription: { model: "gpt-4o-mini-transcribe" },
          turnDetection: {
            type: "semantic_vad",
            eagerness: "medium",
            createResponse: true,
            interruptResponse: true,
          },
        },
        output: { format: "pcm16" },
      },
    },
  });

  await session.connect({ apiKey: openaiKey });
  console.log("Connected. Say wake-word to activate…");

  const { engine: wakeEngine, label: wakeLabel } = initWakeWord(
    porcupineKey,
    config.porcupine.keywordPath,
    config.porcupine.builtinKeyword,
    config.porcupine.sensitivity,
  );
  console.log(`Wake-word active: ${wakeLabel}`);

  const frameBytes = wakeEngine.frameBytes;
  const frameLength = wakeEngine.frameLength;

  const { windowMs, silenceMs, minRms, debounceMs } = config.gate;
  const { durationMs: beepDurationMs, freqHz: beepFreqHz } = config.beep;

  let assistantSpeaking = false;
  let gateOpenUntil = 0;
  let lastSpeechAt = 0;
  let lastWakeAt = 0;
  let hasUserSpeechInGate = false;
  let beepPlaying = false;
  let wakeBuffer = Buffer.alloc(0);

  const beepBuffer = createBeepBuffer(beepDurationMs, beepFreqHz);
  const outputDevice = config.audioOutputDevice ?? undefined;
  const silenceBuffer = Buffer.alloc(
    Math.floor((config.audio.outputSampleRate * config.audio.channels * 2 * 50) / 1000),
  ); // 50 ms — smaller buffer, beep closer to wake word

  let player: ChildProcessWithStdin | null = spawnPlayer((err) => {
    if (err?.code === "EPIPE") player = null;
  }, outputDevice);

  const AUDIO_QUEUE_MAX = 200;
  const audioChunkQueue: Buffer[] = [];
  let drainScheduled = false;
  const flushAudioQueue = () => {
    if (!player?.stdin?.writable || audioChunkQueue.length === 0) return;
    while (audioChunkQueue.length > 0) {
      const ok = player.stdin.write(audioChunkQueue[0]);
      audioChunkQueue.shift();
      if (!ok) {
        if (!drainScheduled) {
          drainScheduled = true;
          player.stdin.once("drain", () => {
            drainScheduled = false;
            flushAudioQueue();
          });
        }
        return;
      }
    }
  };

  const playBeep = () => {
    if (beepPlaying) return;
    beepPlaying = true;
    const done = () => {
      beepPlaying = false;
    };
    if (!player || player.killed || !player.stdin || player.stdin.destroyed) {
      playBeepSound(beepBuffer, beepDurationMs, done, outputDevice);
      return;
    }
    try {
      player.stdin.write(beepBuffer, done);
    } catch {
      done();
      player = null;
    }
  };

  let silenceInterval: ReturnType<typeof setInterval> | null = null;
  let lastAudioStoppedAt = 0;
  const SILENCE_PAUSE_MS = 450;
  const startSilenceLoop = () => {
    if (silenceInterval != null) return;
    silenceInterval = setInterval(() => {
      if (!player || player.killed || !player.stdin || player.stdin.destroyed) return;
      if (assistantSpeaking || beepPlaying) return;
      if (Date.now() - lastAudioStoppedAt < SILENCE_PAUSE_MS) return;
      try {
        player.stdin.write(silenceBuffer);
      } catch {
        player = null;
      }
    }, 120);
  };
  startSilenceLoop();

  let stopMicRef: () => void = () => {};
  let micReconnectTimeout: ReturnType<typeof setTimeout> | null = null;

  function onMicData(chunk: Buffer) {
    wakeBuffer = Buffer.concat([wakeBuffer, chunk]);
    while (wakeBuffer.length >= frameBytes) {
      const frame = wakeBuffer.subarray(0, frameBytes);
      wakeBuffer = wakeBuffer.subarray(frameBytes);
      const pcmFrame = new Int16Array(
        frame.buffer,
        frame.byteOffset,
        frameLength,
      );
      const keywordIndex = wakeEngine.process(pcmFrame);

      if (keywordIndex >= 0) {
        const now = Date.now();
        if (now - lastWakeAt < debounceMs) break;
        if (now <= gateOpenUntil && !assistantSpeaking) break;

        lastWakeAt = now;
        if (assistantSpeaking) {
          (session as { interrupt?: () => void }).interrupt?.();
          assistantSpeaking = false;
        }

        gateOpenUntil = now + windowMs;
        hasUserSpeechInGate = false;
        lastSpeechAt = now;
        console.log("Wake word detected");
        playBeep();
      }
    }

    if (assistantSpeaking) return;
    if (!gateOpenUntil || Date.now() > gateOpenUntil) return;

    if (hasSpeechInChunk(chunk, minRms)) {
      hasUserSpeechInGate = true;
      lastSpeechAt = Date.now();
    } else if (hasUserSpeechInGate && Date.now() - lastSpeechAt > silenceMs) {
      gateOpenUntil = 0;
    }

    const ab = chunk.buffer.slice(
      chunk.byteOffset,
      chunk.byteOffset + chunk.byteLength,
    ) as ArrayBuffer;
    session.sendAudio(ab);
  }

  function startMic() {
    const { stream, stop } = createMic({ device: config.audioDevice });
    stopMicRef = stop;
    stream.on("data", onMicData);
    stream.on("end", () => {
      console.error("Mic stream ended, reconnecting in 2s…");
      micReconnectTimeout = setTimeout(startMic, 2000);
    });
    stream.on("error", () => {
      micReconnectTimeout = setTimeout(startMic, 2000);
    });
  }
  startMic();

  session.on("audio", (event: TransportLayerAudio) => {
    assistantSpeaking = true;
    const chunk = Buffer.from(new Uint8Array(event.data));
    if (!player || player.killed || player.stdin?.destroyed) {
      player = spawnPlayer((err) => {
        if (err?.code === "EPIPE") player = null;
      }, outputDevice);
      audioChunkQueue.length = 0;
      drainScheduled = false;
    }
    if (!player?.stdin?.writable) return;
    try {
      if (audioChunkQueue.length < AUDIO_QUEUE_MAX) {
        audioChunkQueue.push(chunk);
      }
      flushAudioQueue();
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string };
      if (e?.code !== "EPIPE") console.error("Player write error:", e?.message);
      player = null;
    }
  });

  session.on("transport_event", (evt: { type?: string; transcript?: string }) => {
    if (
      evt?.type === "conversation.item.input_audio_transcription.completed" &&
      typeof evt.transcript === "string"
    ) {
      console.log(`User transcript: ${evt.transcript}`);
    }
  });

  session.on("audio_stopped", () => {
    assistantSpeaking = false;
    lastAudioStoppedAt = Date.now();
  });

  session.on("error", (evt: unknown) => {
    const e = evt as {
      error?: {
        error?: { code?: string; message?: string };
        code?: string;
        message?: string;
      };
    };
    const code = e?.error?.error?.code ?? e?.error?.code;
    const message = e?.error?.error?.message ?? e?.error?.message;
    if (code === "session_expired") {
      console.error(
        "Realtime session expired (60 min), exiting so supervisor (systemd/loop) can restart.",
        message,
      );
      shutdown();
      return;
    }
    console.error("Realtime session error:", code ?? "", message ?? "");
  });

  const shutdown = () => {
    if (micReconnectTimeout != null) clearTimeout(micReconnectTimeout);
    if (silenceInterval != null) clearInterval(silenceInterval);
    stopMicRef();
    wakeEngine.release();
    if (player && !player.killed) player.kill();
    session.close();
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main();
