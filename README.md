# Live Transcriber (Romanian)

Put the laptop on the table, press Start, and get Romanian text live as people talk.
Everything runs locally on the computer. No API keys, no accounts, and no audio leaves the machine.

## Desktop app (no technical setup)

For people who just want to use it, on a Mac with Apple Silicon or a Windows PC:

1. Download the installer from the **[latest release](https://github.com/Denis-Feier/local-word-transcriptor/releases/latest)**:
   `Live-Transcriber-…-mac-arm64.dmg` for Mac (M1 or newer, macOS 12+), `Live-Transcriber-…-windows-setup.exe`
   for Windows 10/11.
2. Mac: open the `.dmg` and drag *Live Transcriber* into Applications. Windows: run the installer.
3. Open Live Transcriber. The first time, it downloads the Romanian model (1.1 GB) and shows the progress; then
   press **Start**. The Mac asks once for permission to use the microphone.

Transcripts are saved in **Documents → Live Transcriber** (File → *Open transcripts folder*).

**User manual** for the people using the app (5 pages: every control and setting, and what to change for quiet,
slow or fast speakers, noisy rooms and two mics): [English](docs/manual/Live-Transcriber-Manual-EN.pdf) ·
[Română](docs/manual/Live-Transcriber-Manual-RO.pdf). It is also in the app (Help → *User manual*) and on every
release.

The installers aren't signed with a developer certificate yet, so the system warns the first time: on a Mac, open
the app once, then System Settings → Privacy & Security → **Open Anyway** (macOS 14 and older: right-click the app →
**Open**); on Windows, **More info → Run anyway**. The Mac app is ad-hoc signed, which is what keeps macOS from
calling the download "damaged".

The desktop app runs the models that need no extra software: NVIDIA Canary (the default and most accurate) and
the Parakeet family. The Whisper models and Jackrabbit appear only in the developer setup below, where
whisper.cpp and Python are installed.

**Building the installers:** `npm run dist:mac` on a Mac, `npm run dist:win` on Windows; the result is in
`dist/`. Or let GitHub build both: Actions tab → *Desktop app* → **Run workflow**, or push a version tag
(`git tag v1.0.1 && git push origin v1.0.1`) to also publish them on the Releases page, with the download and
install steps from `.github/release-notes.md`. Bump `version` in `package.json` first; it is in the file names.
Then update the user manual, which the installers and the release include: in Claude Code, `/user-manual` checks
what changed for users since the last manual, rewrites what is needed, retakes the screenshots and rebuilds the
PDFs (by hand: edit `docs/manual/manual.*.html`, then `npm run manual`). `npm test` fails (`STATIC-05`) while the
manual is built for an older version.
Each build first runs `test/smoke.js`, which transcribes a Romanian test clip with the speech engine on that
system. To try the app from source: `npm run app`.

## Quick start (developer setup)

There are two ways to run it from source. Both use the same `models/` and `transcripts/` folders.

**With Docker: nothing to install except Docker Desktop.**

```bash
docker compose up -d --build     # first time builds the image (~10 min); later just: docker compose up -d
docker compose down              # stop
```

Docker on a Mac cannot use the Apple GPU, so every model runs on the CPU (see *Docker or native?* below).
Download models from the page's **Model** menu, or all at once with `docker compose run --rm transcriber npm run setup -- --all`.

**Native: fastest, uses the GPU.**

```bash
brew install whisper-cpp uv      # whisper.cpp for the Whisper models, uv for Jackrabbit's Python
npm install
npm run setup                    # voice detector + the default model (Canary 1B v2, 1.1 GB)
npm start                        # or: PORT=3421 npm start
```

`npm run setup -- --all` downloads every model (~10 GB, plus ~1.4 GB of Python for Jackrabbit).

Open **http://localhost:3000**, press **Start**, and allow the microphone.

- Grey text with a cursor is the live guess while someone speaks.
- After a short pause (~0.7 s) the sentence is transcribed again in full and turns final.
- Final lines are saved as you go to `transcripts/<date-time>.txt`. **Clear** starts a new file.

## Projector captions and live settings

**Projector** (or the <kbd>P</kbd> key) turns the page into large captions for a projector: the last sentences
centred on screen, older ones dimmed, the sentence being spoken appearing live underneath. Move the mouse to show
the controls; they and the cursor hide again after a few seconds, so the audience sees only text.

| In the projector view | |
|---|---|
| <kbd>+</kbd> / <kbd>−</kbd> | text size |
| <kbd>L</kbd> | how many sentences are shown (1–5) |
| <kbd>T</kbd> | colours: white on black, yellow on black (high contrast), black on white |
| <kbd>F</kbd> or double-click | full screen |
| <kbd>Esc</kbd> | back to the transcript |

The light in the bottom-left corner shows the microphone: grey off, green listening, orange someone speaking.

**Projector as a second screen** (not mirrored): Settings → **Open caption window**, drag that window onto the
projector and press <kbd>F</kbd>. It shows only the captions and follows this window, which keeps all the controls
and settings out of the audience's sight.

**Settings** adjusts speech detection live, while someone is talking; changes apply immediately, are remembered,
and override the environment variables below until you press *Reset to defaults*:

| If… | Change |
|---|---|
| a quiet or distant speaker is missed | lower **Speech detection threshold** (e.g. 0.35) |
| background noise produces text | raise the threshold (e.g. 0.6–0.7) |
| sentences are cut while the speaker pauses or speaks slowly | longer **Pause that ends a sentence** (1.2–2 s or more) |
| coughs or chair noises turn into words | raise **Ignore sounds shorter than** |
| one long sentence fills the whole screen | shorter **Longest sentence** |
| with two mics, one person's words also appear under the other mic | lower **Mic separation** (e.g. 5 dB) |
| with two mics, someone talking over the other is lost | raise **Mic separation** (e.g. 12 dB) |

## Two microphones

Pick a second input under **Mic 2**. It can be any microphone the computer sees (built-in, USB, jack, Bluetooth,
a wireless kit's receiver), and each mic is meant for one speaker. Every line then says which mic heard it, in that
mic's colour: Mic 1 blue, Mic 2 orange, on the page, in the projector view and as `Mic 1:` / `Mic 2:` in the saved
transcript. Lines spoken at the same time are marked ⇄.

- **Each mic also hears the other person**, just less clearly. The app keeps those words only on the mic that heard
  them best, so they don't show up twice. If the same words still reach both mics, the less clear copy is dropped
  once both are transcribed.
- **Talking at the same time** works: each mic is transcribed separately, and both lines appear.
- **A mic that disconnects** (Bluetooth out of range, battery, cable) shows *not connected*. The other keeps
  recording, and it joins again on its own once it is back.
- **Two Bluetooth headsets on a Mac don't work together**: macOS takes sound from only one Bluetooth headset mic at a
  time, so the other sends silence (usually the one connected first). The page shows *no sound* on its meter and a
  warning. Connect one of them another way: many headsets come with a USB receiver (Logitech G435: the LIGHTSPEED
  receiver; Jabra Evolve 65: the Jabra Link 360 dongle), or use a USB or jack mic. A Bluetooth mic plus any
  non-Bluetooth mic works.
- With *Save audio* on, each mic gets its own WAV (`<stamp>-mic1.wav`, `<stamp>-mic2.wav`).
- `MAX_MICS` changes the limit of 2.

## A speaker in the room

If the audience needs to hear the people talking, for example through a karaoke or PA speaker, pick that speaker
under **Speaker**. The app plays the mics on it and keeps transcribing as before. Any output the computer sees
works: its own speakers, a jack or USB speaker, a Bluetooth speaker, or a projector's HDMI sound. Connect or pair the
speaker first.

- **On and off:** choosing a speaker turns it on at once, even before **Start**, so you can do a sound check; the
  level meters move too. **None** turns it off. Start and Stop don't affect it. The app always opens with *None*, so it never starts
  howling by surprise. **Volume** is remembered.
- **Use a cable or USB speaker rather than Bluetooth** if the person talking can hear it. Bluetooth speakers play
  about 0.2 s late. The talker hears that delay as an echo, which can make them stumble. A cable or USB speaker plays
  at once.
- **Howling (feedback)** happens when a mic picks up the speaker. Put the speaker in front of the mics, facing away
  from them towards the audience, and turn **Volume** down if it starts. The laptop's own speakers almost always howl
  with its built-in mic.
- **With two mics**, the speaker also plays each person's voice near the other mic. Keep it away from both mics, or
  some lines may appear under the wrong mic.
- **A Bluetooth speaker with its own microphone** (many karaoke speakers have one): under Mic 1 and Mic 2, choose
  your real mics instead of *System default*. Otherwise the Mac may record from the speaker's microphone, which
  switches the speaker to call quality and makes both the sound and the text worse.
- **A speaker that disconnects** shows *not connected* and goes silent. The sound does not move to the laptop's
  speakers. It plays again once the speaker is back.
- Picking a particular speaker works in the desktop app, Chrome and Edge. In Safari and Firefox the only choice is
  *System default*.

## Docker or native?

Docker on macOS runs a Linux virtual machine that can't reach the Apple GPU, so inside Docker every model
runs on the CPU. Measured per sentence on this M5:

| Model | Native | Docker | Live use in Docker |
|---|---|---|---|
| NVIDIA Canary 1B v2 | ~0.15 s (GPU) | 0.2–0.6 s | yes |
| Jackrabbit 110M Romanian | 0.3–0.45 s (CPU) | 0.2–0.45 s | yes, same speed |
| Parakeet models | ~0.1–0.15 s | 0.2–0.6 s | yes |
| Whisper large-v3 / turbo / BuzzASR | 0.5–1.5 s (GPU) | ~6.5 s | no: marked "slow in Docker" in the menu |

Transcripts are identical either way. Docker is the no-setup option; native is the fast option and the only
way to use the large Whisper models live.

Docker notes:
- Docker Desktop gives its VM 8 GB of memory by default, enough for one model at a time (Jackrabbit with its
  language model needs ~5 GB). Raise it in Docker Desktop → Settings → Resources if a model fails to load.
- The image (~3.4 GB) contains Node, whisper.cpp built for the CPU, and Python with PyTorch and NeMo. Models are
  not in the image; they live in `models/` on the Mac and are mounted in.
- The page is published on `127.0.0.1` only, so other computers on the network can't open it.
- Run tools inside the container the same way, e.g.
  `docker compose run --rm transcriber npm run benchmark -- --name fleurs-ro-docker`.

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
- The page keeps the screen awake while recording or playing on a speaker. If the server restarts mid-meeting, the page keeps recording and sends the buffered audio (up to 5 minutes) once it reconnects.
- Overlapping speech (two people at once) is transcribed as one mixed sentence. Turn-taking works best, or give
  each speaker their own mic (see *Two microphones*).

## How it works

```
Browser                       Node (server.js)                            Speech model
mics → AudioWorklet ─WS─▶  Silero VAD + Segmenter per mic        ──▶   whisper-server (whisper.cpp, GPU)
      16 kHz Float32        (crosstalk gate between mics)              transcribe.cpp (GPU, in-process)
                            ├─ while speaking: live guess
                            └─ on pause: final + save                  sherpa-onnx (CPU, in-process)
      transcript UI ◀──WS── text cleanup (diacritics,                  python/nemo_server.py (NeMo, CPU)
                            hallucination filter)
```

| File | Role |
|---|---|
| `public/pcm-worklet.js` | Takes one input per mic, downsamples to 16 kHz mono, sends 100 ms chunks with every mic's audio side by side |
| `public/mics.js` | Lists the audio inputs and records one or more of them together; reconnects a mic that comes back |
| `public/speaker.js` | Plays the mics on the speaker chosen for the room: full quality, low delay, separate from the transcription |
| `public/app.js` | UI: models, mic and speaker choice, live and final lines (coloured per mic), wake lock, reconnect buffering |
| `public/stage.js` | Projector view: large centred captions, display preferences, full screen; also the caption window (`/?display`) |
| `public/settings.js` | Settings panel: live speech-detection sliders (`lib/tuning.js` on the server) and projector display options |
| `server.js` | Static files, WebSocket, model downloads and switching |
| `lib/vad.js` | Speech detectors: Silero (neural, default) and a loudness fallback |
| `lib/segmenter.js` | Turns detector frames into utterances: pre-roll, pause timeout, splits monologues longer than 20 s at the quietest point |
| `lib/session.js` | One browser tab: a segmenter per mic, schedules live guesses and finals, drops a sentence another mic heard more clearly, writes transcript/audio files |
| `lib/crosstalk.js` | With several mics: decides which mic each moment of speech belongs to, by clarity above each mic's own noise |
| `lib/transcriber.js` | Owns the active model, serialises requests, switches models, restarts a crashed model |
| `lib/engines/*.js` | One adapter per runtime: whisper.cpp, transcribe.cpp, sherpa-onnx, Python/NeMo. `sidecar.js` is the shared logic for models served by a separate process |
| `python/nemo_server.py` | Small local HTTP server that runs NeMo models (Jackrabbit) for the Node app; its environment lives in `python/.venv` |
| `lib/models.js` | Model catalogue, download, unpack, and conversion of Whisper fine-tunes (`lib/convert-whisper.js`) |
| `lib/text.js` | Fixes ş/ţ → ș/ț, removes `[Muzică]` tags, drops Whisper's known silence hallucinations ("Mulțumim pentru vizionare!") |
| `scripts/compare.js` | Runs several models over one of your recordings and reports speed and WER |
| `scripts/benchmark.js` | Scores models on the FLEURS Romanian test set (`npm run benchmark`) |
| `Dockerfile`, `docker-compose.yml` | The Docker image and how it is started |
| `desktop/main.mjs` | The desktop app (Electron): starts the server in the background, opens its page, sends the caption window to the projector, data folders per user |
| `docs/manual/` | The user manual: `manual.en.html` / `manual.ro.html` (the text), `manual.css`, `img/` (screenshots) and the PDFs built from them |
| `scripts/manual.mjs` | Builds the manual (`npm run manual`): screenshots of the page with the UI test's fake microphones, then a PDF per language; `--pdf-only` skips the screenshots |
| `test/smoke.js` | End-to-end check on any OS: server, automatic model download, transcription of `test/fixtures/ro.wav` (one mic and two) |
| `test/run-all.js` | Runs the whole test plan (`TESTING.md`): logic, server, two-mic conversations, the page in Electron; `npm test` |
| `.github/workflows/desktop.yml` | Builds and tests the Mac and Windows installers on GitHub; publishes them on version tags |

Live guesses refresh every 0.5 s, or less often for slow models (twice the model's average inference time), so they never delay the final text.

## Configuration (environment variables)

The speech-detection values (`VAD_THRESHOLD`, `VAD_SILENCE_MS`, `VAD_MAX_SEGMENT_SEC`, `PARTIAL_EVERY_SEC`, `CROSSTALK_DB`) can also be changed live in **Settings**, which overrides them until *Reset to defaults*.

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
| `MAX_MICS` | `2` | How many microphones can be used at the same time |
| `CROSSTALK_DB` | `8` | With several mics: a mic ignores speech it hears this many dB less clearly than another mic (Settings → *Mic separation*) |
| `INITIAL_PROMPT` | empty | Whisper only: names or jargon to prime the first sentence, e.g. `INITIAL_PROMPT="Ședința cu Andrei și Mihaela despre Kubernetes."` Later sentences use the previous text as context automatically |
| `THREADS` | `4` | CPU threads for the models |
| `DEBUG` | unset | `DEBUG=1` prints model logs and per-sentence timings |

## Tests

`npm test` runs the test plan in [TESTING.md](TESTING.md) (~5 min; `npm run test:quick` ~1 min, `npm run test:full`
~15 min with every speech engine). Each run writes a report to `test-results/`. The plan, the per-merge routine and
the checklist for testing with real microphones are in TESTING.md.

## Testing without a microphone

```bash
say -v Ioana -o /tmp/ro.aiff "Bună ziua, ce mai faceți? Astăzi vorbim despre vreme."
afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/ro.aiff /tmp/ro.wav
npm start                                                        # terminal 1
npm run test:wav -- /tmp/ro.wav --model canary-1b-v2              # terminal 2, streams in real time
```

Two mics: `--mic2 other.wav` streams a second speaker alongside. `--bleed 15` lets each mic also hear the other
speaker 15 dB quieter, `--lag 150` delays mic 2 like Bluetooth, and `--gain2 12` makes it louder. `--mic2 silence
--only-mic 1` checks that a mic hearing only the other person stays silent:

```bash
npm run test:wav -- test/fixtures/ro.wav --mic2 silence --bleed 6 --lag 150 --only-mic 1 --expect munții
```

A real two-mic session recorded with *Save audio* replays exactly as it was heard, which is the way to tune
**Mic separation** for a room. With `DEBUG=1 npm start` the server also prints, every 10 s, each mic's noise level
and how much of the speech it heard was kept as its own:

```bash
npm run test:wav -- transcripts/<stamp>-mic1.wav --mic2 transcripts/<stamp>-mic2.wav
```

## Troubleshooting

- **Start does nothing / mic blocked**: allow the mic in the browser's address bar, and in *System Settings → Privacy & Security → Microphone* for your browser. Use `http://localhost`, since browsers only allow the mic on localhost or HTTPS.
- **Far-away people are missed** (the indicator stays on "listening"): `VAD_THRESHOLD=0.35 npm start`, or use an external mic.
- **Sentences cut mid-thought**: `VAD_SILENCE_MS=1000 npm start`.
- **Port in use**: the transcriber is probably already running in another terminal. Stop it (Ctrl+C), or use `PORT=3001 npm start`.

## Limits

- Speakers are told apart only by microphone (one mic per person, up to two): no voice-based speaker labels yet. See *Next steps*.
- Final text appears ~1 s after someone stops talking (0.7 s pause detection plus inference).

## Next steps

- **Speaker labels**: sherpa-onnx (already installed) includes speaker-embedding models. Each final sentence could be tagged "Speaker 1 / 2 / 3" by voice similarity, live.
