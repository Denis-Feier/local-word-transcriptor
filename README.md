# Live Transcriber (Romanian)

Put the laptop on the table, press Start, and get Romanian text live as people talk.
Everything runs locally on the Mac. No API keys, no accounts, and no audio leaves the machine.

## Quick start

```bash
npm install
npm run setup              # downloads the voice detector and the default model (Canary 1B v2, 1.1 GB)
npm start                  # or: PORT=3421 npm start
```

Optional: `brew install whisper-cpp` to use the Whisper models, and `npm run setup -- --all` to download every model (about 7 GB) so all of them work offline.

Open **http://localhost:3000**, press **Start**, and allow the microphone.

- Grey text with a cursor is the live guess while someone speaks.
- After a short pause (~0.7 s) the sentence is transcribed again in full and turns final.
- Final lines are saved as you go to `transcripts/<date-time>.txt`. **Clear** starts a new file.

## Models

Pick a model from the **Model** menu. Models that aren't downloaded yet show their download size; choosing one downloads it with progress and switches to it when ready. The choice is remembered across restarts.

| Model | Romanian WER, published¹ | WER on test clips² | Speed² | On disk | Runs on |
|---|---|---|---|---|---|
| **NVIDIA Canary 1B v2** (default) | **6.6 %** | 2.4–2.7 % | 48–59× | 1.1 GB | GPU, transcribe.cpp |
| Whisper large-v3 | 8.2 % | 0–3.6 % | 6–10× | 1.1 GB | GPU, whisper.cpp |
| Whisper large-v3 turbo | 8–11 % | 0–2.7 % | 11–24× | 874 MB | GPU, whisper.cpp |
| Whisper large-v3 Romanian (BuzzASR)³ | 9.8 % | 0–2.7 % | 6–9× | 1.7 GB | GPU, whisper.cpp |
| Orukeet 0.6B | 9.3 % | 3.6–5.4 % | 93–111× | 740 MB | GPU, transcribe.cpp |
| Parakeet Ultra 0.6B | 9–10 % | 3.6–8.1 % | 96–111× | 740 MB | GPU, transcribe.cpp |
| Parakeet Romanian 110M (Politehnica)⁴ | 10.6 % | 0–5.4 % | 236–279× | 135 MB | GPU, transcribe.cpp |
| Whisper small Romanian (readerbench)³ | 10.9 % | 4.8–10.8 % | 30–39× | 260 MB | GPU, whisper.cpp |
| NVIDIA Parakeet TDT 0.6B v3 | 12.4 % | 3.6–18.9 % | 40–53× | 487 MB | CPU, sherpa-onnx |

¹ FLEURS Romanian (read, close-mic speech). Canary, Whisper large-v3 and Parakeet v3: NVIDIA's paper (arXiv 2509.14128, Table 11); the others: their authors or the Handy benchmarks. Lower is better. A room with several speakers will score worse for every model.
² Measured on this M5 with `npm run compare` on three synthetic Romanian clips (~100 words; differences of one word are noise). Speed = seconds of audio per second of compute; all are fast enough for live use.
³ Hugging Face Whisper fine-tunes with no ready-made whisper.cpp version. The app downloads the original weights, converts them to whisper.cpp's format with `lib/convert-whisper.js` (a JavaScript port of whisper.cpp's converter, no Python needed), quantizes them to q8_0 with `whisper-quantize`, and keeps only the result. BuzzASR downloads 3.1 GB, readerbench 967 MB. The readerbench model runs without the previous-text context, which made it invent words.
⁴ Outputs lowercase text without punctuation (that is how it was trained), but its words are very accurate and it is by far the fastest.

### Where models come from and where they live

Everything is stored in the project's `models/` folder (ignored by git; about 7 GB with all nine models). Files are downloaded from public links, with no account or token:

| Model | Source | Stored as |
|---|---|---|
| Canary 1B v2 | Hugging Face `handy-computer/canary-1b-v2-gguf` | `models/canary-1b-v2-Q8_0.gguf` |
| Whisper large-v3 turbo / large-v3 | Hugging Face `ggerganov/whisper.cpp` | `models/ggml-large-v3-turbo-q8_0.bin`, `models/ggml-large-v3-q5_0.bin` |
| Whisper large-v3 Romanian | Hugging Face `BuzzASR/romanian`, converted | `models/ggml-large-v3-ro-buzzasr-q8_0.bin` |
| Whisper small Romanian | Hugging Face `readerbench/whisper-ro`, converted | `models/ggml-small-ro-readerbench-q8_0.bin` |
| Orukeet | Hugging Face `oruk/orukeet` | `models/orukeet-transcribe-cpp-Q8_0.gguf` |
| Parakeet Ultra | Hugging Face `handy-computer/parakeet-ultra-gguf` | `models/parakeet-ultra-Q8_0.gguf` |
| Parakeet Romanian 110M | Hugging Face `jonah1024/Sped_ParakeetRomanian_110M_TDT-CTC_gguf` | `models/Sped_ParakeetRomanian_110M_TDT-CTC-Q8_0.gguf` |
| Parakeet TDT v3 | GitHub release of `k2-fsa/sherpa-onnx` | `models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/` |
| Silero voice detector | GitHub release of `k2-fsa/sherpa-onnx` | `models/silero_vad.onnx` |

Each model is downloaded once and then used from disk; nothing is fetched while transcribing, so the app works offline. To remove a model, delete its file or folder; the menu then offers it for download again. Download from the command line with `npm run setup -- <id>`, all at once with `npm run setup -- --all`, and see the list with `npm run setup -- --list`.

Licenses: Whisper, BuzzASR: MIT. readerbench, Parakeet Romanian 110M: Apache-2.0. Canary, Parakeet v3, Parakeet Ultra: CC-BY-4.0. Orukeet: CC-BY-SA-4.0. All allow commercial use.

Not included, as of October 2026:
- **Meta Seamless M4T v2** (8.9 %): only available as PyTorch weights (~9 GB), so it would need a Python runtime; non-commercial license; less accurate than Canary.
- **Cloud services** such as ElevenLabs Scribe (claims ~3 %): need an API key and send the audio off the machine.
- **Qwen3-ASR** (20–44 %) and **NVIDIA Nemotron streaming** (26–32 %): much worse on Romanian. **Meta Omnilingual**: its strong variant is a 7B model with no Mac runtime.
- **Voxtral, Phi-4, Granite Speech, Kyutai, Cohere Transcribe**: no Romanian.

## Comparing models on your own audio

Published benchmarks are read speech recorded close to the mic. The only reliable test is your room, your voices, your vocabulary:

1. Tick **Save audio** in the page and record a real conversation (10–30 min is plenty). The audio is saved as `transcripts/<date-time>.wav`.
2. Run every downloaded model over exactly the same utterances:
   ```bash
   npm run compare -- transcripts/2026-10-29_21-00-43.wav
   ```
3. Optional but best: correct one transcript by hand, save it as `reference.txt`, and get word error rates:
   ```bash
   npm run compare -- transcripts/2026-10-29_21-00-43.wav --ref reference.txt
   ```

The report (speed, WER, and every model's full transcript) is written to `transcripts/<name>.compare.md`.

## Tips for a room with several speakers

- **Put the laptop in the middle** of the group, screen up. The built-in mics face the keyboard area.
- **An external USB conference or boundary mic** helps the most for people at the far end of the table. Pick it under **Microphone**.
- **Noise suppression** is off by default because the browser's filter can swallow quiet, distant voices. Turn it on if there is steady background noise (air conditioning, traffic).
- The page keeps the screen awake while recording. If the server restarts mid-meeting, the page keeps recording and sends the buffered audio (up to 5 minutes) once it reconnects.
- Overlapping speech (two people at once) is transcribed as one mixed sentence. Turn-taking works best.

## How it works

```
Browser                       Node (server.js)                            Speech model
mic → AudioWorklet ──WS──▶  Silero VAD + Segmenter               ──▶   whisper-server (whisper.cpp, GPU)
      16 kHz Float32        ├─ while speaking: live guess              transcribe.cpp (GPU, in-process)
                            └─ on pause: final + save                  sherpa-onnx (CPU, in-process)
      transcript UI ◀──WS── text cleanup (diacritics, hallucination filter)
```

| File | Role |
|---|---|
| `public/pcm-worklet.js` | Captures the mic, downsamples to 16 kHz mono, sends 100 ms chunks |
| `public/app.js` | UI: models, mic, live and final lines, wake lock, reconnect buffering |
| `server.js` | Static files, WebSocket, model downloads and switching |
| `lib/vad.js` | Speech detectors: Silero (neural, default) and a loudness fallback |
| `lib/segmenter.js` | Turns detector frames into utterances: pre-roll, pause timeout, splits monologues longer than 20 s at the quietest point |
| `lib/session.js` | One browser tab: schedules live guesses and finals, writes transcript/audio files |
| `lib/transcriber.js` | Owns the active model, serialises requests, switches models, restarts a crashed model |
| `lib/engines/*.js` | One adapter per runtime: whisper.cpp, transcribe.cpp, sherpa-onnx |
| `lib/models.js` | Model catalogue, download and unpack |
| `lib/text.js` | Fixes ş/ţ → ș/ț, removes `[Muzică]` tags, drops Whisper's known silence hallucinations ("Mulțumim pentru vizionare!") |
| `scripts/compare.js` | Runs several models over a recording and reports speed and WER |

Live guesses refresh every 0.5 s, or less often for slow models (twice the model's average inference time), so they never delay the final text.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Web UI port |
| `MODEL` | last used, else `canary-1b-v2` | Start with this model |
| `LANGUAGE` | `ro` | Language code passed to models that take one |
| `VAD` | `silero` | `energy` switches to the simple loudness detector |
| `VAD_THRESHOLD` | `0.5` | Silero speech threshold. Lower (e.g. `0.35`) to catch quieter, farther voices |
| `VAD_SILENCE_MS` | `700` | Pause that ends a sentence. Raise (e.g. `1000`) if sentences get cut while people think |
| `VAD_MAX_SEGMENT_SEC` | `20` | Longest utterance before a forced split |
| `PARTIAL_EVERY_SEC` | `0.5` | Fastest refresh of the live guess |
| `INITIAL_PROMPT` | empty | Whisper only: names or jargon to prime the first sentence, e.g. `INITIAL_PROMPT="Ședința cu Andrei și Mihaela despre Kubernetes."` Later sentences use the previous text as context automatically |
| `THREADS` | `4` | CPU threads for the models |
| `DEBUG` | unset | `DEBUG=1` prints model logs and per-sentence timings |

## Testing without a microphone

```bash
say -v Ioana -o /tmp/ro.aiff "Bună ziua, ce mai faceți? Astăzi vorbim despre vreme."
afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/ro.aiff /tmp/ro.wav
npm start                                                        # terminal 1
npm run test:wav -- /tmp/ro.wav --model canary-1b-v2              # terminal 2, streams in real time
```

## Troubleshooting

- **Start does nothing / mic blocked**: allow the mic in the browser's address bar, and in *System Settings → Privacy & Security → Microphone* for your browser. Use `http://localhost`, since browsers only allow the mic on localhost or HTTPS.
- **Far-away people are missed** (the indicator stays on "listening"): `VAD_THRESHOLD=0.35 npm start`, or use an external mic.
- **Sentences cut mid-thought**: `VAD_SILENCE_MS=1000 npm start`.
- **Port in use**: the transcriber is probably already running in another terminal. Stop it (Ctrl+C), or use `PORT=3001 npm start`.

## Limits

- No speaker labels yet ("who said what"). See *Next steps*.
- Final text appears ~1 s after someone stops talking (0.7 s pause detection plus inference).

## Next steps

- **Speaker labels**: sherpa-onnx (already installed) includes speaker-embedding models. Each final sentence could be tagged "Speaker 1 / 2 / 3" by voice similarity, live.
