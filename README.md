# Live Transcriber (Romanian)

Put the laptop on the table, press Start, and get Romanian text live as people talk.
Everything runs locally on the computer. No accounts, and no audio leaves the machine. The one exception is optional:
with your own ElevenLabs API key, a cloud model appears in the menu, and it sends the speech to ElevenLabs
(*ElevenLabs, in the cloud*, below).

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
the Parakeet family, plus ElevenLabs' cloud model once you add your API key (*ElevenLabs, in the cloud*, below). The Whisper models, the NeMo models (Jackrabbit, the UPB FastConformer) and Apple's dictation appear only in the developer setup
below, where whisper.cpp, Python and the Xcode command-line tools are installed.

**Building the installers:** `npm run dist:mac` on a Mac, `npm run dist:win` on Windows; the result is in
`dist/`. Or let GitHub build both: Actions tab → *Desktop app* → **Run workflow**, or push a version tag
(`git tag v1.0.1 && git push origin v1.0.1`) to also publish them on the Releases page, with the download and
install steps from `.github/release-notes.md`. Bump `version` in `package.json` first; it is in the file names.
Then update the user manual, which the installers and the release include: in Claude Code, `/user-manual` checks
what changed for users since the last manual, rewrites what is needed, retakes the screenshots and rebuilds the
PDFs (by hand: edit `docs/manual/manual.*.html`, then `npm run manual`). `npm test` fails (`STATIC-05`) while the
manual is built for an older version.
Each build first runs `test/smoke.ts`, which transcribes a Romanian test clip with the speech engine on that
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

**Native: fastest, uses the GPU.** Needs Node 22.18 or newer (`brew install node`). The code is TypeScript that Node
runs as it is (type stripping is built in from 22.18 on), so there is no build step.

```bash
brew install whisper-cpp uv      # whisper.cpp for the Whisper models, uv for the NeMo models' Python
npm install
npm run setup                    # voice detector + the default model (Canary 1B v2, 1.1 GB)
npm start                        # or: PORT=3421 npm start
```

`npm run setup -- --all` downloads every model (~10 GB, plus ~1.4 GB of Python for the NeMo models).

Open **http://localhost:3000**, press **Start**, and allow the microphone.

- Grey text with a cursor is the live guess while someone speaks. With **Steady live text** (on by default) a word
  shows only once two live guesses in a row agree on it (LocalAgreement-2), and a word once shown never changes, so the
  text does not jump around on a projector; words appear about one guess (~0.5 s) later. Untick it to see every guess
  as the model writes it. The same text goes to the page, the projector view and the caption windows.
- After a short pause (~0.7 s) the sentence is transcribed again in full and turns final.
- Final lines are saved as you go to `transcripts/<date-time>.txt`. **Clear** starts a new file. A recording that
  starts in the same second as another (a second tab, or the desktop app beside `npm start`) gets `<date-time>-2`,
  so two recordings never share a file. If the server restarts or the network drops mid-recording, the page carries on
  the same `.txt` (and WAVs) with the clock going on; reloading the page starts a new file, as the page starts empty.

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
  them best, so they don't show up twice: a sentence another mic heard clearly better is not transcribed, and if the
  same words still reach both mics, the less clear copy is dropped once both are transcribed. A few words of a
  sentence that reach the other mic never cancel the whole sentence.
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
| Jackrabbit 110M Romanian | 0.3–0.45 s (measured on the CPU, before it moved to the GPU) | 0.2–0.45 s | yes, same speed |
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

The menu has two groups, from the one-hour benchmark run on this M5 (`benchmarks/runs/2026-11-02_20-09_mac-m5/report.md`: every model on
the same 100 FLEURS Romanian clips, through the app itself; the ranking rules are in [#28](https://github.com/Denis-Feier/local-word-transcriptor/issues/28)):

| | Model | WER measured here¹ (with / without diacritics) | Published² | Speed¹ | Live text rewrites¹ | WER in noise¹ | Invents on silence¹ | On disk | Runs on |
|---|---|---|---|---|---|---|---|---|---|
| **Recommended** | **NVIDIA Canary 1B v2** (default) | **6.0 % / 5.6 %** | 6.6 % | 55× | 0.28 | 20 % | 0 / 4 | 1.1 GB | GPU, transcribe.cpp |
| **Recommended** | Parakeet Ultra 0.6B | 10.0 % / 9.7 % | 9–10 % | 72× | 0.39 | 27 % | 0 / 4 | 740 MB | GPU, transcribe.cpp |
| Other | Jackrabbit 110M Romanian (Surogate): steadiest live text and best in noise, but non-commercial and needs Python | 7.8 % / 7.6 % | 5.7 % | 25× | 0.09 | 12 % | 0 / 4 | 2.5 GB | GPU (MPS), Python/NeMo |
| Other | Whisper large-v3: too slow for live text (a refresh every ~3 s) | 9.1 % / 8.5 % | 8.2 % | 7× | 0.13 | 24 % | 0 / 4 | 1.1 GB | GPU, whisper.cpp |
| Other | Orukeet 0.6B: as good as Parakeet Ultra, CC-BY-SA | 10.2 % / 9.9 % | 9.3 % | 76× | 0.28 | 31 % | 0 / 4 | 740 MB | GPU, transcribe.cpp |
| Other | FastConformer Romanian 114M (UPB NLP)⁶: lowercase, no punctuation, Python, no license | 11.3 % / 11.0 % | none | 93× | 0.30 | 21 % | 0 / 4 | 454 MB | GPU (MPS), Python/NeMo |
| Other | Whisper large-v3 Romanian (BuzzASR)³: slowest | 11.7 % / 11.4 % | 9.8 % | 4× | 0.05 | 22 % | 1 / 4 | 1.7 GB | GPU, whisper.cpp |
| Other | Whisper large-v3 turbo: drops diacritics | 11.9 % / 9.2 % | 8–11 % | 17× | 0.29 | 29 % | 1 / 4 | 874 MB | GPU, whisper.cpp |
| Other | NVIDIA Parakeet TDT 0.6B v3: Parakeet Ultra is its better retrain | 12.1 % / 11.7 % | 12.4 % | 86× | 0.41 | 33 % | 0 / 4 | 740 MB | GPU, transcribe.cpp |
| Other | Parakeet Romanian 110M (Politehnica)⁴: fastest, lowercase, no punctuation | 12.6 % / 11.9 % | 10.6 % | 216× | 0.31 | 18 % | 0 / 4 | 135 MB | GPU, transcribe.cpp |
| Other | Apple on-device dictation (macOS 26)⁵: collapses in noise, no punctuation | 16.7 % / 16.4 % | none | 62× | 0.04 | 53 % | 1 / 4 | kept by macOS | Mac only, Apple's Speech framework |
| Other | Whisper small Romanian (readerbench)³: invents text on silence, fails on long sentences | 19.4 % / 19.1 % | 10.9 % | 26× | 0.31 | 50 % | 4 / 4 | 260 MB | GPU, whisper.cpp |
| Other | ElevenLabs Scribe v2 Realtime (cloud)⁷: costs money, the audio leaves | not measured | ≤ 5 % (ElevenLabs' group) | ~150 ms per sentence (ElevenLabs) | — | — | — | nothing | ElevenLabs' servers, over the internet |

¹ Measured on this M5 on 2026-11-02 with `npm run benchmark:suite` (one hour, open audio): WER = word error rate on 100 FLEURS Romanian clips (read, close-mic speech; lower is better; the 883-clip numbers in `benchmarks/results/fleurs-ro.md` agree within a point). Speed = seconds of audio per second of compute on the GPU. Live text rewrites = words shown as live text and then taken back, per word of the final line, with Steady live text on (0 = never; raw guesses rewrite 5–10× more). Noise = WER (diacritics ignored) with white noise at 10 dB SNR. Silence = of 4 inputs with no speech, how many got invented text. A room with several speakers will score worse for every model.
² FLEURS Romanian as published: Canary, Whisper large-v3 and Parakeet v3 from NVIDIA's paper (arXiv 2509.14128, Table 11); the others from their authors or the Handy benchmarks.
³ Hugging Face Whisper fine-tunes with no ready-made whisper.cpp version. The app downloads the original weights, converts them to whisper.cpp's format with `lib/convert-whisper.ts` (a JavaScript port of whisper.cpp's converter, no Python needed), quantizes them to q8_0 with `whisper-quantize`, and keeps only the result. BuzzASR downloads 3.1 GB, readerbench 967 MB. The readerbench model runs without the previous-text context, which made it invent words.
⁴ Outputs lowercase text without punctuation (that is how it was trained), but its words are very accurate and it is by far the fastest.
⁵ Apple's own recognizer (the macOS 26 `DictationTranscriber`), fully on the Mac; macOS downloads and keeps the Romanian model itself. Not the default and not recommended for Romanian: on FLEURS Romanian (883 sentences, `npm run benchmark`) it scored 17.6 % WER against 6.6 % for Canary, because it leaves words out and adds no punctuation (Apple's newer `SpeechTranscriber` has no Romanian). The menu offers it on macOS 26 or later, from source with the Xcode command-line tools: choosing it, or `npm run setup -- apple-dictation`, compiles a small Swift helper (`native/apple-speech/`, ~11 s). The desktop app does not ship the helper.
⁶ `upb-nlp/ro-fast-conformer`, a NeMo FastConformer fine-tuned on Romanian (MDPI Applied Sciences 16(4):1928). The authors report 3.0 % WER on their own test sets, but no FLEURS score; on FLEURS Romanian (883 sentences, `npm run benchmark`) it scored 11.6 % here, about the same as Parakeet Romanian 110M, against 6.6 % for Canary. Some of that is numbers written as words ("o sută" for "100"): without the sentences that have digits, 8.0 % against Canary's 6.2 %. Like Parakeet Romanian 110M it writes lowercase without punctuation. Its RNNT decoder is used; its CTC head scored 13.7 %. Needs Python (installed with it, like Jackrabbit), so the desktop app does not offer it.
⁷ The only model that sends audio off the computer, and only offered when you add your own API key. See *ElevenLabs, in the cloud*.

### ElevenLabs, in the cloud

ElevenLabs' realtime speech-to-text (Scribe v2 Realtime, `scribe_v2_realtime`) can be picked like any other model.
It is never the default, and it is offered only when there is an ElevenLabs API key:

1. Create a key at [elevenlabs.io](https://elevenlabs.io/app/settings/api-keys) (access to *Speech to Text* is enough).
2. From source: `cp .env.example .env.local`, then put the key after `ELEVENLABS_API_KEY=`. Git ignores `.env.local`.
   Desktop app: create `.env.local` with that line in the app's data folder (Mac:
   `~/Library/Application Support/Live Transcriber/`, Windows: `%APPDATA%\Live Transcriber\`).
   A real `ELEVENLABS_API_KEY` environment variable works too.
3. Restart. *ElevenLabs Scribe v2 Realtime (cloud)* is now in the **Model** menu. Choosing it checks the key at once
   (a wrong key turns the status red and says so).

What to know before using it:

- **The speech leaves the computer.** Each sentence goes to ElevenLabs over an encrypted connection; the page's footer
  turns amber while this model is picked. ElevenLabs keeps request history by default (its zero-retention mode is for
  enterprise accounts). Use a local model for anything that must stay on the computer.
- **It costs money.** ElevenLabs bills each second of audio it receives: $0.39 an hour of audio for Scribe v2 Realtime
  (November 2026). Only speech is sent: the app's own voice detector decides when someone is talking, and silence,
  coughs and the pause after a sentence are not sent.
- **How it works.** Each sentence gets its own realtime connection, opened when someone starts talking. The audio
  streams while they speak, the grey live text is ElevenLabs' own, and when the pause ends the sentence the app asks for
  the final text (about 150 ms, plus the network). The end of the transcript so far goes with each sentence as context.
  With two mics each mic streams on its own, and the mic separation works as with the local models.
- **Network trouble.** A sentence whose connection fails is sent once more, whole; if that fails too, the page shows
  ElevenLabs' reason (no credits left, wrong key, no internet) and the next sentence tries again. Tick **Save audio** if
  you might want to transcribe a meeting again later with a local model.
- **Not measured here.** ElevenLabs puts Romanian in its best group (≤ 5 % WER); `npm run benchmark` and
  `npm run compare` leave it out unless you name it (`--models elevenlabs-scribe-v2`), because that sends the audio and
  bills for it. The tests use a stand-in server and never reach ElevenLabs.
- Another region (data residency): `ELEVENLABS_BASE_URL=https://api.eu.residency.elevenlabs.io` (or `api.us`,
  `api.in.residency`, `api.sg.residency`).

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
| FastConformer Romanian 114M | Hugging Face `upb-nlp/ro-fast-conformer` | `models/ro-fast-conformer/` |
| Parakeet TDT v3 | Hugging Face `handy-computer/parakeet-tdt-0.6b-v3-gguf` | `models/parakeet-tdt-0.6b-v3-Q8_0.gguf` (the older CPU build in `models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/` is no longer used and can be deleted) |
| Apple on-device dictation | built on this Mac from `native/apple-speech/` (nothing downloaded); macOS keeps the language model | `models/apple-speech-server` |
| ElevenLabs Scribe v2 Realtime | ElevenLabs' servers, with your API key (nothing downloaded) | nothing; the key in `.env.local` |
| Silero voice detector | GitHub release of `k2-fsa/sherpa-onnx` | `models/silero_vad.onnx` |

Each model is downloaded once and then used from disk; nothing is fetched while transcribing, so the app works offline. To remove a model, delete its file or folder; the menu then offers it for download again. Download from the command line with `npm run setup -- <id>`, all at once with `npm run setup -- --all`, and see the list with `npm run setup -- --list`.

Licenses: Whisper, BuzzASR: MIT. readerbench, Parakeet Romanian 110M: Apache-2.0. Canary, Parakeet v3, Parakeet Ultra: CC-BY-4.0. Orukeet: CC-BY-SA-4.0. All allow commercial use. The FastConformer Romanian 114M has no license on Hugging Face (no model card), so it is not clear that it may be used at all; ask its authors before using it for work.

Not included, as of October 2026:
- **Meta Seamless M4T v2** (8.9 %): only available as PyTorch weights (~9 GB), so it would need a Python runtime; non-commercial license; less accurate than Canary.
- **Other cloud services**: need an API key and send the audio off the machine, like ElevenLabs (which is included, as an option).
- **Qwen3-ASR** (20–44 %) and **NVIDIA Nemotron streaming** (26–32 %): much worse on Romanian. **Meta Omnilingual**: its strong variant is a 7B model with no Mac runtime.
- **Voxtral, Phi-4, Granite Speech, Kyutai, Cohere Transcribe**: no Romanian.

## Benchmarking this app on your computer

`npm run benchmark:suite` measures every downloaded local model on open audio and exports the results with a description
of the computer, so people with different Macs and PCs can run it and send the numbers back. It takes about an hour
(the budget is yours to set, up to two hours) and needs nothing private: the audio is the FLEURS Romanian test set
(Google, CC-BY-4.0, ~500 MB, downloaded once into `benchmarks/data/`), and the noisy, quiet, far-away and silent inputs
are made from it on the spot, the same on every computer.

```bash
git clone https://github.com/Denis-Feier/local-word-transcriptor.git && cd local-word-transcriptor
npm install
npm run benchmark:suite -- --install --label my-laptop        # downloads every model this computer can run, then measures them (~1 h)
```

What it measures, per model, through the app's own transcriber (so the numbers are what the app gets):

| Stage | Clips | What comes out |
|---|---|---|
| Load | — | time to ready, the device it runs on (GPU or CPU, and why not the GPU), memory taken, the slower first sentence |
| Accuracy and speed | 100 | word error rate (with diacritics, without, and without the sentences that have digits), times faster than real time, ms per sentence by sentence length |
| Live text ([#27](https://github.com/Denis-Feier/local-word-transcriptor/issues/27)) | 40 | each sentence replayed on the app's live-guess schedule: how many words shown are later taken back (erasure), how often, how much of the sentence is on screen before the final line, when the first words appear, how long the final takes after the pause; raw and with Steady live text |
| Noise, a quiet speaker, a mic across the room | 25 | WER with noise at 20 dB and 10 dB SNR, the speaker 20 dB quieter, the mic across the room, against the same clips clean |
| Long sentences | 3 each | 20 s and 40 s of joined speech: time, speed and WER (the app cuts sentences at 20 s by default) |
| Silence | 4 | 3 s and 10 s of silence, an empty room, a fan next to the mic: what the model invents |

Options: `--minutes 60` (the budget, at most 120; the stages shrink on a slow computer and stop at the deadline, marked ⏱),
`--parallel 2` (models side by side; speeds are only comparable at 1), `--models canary-1b-v2,orukeet`,
`--clips 200 --live 60 --robust 40` (bigger stages), `--label` (a name for the computer in the results), `--name <run>`
(resume an interrupted run; models already measured are kept), `--fresh` (measure them again). The ElevenLabs cloud model
is never included: it bills and sends the audio away.

The results go to `benchmarks/runs/<date>_<label>/`: `report.md` (the tables), `run.json` (everything, including every
clip's text per model, and the computer: OS, CPU, RAM, GPU, Node and app version; no user or host name) and
`models/<id>.log`. To send them back, open an issue or a pull request with that folder. The whole FLEURS set, for the
published ranking, is `npm run benchmark` (`benchmarks/results/fleurs-ro.md`, ~2 h for every model).

## Comparing models on your own audio

Published benchmarks are read speech recorded close to the mic. The only reliable test is your room, your voices, your vocabulary:

1. Tick **Save audio** in the page and record a real conversation (10–30 min is plenty). The audio is saved as `transcripts/<date-time>.wav`.
2. Run every downloaded model over exactly the same utterances (the ElevenLabs cloud model only with
   `--models elevenlabs-scribe-v2`, since it sends the recording to ElevenLabs and bills for it):
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
- The page keeps the screen awake while recording or playing on a speaker. If the server restarts mid-meeting, the page keeps recording and sends the buffered audio once it reconnects, into the same transcript file. It keeps the newest 5 minutes: after a longer outage the oldest audio is dropped, and the page says how much was lost.
- Overlapping speech (two people at once) is transcribed as one mixed sentence. Turn-taking works best, or give
  each speaker their own mic (see *Two microphones*).

## How it works

```
Browser                       Node (server.ts)                            Speech model
mics → AudioWorklet ─WS─▶  Silero VAD + Segmenter per mic        ──▶   whisper-server (whisper.cpp, GPU)
      16 kHz Float32        (crosstalk gate between mics)              transcribe.cpp (GPU, in-process)
                            ├─ while speaking: live guess
                            └─ on pause: final + save                  python/nemo_server.py (NeMo, GPU via MPS)
      transcript UI ◀──WS── text cleanup (diacritics,                  Apple speech helper (macOS picks the chip)
                            hallucination filter)
```

**GPU first, CPU as the fallback.** Every model that can use the GPU does: transcribe.cpp picks the GPU itself
(Metal on a Mac), whisper-server uses it by default, and `python/nemo_server.py` puts the NeMo models on it through
PyTorch's MPS (`--device auto`; operations MPS lacks run on the CPU, `PYTORCH_ENABLE_MPS_FALLBACK=1`). Jackrabbit's
4-gram language-model search runs on the CPU in any case: only its acoustic model moves. If a model cannot load or
run on the GPU, it is loaded again on the CPU (whisper-server with `--no-gpu`, the NeMo server with `--device cpu`)
and keeps working, slower. A model that fails on the GPU in the middle of a meeting moves to the CPU too: the NeMo
server on any GPU error, a transcribe.cpp model when the CPU can transcribe the sentence the GPU could not. The page's
status says where the model runs ("Canary 1B v2 · ready on GPU"; hover it for the device, e.g. Metal, and for why the
GPU was not used), and the terminal says why too. On Windows the transcribe.cpp models reach the GPU through Vulkan,
so any graphics card whose driver supports Vulkan is used, NVIDIA ones back to the GTX 600 series included. Two small exceptions stay on the CPU on purpose: the Silero voice detector
(a 2 MB model run every 32 ms, where handing work to the GPU would cost more than it saves) and Apple's dictation,
where macOS decides. In Docker there is no GPU, so everything runs on the CPU there.

| File | Role |
|---|---|
| `web/pcm-worklet.ts` | Takes one input per mic, downsamples to 16 kHz mono, sends 100 ms chunks with every mic's audio side by side |
| `web/mics.ts` | Lists the audio inputs and records one or more of them together; reconnects a mic that comes back |
| `web/speaker.ts` | Plays the mics on the speaker chosen for the room: full quality, low delay, separate from the transcription |
| `web/app.ts` | UI: models, mic and speaker choice, live and final lines (coloured per mic), wake lock, reconnect buffering |
| `web/backlog.ts` | The audio kept while the server is unreachable: the newest 5 minutes, and what a longer outage lost |
| `web/order.ts` | The order of the lines, the order they were spoken in: one rule for the page, Copy, Download and the saved `.txt` |
| `web/stage.ts` | Projector view: large centred captions, display preferences, full screen; also the caption window (`/?display`) |
| `web/settings.ts` | Settings panel: live speech-detection sliders (`lib/tuning.ts` on the server) and projector display options |
| `public/` | The page as the browser loads it: `index.html`, `style.css` and the JavaScript `tsc` emits from `web/*.ts` (`npm run build:web`; committed, so no build step is needed to run the app) |
| `server.ts` | Static files, WebSocket (only from its own page), model downloads and switching |
| `lib/vad.ts` | Speech detectors: Silero (neural, default) and a loudness fallback |
| `lib/segmenter.ts` | Turns detector frames into utterances: pre-roll, pause timeout, splits monologues longer than 20 s at the quietest point |
| `lib/session.ts` | One browser tab: a segmenter per mic, schedules live guesses and finals (or streams each sentence to a streaming model), drops a sentence another mic heard more clearly, writes transcript/audio files |
| `lib/crosstalk.ts` | With several mics: decides which mic each moment of speech belongs to, by clarity above each mic's own noise |
| `lib/transcriber.ts` | Owns the active model, serialises requests, switches models, restarts a crashed model (after 4 quick crashes, retries it every 30 s) |
| `lib/engines/*.ts` | One adapter per runtime: whisper.cpp, transcribe.cpp, Python/NeMo, Apple speech, ElevenLabs (`elevenlabs.ts`: a realtime connection per sentence). `sidecar.ts` is the shared logic for models served by a separate process |
| `python/nemo_server.py` | Small local HTTP server that runs NeMo models (Jackrabbit, the UPB FastConformer) for the Node app; its environment lives in `python/.venv` |
| `lib/models.ts` | Model catalogue, download, unpack, and conversion of Whisper fine-tunes (`lib/convert-whisper.ts`) |
| `lib/text.ts` | Fixes ş/ţ → ș/ț, removes `[Muzică]` tags, drops Whisper's known silence hallucinations ("Mulțumim pentru vizionare!") |
| `scripts/compare.ts` | Runs several models over one of your recordings and reports speed and WER |
| `scripts/benchmark.ts` | Scores models on the whole FLEURS Romanian test set (`npm run benchmark`) |
| `scripts/benchmark-suite.ts`, `lib/benchmark/` | The shareable one-hour benchmark (`npm run benchmark:suite`): accuracy, speed, live-text steadiness, noise, long sentences, silence, exported with the computer's description |
| `Dockerfile`, `docker-compose.yml` | The Docker image and how it is started |
| `desktop/main.ts` | The desktop app (Electron): starts the server in the background, opens its page, sends the caption window to the projector, data folders per user |
| `docs/manual/` | The user manual: `manual.en.html` / `manual.ro.html` (the text), `manual.css`, `img/` (screenshots) and the PDFs built from them |
| `scripts/manual.ts` | Builds the manual (`npm run manual`): screenshots of the page with the UI test's fake microphones, then a PDF per language; `--pdf-only` skips the screenshots |
| `types/` | The contracts shared between modules, imported as types only: the WebSocket protocol (`protocol.ts`), the model catalogue (`model.ts`), the configuration (`config.ts`), the engine interface (`engine.ts`), the audio shapes (`audio.ts`), the page's (`page.ts`) and the tests' (`test.ts`) |
| `test/smoke.ts` | End-to-end check on any OS: server, automatic model download, transcription of `test/fixtures/ro.wav` (one mic and two) |
| `test/run-all.ts` | Runs the whole test plan (`TESTING.md`): logic, server, two-mic conversations, the page in Electron; `npm test` |
| `.github/workflows/desktop.yml` | Builds and tests the Mac and Windows installers on GitHub; publishes them on version tags |

Live guesses refresh every 0.5 s, or less often for slow models (twice the model's average inference time), so they never delay the final text.

## Configuration (environment variables)

The speech-detection values (`VAD_THRESHOLD`, `VAD_SILENCE_MS`, `VAD_MAX_SEGMENT_SEC`, `PARTIAL_EVERY_SEC`, `CROSSTALK_DB`) can also be changed live in **Settings**, which overrides them until *Reset to defaults*.

Any of these can also go in `.env.local` (git ignores it; see `.env.example`), one `NAME=value` per line. Real environment variables win.

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
| `NEMO_DEVICE` | `auto` | Where the NeMo models run: `auto` (the GPU, MPS on a Mac, else the CPU), `mps` or `cpu`. Only to compare speeds; the CPU is used anyway when the GPU fails |
| `DEBUG` | unset | `DEBUG=1` prints model logs and per-sentence timings |
| `ELEVENLABS_API_KEY` | unset | Your ElevenLabs key: offers the cloud model, which sends the speech to ElevenLabs (*ElevenLabs, in the cloud*) |
| `ELEVENLABS_BASE_URL` | ElevenLabs' main API | Another ElevenLabs region, e.g. `https://api.eu.residency.elevenlabs.io` |
| `ENV_FILE` | `.env.local` | The file these variables are also read from (the desktop app: `.env.local` in its data folder) |

## Tests

`npm test` runs the test plan in [TESTING.md](TESTING.md) (~5 min; `npm run test:quick` ~1 min, `npm run test:full`
~15 min with every speech engine). Each run writes a signed report to `test-results/` (the exact moment it started as its id, the computer's hardware and software, one row per test). The plan, the per-merge routine and
the checklist for testing with real microphones are in TESTING.md. `npm run typecheck` runs the TypeScript checker
alone; every tier runs it as `STATIC-06`. The page's sources are `web/*.ts`: after editing them, `npm run build:web` emits them into `public/`
(`npm run watch:web` does it on every save), and `STATIC-07` fails while `public/` is stale. How the code became TypeScript, and the decisions behind the setup: [docs/typescript-migration.md](docs/typescript-migration.md).

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
