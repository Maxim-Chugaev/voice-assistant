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

  const beepBuffer = createBeepBuffer(beepDurationMs, beepFreqHz);
  const outputDevice = config.audioOutputDevice ?? undefined;

  let player: ChildProcessWithStdin | null = spawnPlayer((err) => {
    if (err?.code === "EPIPE") player = null;
  }, outputDevice);

  const playBeep = () => {
    if (beepPlaying) return;
    beepPlaying = true;
    console.log("playBeep(): called");

    const done = () => {
      beepPlaying = false;
      console.log("playBeep(): done");
    };

    if (player?.stdin?.writable) {
      try {
        console.log("playBeep(): writing to existing player stdin");
        player.stdin.write(beepBuffer, done);
        return;
      } catch {
        console.log("playBeep(): error writing to existing player, falling back");
        player = null;
      }
    }

    console.log("playBeep(): spawning dedicated player");
    playBeepSound(beepBuffer, beepDurationMs, done, outputDevice);
  };

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
        if (now - lastWakeAt < debounceMs) continue;
        if (now <= gateOpenUntil && !assistantSpeaking) continue;

        lastWakeAt = now;
        if (assistantSpeaking) {
          (session as { interrupt?: () => void }).interrupt?.();
          assistantSpeaking = false;
        }

        // Сначала только сигнал «услышал»…
        console.log("Wake word detected");
        playBeep();

        // …а окно для речи открываем уже ПОСЛЕ бипа.
        setTimeout(() => {
          const start = Date.now();
          gateOpenUntil = start + windowMs;
          hasUserSpeechInGate = false;
          lastSpeechAt = start;
          console.log("Gate opened after beep");
        }, beepDurationMs + 50);
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

  // Двойной бип при старте, чтобы прогреть вывод и дать понятный сигнал
  setTimeout(() => {
    playBeep();
    setTimeout(() => {
      playBeep();
    }, beepDurationMs + 150);
  }, 500);

  session.on("audio", (event: TransportLayerAudio) => {
    assistantSpeaking = true;
    const chunk = Buffer.from(new Uint8Array(event.data));
    if (!player || player.killed || player.stdin?.destroyed) {
      player = spawnPlayer((err) => {
        if (err?.code === "EPIPE") player = null;
      }, outputDevice);
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
        }, outputDevice);
      }
    }, 150);
  });

  const shutdown = () => {
    if (micReconnectTimeout != null) clearTimeout(micReconnectTimeout);
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
