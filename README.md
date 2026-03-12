## Voice assistant (OpenAI Realtime + Porcupine)

Node.js/TypeScript voice assistant built on **OpenAI Realtime API**: speech‑in, chat, and TTS all happen inside a single realtime session. Wake‑word detection is fully local via **Picovoice Porcupine**.

### Features

- **Local wake word**: by default `jarvis` (or any supported builtin keyword, or your own `.ppn` file).
- **Gate window**: after the wake word, mic audio is streamed to Realtime API only inside a fixed‑length window.
- **Local VAD (RMS)**: inside the window we drop silence/noise and can close the window early after `GATE_SILENCE_MS` ms of silence.
- **Automatic end‑of‑utterance**: OpenAI side uses `semantic_vad + createResponse`, so the model decides when you finished speaking.
- **Barge‑in**: saying the wake word while the assistant is speaking interrupts the current answer and starts a new turn.
- **Self‑protection from self‑hearing**: while the assistant is speaking, mic audio is not streamed to Realtime API.

## Requirements

- **Node.js** 18+
- **OpenAI API key** — for Realtime API (`gpt-realtime`).
- **Picovoice Porcupine AccessKey** — for local wake‑word detection.
- **Audio output** (one of):
  - **Linux**: PipeWire — `pw-play` (normally present if you use PipeWire).
  - **macOS**: SoX — `brew install sox` (command `play`).

## Setup

```bash
cd voice-assistant
yarn install
cp .env.example .env
# Then edit .env and set:
# - OPENAI_API_KEY=sk-...
# - PORCUPINE_ACCESS_KEY=...
```

## Running

Build and run:

```bash
yarn build
yarn start
```

Or quick dev run (rebuild + run):

```bash
yarn dev
```

## How it works

1. On startup we create a `RealtimeAgent` and `RealtimeSession` with model `gpt-realtime` and config:
   - `audio.input.format = "pcm16"`
   - `audio.input.transcription.model = "gpt-4o-mini-transcribe"`
   - `audio.input.turnDetection = semantic_vad + createResponse`
   - `audio.output.format = "pcm16"` (24 kHz)
2. The mic reads **16 kHz mono PCM16** via `node-record-lpcm16`.
3. Audio is fed into Porcupine locally. When the wake word is detected:
   - a gate window is opened for `WAKE_WINDOW_MS` ms;
   - we remember the time of the last detected speech.
4. While the window is open:
   - all chunks from the mic are streamed via `session.sendAudio(...)`;
   - a simple RMS‑based VAD (`MIN_RMS`) tracks speech presence and can close the window early after `GATE_SILENCE_MS` ms of silence.
5. The Realtime model itself detects end‑of‑utterance (`semantic_vad`) and starts speaking.
6. `session.on("audio")` yields PCM chunks that are piped to an external player: on Linux — `pw-play`, on macOS — `sox play` (24 kHz, mono, s16le).

## Usage

1. Start the assistant (`yarn start` or `yarn dev`).
2. In the console you should see:
   - `Connected. Say wake-word to activate…`
   - `Wake-word active: jarvis` (or your keyword).
3. Clearly say the wake word (for example **"jarvis"**), wait for `Wake word detected` in logs (and/or a beep).
4. Immediately after the wake word say your command, e.g.:
   - “what’s the weather today”
   - “what can you do”
   - “tell me a joke”
5. The assistant will transcribe your utterance and respond with synthesized speech.
6. To interrupt the current answer and start a new one, say the wake word again.

## Environment variables (.env)

See `.env.example` for the full list. Short summary:

| Variable | Description |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI API key (required). |
| `PORCUPINE_ACCESS_KEY` | Picovoice AccessKey (required for wake word). |
| `PORCUPINE_BUILTIN_KEYWORD` | Built‑in wake word (default `jarvis`). If not supported on your platform, the code will pick another supported keyword. |
| `PORCUPINE_KEYWORD_PATH` | Path to a custom `.ppn` file (takes priority over builtin). |
| `WAKE_WINDOW_MS` | How many ms after wake word to stream mic audio into Realtime API (default 8000). |
| `GATE_SILENCE_MS` | Close the window if there is no speech for this many ms (default 1200). |
| `MIN_RMS` | RMS threshold for local VAD (default 200). Lower = more sensitive to quiet speech. |
| `WAKE_DEBOUNCE_MS` | Debounce interval for wake word (default 1500 ms). |
| `AUDIO_DEVICE` | Input device (mic). Linux: ALSA device for `arecord -D`. macOS: device via `AUDIODEV`. |
| `AUDIO_OUTPUT_DEVICE` | Output device (speakers). **Linux**: `pw-play` target (node id or name). Get it via `wpctl status` or `pw-cli list-objects Node` (see Sinks). Default is system output (often Bluetooth). On macOS leave unset. |

## Troubleshooting

- **Wake word is not always detected**:
  - slightly decrease `MIN_RMS` (e.g. to `150`);
  - speak the wake word a bit louder and closer to the mic;
  - optionally reduce `WAKE_DEBOUNCE_MS` if you intentionally trigger wake word frequently.

- **Sometimes there is no answer**:
  - make sure that after `Wake word detected` you actually speak within the window (`WAKE_WINDOW_MS`);
  - verify that `OPENAI_API_KEY` is valid and has access to `gpt-realtime`.

- **No sound / playback errors**:
  - Linux: ensure PipeWire is installed and `pw-play` is in `PATH`;
  - macOS: install SoX — `brew install sox` (needs the `play` command).

- **On Linux sound goes to a Bluetooth speaker but you want wired USB speakers (e.g. Edifier)**:
  - List output devices: run **`wpctl status`** (or `pw-cli list-objects Node`). In **Audio → Sinks** find your USB output (Edifier / USB Audio) and note its **id** (number) or **node name**.
  - In `.env` set `AUDIO_OUTPUT_DEVICE` to that id or name, e.g. `AUDIO_OUTPUT_DEVICE=42` or `AUDIO_OUTPUT_DEVICE=alsa_output.usb-0bda_4014-00.analog-stereo`.
  - Restart the assistant — audio will go to the selected sink.

- **On Raspberry Pi mic suddenly stops working after reboot**:
  - ALSA card indices can change between boots. Run `arecord -l` and check which **card/device** is your mic (e.g. `card 3: USB PnP Audio Device, device 0`).
  - Update `.env` accordingly, e.g. `AUDIO_DEVICE=plughw:3,0` (card 3, device 0).
  - Restart the assistant (systemd user service or `yarn start`).

- **On Raspberry Pi with USB speakers the beep / beginning of the answer is sometimes cut off**:
  - This is usually due to the USB audio sink and PipeWire suspending/rewiring the stream. You can reduce this by creating `~/.config/pipewire/pipewire.conf.d/10-no-suspend.conf` and disabling suspend:
    - Set `session.suspend-timeout-seconds = 0` to prevent auto‑suspend.
    - Optionally add a `context.rules` block for your sink `node.name` (from `wpctl status` / `pw-cli`) and set a reasonable `node.latency` (e.g. `256/24000`).
  - Reboot the Pi so PipeWire picks up the new config.

- **Process exits with `session_expired` after ~60 minutes**:
  - Realtime sessions are limited to 60 minutes by the API. This project listens for `session_expired` and exits cleanly so a supervisor can restart it.
  - On Raspberry Pi, configure your `voice-assistant.service` (user unit) with `Restart=always` and `RestartSec=5`, run `systemctl --user daemon-reload` and then `systemctl --user restart voice-assistant`.
  - On macOS or when running manually, you can wrap `node dist/index.js` in a simple `while true; do ...; sleep 5; done` shell loop to auto‑restart.

## Project structure

- `src/index.ts` — main assistant: Porcupine, wake word, gate window, local VAD, `RealtimeSession`, audio output.
- `src/audio-test.ts` — minimal Porcupine/wake‑word test without OpenAI.
- `src/types/external-modules.d.ts` — type declarations for modules without types (`node-record-lpcm16`, `@picovoice/porcupine-node`).

## License

MIT
