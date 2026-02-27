import { Porcupine } from "@picovoice/porcupine-node";
import record from "node-record-lpcm16";
import dotenv from "dotenv";

dotenv.config();

const accessKey = process.env.PORCUPINE_ACCESS_KEY!;

const porcupine = new Porcupine(accessKey, ["jarvis"], [0.6]);

const frameLength = porcupine.frameLength;
const frameBytes = frameLength * 2;

let buffer = Buffer.alloc(0);

const mic = record.record({
  sampleRate: 16000,
  channels: 1,
  audioType: "raw",
});

mic.stream().on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);

  while (buffer.length >= frameBytes) {
    const frame = buffer.subarray(0, frameBytes);
    buffer = buffer.subarray(frameBytes);

    const pcm = new Int16Array(
      frame.buffer,
      frame.byteOffset,
      frameLength,
    );

    const result = porcupine.process(pcm);
    if (result >= 0) {
      console.log("WAKE WORD DETECTED");
    }
  }
});

mic.start();

