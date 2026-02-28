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

/** Порог RMS: выше — считаем, что в чанке есть речь (простой VAD) */
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

  const { stream: micStream, stop: stopMic } = createMic({
    device: config.audioDevice,
  });

  const beepBuffer = createBeepBuffer(beepDurationMs, beepFreqHz);
  const playBeep = () => {
    if (beepPlaying) return;
    beepPlaying = true;
    playBeepSound(beepBuffer, beepDurationMs, () => {
      beepPlaying = false;
    });
  };

  let player: ChildProcessWithStdin | null = spawnPlayer((err) => {
    if (err?.code === "EPIPE") player = null;
  });

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
      const keywordIndex = wakeEngine.process(pcmFrame);

      if (keywordIndex >= 0) {
        const now = Date.now();
        if (now - lastWakeAt < debounceMs) continue;
        if (now <= gateOpenUntil && !assistantSpeaking) continue;

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

    if (assistantSpeaking || beepPlaying) return;
    if (Date.now() > gateOpenUntil) return;

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
  });

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
      } catch (err: unknown) {
        const e = err as { code?: string; message?: string };
        if (e?.code !== "EPIPE") console.error("Player write error:", e?.message);
        player = null;
      }
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
    const current = player;
    setTimeout(() => {
      if (current?.stdin && !current.stdin.destroyed) {
        try {
          current.stdin.end();
        } catch {
          // ignore
        }
      }
      if (player === current) {
        player = spawnPlayer((err) => {
          if (err?.code === "EPIPE") player = null;
        });
      }
    }, 150);
  });

  const shutdown = () => {
    stopMic();
    wakeEngine.release();
    if (player && !player.killed) player.kill();
    session.close();
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main();
