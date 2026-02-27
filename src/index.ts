import {
  RealtimeAgent,
  RealtimeSession,
  type TransportLayerAudio,
} from "@openai/agents/realtime";
import { Porcupine } from "@picovoice/porcupine-node";
import record from "node-record-lpcm16";
import Speaker from "speaker";
import dotenv from "dotenv";

dotenv.config();


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
    const candidates = [
      preferredBuiltinWakeWord,
      "jarvis",
      "porcupine",
      "picovoice",
      "bumblebee",
      "grasshopper",
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        // Porcupine runtime validates supported builtin keywords.
        porcupine = new Porcupine(
          porcupineAccessKey,
          [candidate],
          [0.65],
        );
        activeWakeWordLabel = candidate;
        break;
      } catch {
        // try next builtin keyword
      }
    }
    if (!porcupine) {
      throw new Error(
        "No supported builtin wake-word found. Set PORCUPINE_KEYWORD_PATH to your .ppn file.",
      );
    }
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

  // 🎤 Микрофон
  const mic = record.record({
    sampleRate: 16000,
    channels: 1,
    audioType: "raw",
  });

  mic.stream().on("data", (chunk: Buffer) => {
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

  // 🔊 Аудио ответ
  const speaker = new Speaker({
    channels: 1,
    bitDepth: 16,
    sampleRate: 24000,
  });

  speaker.on("error", (err: any) => {
    if (err && err.code !== "EPIPE") {
      console.error("Speaker error:", err);
    }
  });

  const beepDurationMs = Number(process.env.BEEP_DURATION_MS ?? "150");
  const beepFreq = Number(process.env.BEEP_FREQ ?? "880");
  const beepBuffer = (() => {
    const sampleRate = 24000;
    const samples = Math.max(
      1,
      Math.floor((sampleRate * beepDurationMs) / 1000),
    );
    const arr = new Int16Array(samples);
    const amplitude = 0.25 * 0x7fff;
    for (let i = 0; i < samples; i++) {
      const t = i / sampleRate;
      arr[i] = Math.round(
        amplitude * Math.sin(2 * Math.PI * beepFreq * t),
      );
    }
    return Buffer.from(arr.buffer);
  })();

  const playBeep = () => {
    if (beepPlaying) return;
    beepPlaying = true;
    try {
      speaker.write(beepBuffer);
    } catch (err: any) {
      if (!err || err.code !== "EPIPE") {
        console.error("Beep write error:", err);
      }
    } finally {
      setTimeout(() => {
        beepPlaying = false;
      }, beepDurationMs + 50);
    }
  };

  session.on("audio", (event: TransportLayerAudio) => {
    assistantSpeaking = true;
    const audio = Buffer.from(new Uint8Array(event.data));
    try {
      speaker.write(audio);
    } catch (err: any) {
      if (!err || err.code !== "EPIPE") {
        console.error("Speaker write error:", err);
      }
    }
  });

  session.on("audio_stopped", () => {
    assistantSpeaking = false;
  });

  const shutdown = () => {
    mic.stop();
    porcupine.release();
    (speaker as any).end?.();
    session.close();
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  mic.start();
}

main();