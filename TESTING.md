# Test plan

This plan is written for AI agents (Claude Code and similar) that test this app, and is kept up to date by them.
People need only two parts: **§9 Hardware checklist** (real microphones) and **§12 Run history** (did main pass?).

The plan is a living document: it changes with every merge into `main` (§3), and on `main` the whole plan is run
again after each merge, so that a new feature cannot quietly break an old one.

**Status:** last full run on `main`: see §12.

---

## 1. Quick start for an agent

```bash
npm test                    # standard tier, ~5 min: static, unit, protocol, smoke, scenarios, ui
npm run test:quick          # quick tier, ~1 min: static, unit, protocol (no browser, small model only)
npm run test:full           # full tier, ~15 min: standard + every speech engine + a 10-minute conversation
npm run test:ui             # one suite (also: --only static|unit|protocol|smoke|scenarios|engines|long)
node test/run-all.js full --recordings transcripts/a.wav,transcripts/b.wav   # + real voices (§2, privacy)
```

- Exit code 0 means no unexpected failure. Known limits (◌) and skips (–) do not fail a run.
- Every run writes `test-results/<date>_<commit>/`: `summary.md` (one row per test), one `.log` per suite and
  `screenshots/` from the UI suite. `test-results/` is not committed.
- Read `summary.md` first. For a failure, open that suite's `.log`; every test prints one line
  (`✔` pass, `✖` fail, `◌` known limit, `–` skipped) with the measured values after `—`.
- Single suites can also be run directly: `node test/unit.js`, `node test/protocol.js`, `node test/smoke.js`,
  `node test/scenarios.js [--model id] [--long] [--only SCN-02]`. The UI suite needs Electron:
  `npm run test:ui`.

## 2. Rules for the agent

1. **Never touch the user's data.** Tests start their own servers with temporary settings and transcripts folders
   (`test/helpers.js`). Do not run `npm start` against `.settings.json` or `transcripts/` for testing. The models
   folder is read-only for tests. If a tool writes into `transcripts/` (e.g. `npm run compare` writes
   `transcripts/<name>.compare.md`), delete only the file you created, after looking at it.
2. **Private recordings stay private.** `transcripts/*.wav` are the user's real conversations. Use them only with
   `--recordings`, only on this computer. Never copy them into the repository, `test/fixtures/`, a commit, an
   artifact, an issue or any online service. Summaries in `summary.md` contain only short text snippets; do not
   paste recording transcripts anywhere else.
3. **No real microphone.** Never open the computer's microphone or record the room. Real-microphone testing is the
   human checklist in §9; the agent prepares it and analyses the recordings people make.
4. **Git:** test work happens on a branch. Commit, merge, push, tag or release only when the user asks.
5. **Clean up.** After a run no test server may be left listening: `lsof -nP -iTCP -sTCP:LISTEN | grep node`.
   Kill only processes you started.
6. **One heavy suite at a time.** Suites share the GPU; running two at once slows the models and can time out
   streaming tests. Do not run a UI suite and a scenario suite in parallel.
7. **A failing test is evidence, not a nuisance.** Do not change a test or its threshold to make it pass unless you
   can show the test itself is wrong (§10 has the procedure and real examples of both kinds).
8. **Environment traps:**
   - VS Code terminals set `ELECTRON_RUN_AS_NODE=1`, which turns Electron into plain Node ("Cannot find module
     'electron'"). `run-all.js` removes it; when running Electron by hand use `env -u ELECTRON_RUN_AS_NODE`.
   - zsh does not split unquoted variables: `$args` stays one argument (use `${=args}` or arrays).
   - The first model load after a reboot is slower; a timeout on the very first run is worth one retry, not two.

## 3. What to do on every merge into main

This is the maintenance loop. Do all steps; skipping one is how the plan goes stale.

**On the feature branch, before the merge**

1. Run `npm test`. If the change touches audio capture, voice detection, segmentation, the crosstalk gate, the
   session, an engine or the transcriber, also run `npm run test:full`.
2. Update this plan in the same branch:
   - add a row in §7 for every new behaviour (new id, what is checked, pass condition, how);
   - add automated tests for the rows marked `auto` (§6 explains how);
   - update §8 (manual checks), §9 (hardware) and §11 (coverage map, gaps) if they are affected;
   - move a known limit (§10.2) to the regular cases when it is fixed;
   - add a line to §13 (plan change log).
3. `STATIC-03` fails when a test id in the code is missing from §7, or a row marked `auto` has no test. Run
   `npm run test:quick` to check.

**On main, after the merge**

4. Run the full tier on `main`, whatever the change was: `npm run test:full` (add `--recordings ...` when the
   user's recordings are available locally). This re-tests old and new features together.
5. Add a row to §12 (run history) with the date, commit, tier, result and counts, and anything notable (new known
   limits, slow suites, retries). Commit it when the user asks for commits.
6. If anything fails on `main`: do not leave it. Reproduce it (§10), fix it on a branch with a regression test, and
   record it in §12.
7. If the merge changed microphone, audio or crosstalk code, tell the user the hardware checklist (§9) should be run
   again, and which items matter for this change.

## 4. Environment

| Need | For | How to get it |
|---|---|---|
| macOS on Apple Silicon (primary), Node ≥ 22.12 | everything | `npm install` |
| `models/silero_vad.onnx` | unit (gate, session), every server suite | `npm run setup` |
| `parakeet-ro-110m` (135 MB) | quick + standard tiers | `npm run setup -- parakeet-ro-110m` |
| `orukeet` (740 MB) | `PROT-MODEL-01/02` (model switching) | `npm run setup -- orukeet` |
| Electron (dev dependency) | UI suite | `npm install` |
| `canary-1b-v2`, `whisper-large-v3-turbo` + `brew install whisper-cpp`, `parakeet-tdt-0.6b-v3`, `jackrabbit-110m-ro` + `brew install uv` | full tier, one model per engine | `npm run setup -- <id>`; missing ones are skipped and reported |
| two real recordings (16 kHz mono WAV, ≥ 60 s of speech each) | optional real-voice scenarios | the user's *Save audio* recordings in `transcripts/` |

Other systems: CI (`.github/workflows/desktop.yml`) runs `test/smoke.js` on macOS and Windows before building the
installers. The other suites are written for macOS; on Windows `PROT-RUN-02` is skipped (no SIGINT) and `SCN-08`
uses `ps` (macOS/Linux only).

Time budgets (Apple M5): static < 5 s, unit ~1 s, protocol ~25 s, smoke ~40 s, scenarios ~70 s, UI ~50 s,
engines 1–3 min each, long conversation ~2 min; standard tier ~3 min, full tier ~12 min. A suite taking 3× its
budget is a finding even if it passes.

## 5. How the tests are built

| File | Role |
|---|---|
| `test/run-all.js` | Runs the tiers, the static checks (`STATIC-*`) and writes the report |
| `test/helpers.js` | Isolated server per test (`startServer`), streaming client (`streamWav`), test speakers, two-mic room simulator (`twoMics`), result bookkeeping (`suite`) |
| `test/unit.js` | Logic without a speech model (`UNIT-*`) |
| `test/protocol.js` | The server as clients use it (`PROT-*`) |
| `test/smoke.js` | End to end on any OS, downloads the model if needed; CI runs it (`SMOKE-*`) |
| `test/stream-wav.js` | Streams WAV files to a server like the page does: one mic, or two with `--mic2`, `--bleed`, `--lag`, `--gain2`, `--only-mic`; also used by people to replay recordings |
| `test/scenarios.js` | Two-mic conversations through the real model (`SCN-*`, `KNOWN-*`) |
| `test/ui/run.mjs` + `test/ui/preload.cjs` | The page in Electron's Chromium with fake microphones (`UI-*`) |
| `test/fixtures/ro.wav` | 16 s of clean synthetic Romanian speech, three sentences, silence at −88 dBFS |

**Audio used by the tests.** Speaker A is the fixture's first sentence (0–6.8 s, 17 words), speaker B its second and
third (7.3–16 s), and the UI's third mic says the third sentence alone. Real voices come only from `--recordings`.

**Two mics in one room (`twoMics`).** Each mic hears its own speaker plus the other speaker `bleedDb` quieter, passed
through a room model (five reflections up to 67 ms, then a low-pass), plus its own noise (default −58 dBFS). Mic 2 can
arrive `lagMs` late (Bluetooth ≈ 150 ms) and be `gain2Db` louder. The noise is seeded, so every run gets the same
audio. Tests that model a person pressing Start add 1.5 s of silence before speech (`lead()`), which is when the
crosstalk gate learns each mic's noise.

**Who said it (scenarios).** Each speaker is first transcribed alone (one-mic reference). A sentence belongs to the
speaker whose reference shares more of its content words, in order (`sharedWords`, words of three letters or more);
sentences with fewer than three such words are not judged.

**Fake microphones (UI).** `preload.cjs` replaces the page's `enumerateDevices`/`getUserMedia` with three devices:
`mic-a` "Built-in Microphone" (speaker A, also behind the `default` entry), `mic-b` "AirPods" (speaker B),
`mic-c` "USB Microphone" (third sentence). The test plugs and unplugs them, re-pairs one under a new id, or makes one
report 8 kHz. Clipboard and downloads are captured. Chromium's own test microphones (`--use-fake-device-for-media-stream`)
are silent in this Electron build, so they cannot replace this.

**Statuses.** ✔ pass, ✖ fail, ◌ known limit (expected to fail today; a pass prints a reminder to promote it),
– skipped (with the reason).

## 6. Adding a test

1. Pick the suite: pure logic → `unit.js`; server behaviour → `protocol.js`; speech through a model →
   `scenarios.js`; anything a person sees or clicks → `ui/run.mjs`.
2. Give it an id `AREA-TOPIC-NN` (areas: `UNIT`, `PROT`, `SCN`, `KNOWN`, `UI`, `STATIC`, `SMOKE`). Never reuse an
   id; when a test is removed, keep its row with "removed in <commit>".
3. Write it with `t.check(id, title, ok, detail)`: `title` says what must be true in plain words, `detail` shows the
   measured values, so a failure line explains itself.
4. Use `startServer()` for a server (never port 3000, never the user's folders) and stop it in `finally`.
5. Add its row to §7 with How = `auto`, update §11, run `npm run test:quick` (STATIC-03) and the suite twice: a test
   that passes once and fails once is flaky and must be fixed before it is committed (see `UI-CFG-02` in §10).

## 7. Test catalogue

How: `auto` = run by `run-all.js`; `manual` = steps an agent can do on this computer; `review` = an agent looks at
screenshots or logs; `hardware` = a person with real devices (§9).

### 7.1 Static checks (`run-all.js`)

| Id | Checks | Pass when | How |
|---|---|---|---|
| `STATIC-01` | Syntax of every `.js/.mjs/.cjs` in `lib/ public/ scripts/ desktop/ test/` and `server.js` | `node --check` succeeds for all | auto |
| `STATIC-02` | Installer contents (`package.json` → `build.files`) | includes `server.js`, `lib/**`, `public/**`, `desktop/main.mjs` | auto |
| `STATIC-03` | This plan and the tests agree | every test id in `test/` appears in §7, every `auto` row exists in `test/` | auto |

### 7.2 Logic (`test/unit.js`)

| Id | Checks | Pass when | How |
|---|---|---|---|
| `UNIT-TEXT-01` | Romanian diacritics | cedilla ş ţ Ş Ţ become comma-below ș ț Ș Ț | auto |
| `UNIT-TEXT-02` | Sound tags | `[Muzică]`, `*râde*`, ♪ removed, spaces collapsed | auto |
| `UNIT-TEXT-03` | Missing space after a sentence | `ziua!Mă` → `ziua! Mă`; `S.U.A.` untouched | auto |
| `UNIT-TEXT-04` | Hallucination filter | "Mulțumim pentru vizionare!" dropped, the real sentence before it kept | auto |
| `UNIT-TEXT-05` | Context for the next sentence (Whisper prompt) | ≤ 50 characters, starts and ends on whole words | auto |
| `UNIT-WER-01` | Word error rate | 1 substitution in 3 words = 1/3 | auto |
| `UNIT-WER-02` | Diacritic-blind WER | `fată în casă` = `fata in casa` | auto |
| `UNIT-WER-03` | Shared words (duplicate detection) | 1–2 letter words ignored; count 2, ratio 2/3 on the sample | auto |
| `UNIT-WER-04` | Unrelated sentences | 0 shared words | auto |
| `UNIT-TUNE-01` | Settings from the page are sanitised | clamped to range, snapped to step, unknown keys and non-numbers dropped | auto |
| `UNIT-TUNE-02` | Settings reach the config | all six values (incl. `crosstalkDb`) round-trip | auto |
| `UNIT-TUNE-03` | Every setting has a slider range | `TUNING` has a range for every `tuningFrom` key | auto |
| `UNIT-WAV-01` | WAV encode/decode | 16-bit round trip within 1e-4 | auto |
| `UNIT-WAV-02` | WAV being written | playable with the right length after every chunk | auto |
| `UNIT-SEG-01` | Segmenting speech (loudness detector) | one segment, start ≈ speech − 0.3 s, end ≈ speech + 0.2 s (±0.15 s) | auto |
| `UNIT-SEG-02` | Clicks | 0.1 s of sound is discarded | auto |
| `UNIT-SEG-03` | Very long speech | 25 s of speech becomes 2 segments, the first ≤ 20 s | auto |
| `UNIT-SEG-04` | Stop | `flush()` ends the sentence being spoken | auto |
| `UNIT-SEG-05` | A mic added mid-session | uses the session clock (`startFrame`) and the shared id counter | auto |
| `UNIT-GATE-01` | Crosstalk gate: only A talks, mic 2 hears A 12 dB quieter, 150 ms late | mic 2 keeps fewer frames than a sentence needs (8); mic 1 keeps > 50 % of its speech | auto |
| `UNIT-GATE-02` | Same, mic 2 is 12 dB louder and noisier (−50 dBFS) | mic 2 keeps < 8 frames | auto |
| `UNIT-GATE-03` | Both talk at once (12 dB bleed) | each mic keeps > 30 % of its speech frames | auto |
| `UNIT-GATE-04` | A mic sending digital silence (not connected) | its noise level is not learned; mic 1's is | auto |
| `UNIT-GATE-05` | Speech from the very first moment, louder mic 2 | mic 2 keeps < 8 frames — **known limit** (§10.2) | auto |
| `UNIT-SESS-01` | Same words on both mics at once (stand-in model) | only mic 1 (the clearer) keeps the sentence | auto |
| `UNIT-SESS-02` | Different words at the same time | both mics keep their sentences | auto |
| `UNIT-SESS-03` | Sentence ids with two mics | unique and rising in the order speech started | auto |
| `UNIT-SESS-04` | Identical audio on both mics (same mic picked twice) | one copy, on mic 1 | auto |
| `UNIT-SESS-05` | Files | two mics: `<stamp>-mic1.wav`, `-mic2.wav`, lines `[mm:ss] Mic N: …`; one mic: `<stamp>.wav`, plain lines | auto |

### 7.3 Server and protocol (`test/protocol.js`)

| Id | Checks | Pass when | How |
|---|---|---|---|
| `PROT-STATIC-01` | Page files | every route in `server.js` answers 200 with its content type | auto |
| `PROT-STATIC-02` | New page files are served | every file in `public/` has a route (a new file without one breaks the page) | auto |
| `PROT-STATIC-03` | Unknown paths, POST | 404 | auto |
| `PROT-WS-01` | Messages on connect | `models`, `status` (ready, detector, language), `tuning`, `mics` (max 2) | auto |
| `PROT-WS-02` | Models message | lists models with `installed`/`download`, active = the started model | auto |
| `PROT-WS-03` | Tuning message | values, defaults and ranges for all six sliders | auto |
| `PROT-TUNE-01` | Changing a slider | applied, broadcast, saved to the settings file | auto |
| `PROT-TUNE-02` | Bad slider values | out of range clamped (99 dB → 20), invalid ignored | auto |
| `PROT-TUNE-03` | Reset to defaults | values = defaults; saved tuning removed from the settings file | auto |
| `PROT-WS-04` | Unknown model id, install of an installed model, unknown message | nothing changes, no error | auto |
| `PROT-MIC-01` | 1 → 2 → 1 mics while recording | sentences keep coming in every phase | auto |
| `PROT-MIC-02` | Sentence ids across layouts | unique, rising | auto |
| `PROT-MIC-03` | Stop while both mics talk | both mics' last sentences are finished | auto |
| `PROT-MIC-04` | Save audio with changing layouts | one WAV per mic, never reopened (30.0 s and 14.0 s, ±0.2 s) | auto |
| `PROT-MIC-05` | Transcript file | one line per sentence | auto |
| `PROT-MIC-06` | Clear | starts a new transcript file | auto |
| `PROT-ERR-01` | Broken frames (2 bytes, 0 mics, uneven size, 5 mics), bad JSON | connection stays open, server keeps answering | auto |
| `PROT-ERR-02` | Plain mono client without `?mics` (older clients, `stream-wav.js`) | transcribed, all on mic 0 | auto |
| `PROT-RUN-01` | Port already in use | message "already in use", exit code 1 | auto |
| `PROT-RUN-02` | Ctrl+C mid-sentence | the sentence is transcribed and saved before exit (skipped on Windows) | auto |
| `PROT-MODEL-01` | Choosing another model | loads, status ready with the new model | auto |
| `PROT-MODEL-02` | Model choice after a restart | a server started without `MODEL` uses the saved choice | auto |

### 7.4 End to end (`test/smoke.js`, also in CI)

| Id | Checks | Pass when | How |
|---|---|---|---|
| `SMOKE-01` | Fresh server, model download if missing, the fixture through one mic | the transcript contains "munții" | auto |
| `SMOKE-02` | The fixture as two mics, mic 2 hears it 12 dB quieter and 150 ms late | contains "munții", every sentence on mic 1 | auto |

`run-all.js` reports both as one result (`SMOKE-RUN`); the log has the transcripts.

### 7.5 Two-mic conversations (`test/scenarios.js`)

Common pass condition: no sentence on the wrong mic, no sentence on both mics, plus the extra condition in the row.
"vs reference" in the output is how much a mic's text differs from its speaker transcribed alone.

| Id | Situation | Extra pass condition | How |
|---|---|---|---|
| `SCN-01` | Turn-taking: A, then B answers; B on Bluetooth (150 ms late, +6 dB) | each mic's text ≤ 25 % from its reference | auto |
| `SCN-02` | Both talk at once, lapel mics (12 dB bleed), B on Bluetooth | — | auto |
| `SCN-03` | Both talk at once, table mics (6 dB bleed) | — (accuracy drops here; attribution must not) | auto |
| `SCN-04` | Only A talks; mic 2 is a louder (+12 dB), noisier (−50 dBFS) Bluetooth mic | mic 2 has no sentences; mic 1 ≤ 25 % | auto |
| `SCN-05` | The same audio on both mics | every sentence once (either mic) | auto |
| `SCN-06` | Mic 2 not connected (digital silence) while A talks | mic 2 has no sentences; mic 1 ≤ 25 % | auto |
| `SCN-07` | ~10-minute conversation, ~70 turns, a quarter overlapping by 2 s (`--long`, full tier) | common condition only | auto |
| `SCN-08` | Server memory during `SCN-07` | grows < 60 MB | auto |
| `SCN-ENGINE` | `SCN-01…06` on each engine: Canary (transcribe.cpp), Whisper turbo (whisper.cpp), Parakeet TDT (sherpa-onnx), Jackrabbit (NeMo) (full tier) | as above; skipped if the model is missing | auto |
| `KNOWN-01` | Turn-taking where the close mic is much noisier than the far one (−50 vs −70 dBFS) | — **known limit** (§10.2) | auto |

With `--recordings a.wav,b.wav` the same scenarios run on 60 s of two real voices (full tier when given).

### 7.6 The page (`test/ui/run.mjs`)

| Id | Checks | Pass when | How |
|---|---|---|---|
| `UI-LOAD-01` | Page start | status ready, model menu filled | auto |
| `UI-LOAD-02` | Console | no errors in the page console during the whole run | auto |
| `UI-MIC-01` | Default layout | Mic 1 + Mic 2 menus, Mic 2 = None, one unlabelled meter | auto |
| `UI-MIC-02` | Same mic twice is prevented | the device behind "System default" is greyed out in Mic 2 | auto |
| `UI-1MIC-01` | One mic | lines without mic name or colour | auto |
| `UI-1MIC-02` | One mic, Copy | plain lines, no "Mic N:" | auto |
| `UI-TX-01` | Clear | transcript empty, Copy disabled, file label cleared | auto |
| `UI-MIC-03` | Choosing Mic 2 | coloured dots, two labelled meters, Mic separation slider enabled | auto |
| `UI-MIC-04` | Recording two mics | both meters move | auto |
| `UI-TX-02` | Live text | grey live lines from both mics at once, each in its mic colour | auto |
| `UI-TX-03` | Final lines | "Mic N" label and colour per mic, both mics present | auto |
| `UI-TX-04` | Simultaneous speech | lines marked ⇄ | auto |
| `UI-TX-05` | Copy and Download with two mics | `Mic N: …` and `[mm:ss] Mic N: …` lines | auto |
| `UI-PROJ-01` | Caption window (`/?display`) | shows the lines in their mic colours | auto |
| `UI-PROJ-02` | Projector view | coloured lines; T changes colours, + text size, L number of sentences | auto |
| `UI-PROJ-03` | Leaving the projector | Esc hides it | auto |
| `UI-SET-01` | Settings drawer | slider change applied and marked, Reset restores 0.7 s, one meter per mic | auto |
| `UI-DEV-01` | A chosen mic that is off | shown as "AirPods (not connected)" | auto |
| `UI-DEV-02` | Start with Mic 2 off | recording, Mic 2 "not connected", warning naming it | auto |
| `UI-DEV-03` | Mic 2 switched on | joins, warning disappears | auto |
| `UI-DEV-04` | The late mic | transcribed under Mic 2 | auto |
| `UI-DEV-05` | Unplugged while recording | "not connected", warning, mic 1 keeps recording | auto |
| `UI-DEV-06` | The only mic missing | clear message, not recording | auto |
| `UI-DEV-07` | Changing Mic 2 while recording | keeps recording, two meters | auto |
| `UI-DEV-08` | Mic 2 → None while recording | one unlabelled meter | auto |
| `UI-DEV-09` | A mic recording at 8 kHz | warning "less accurate" | auto |
| `UI-DEV-10` | Reload | mic choices remembered | auto |
| `UI-DEV-11` | Re-paired Bluetooth mic (new id, same name) | found again by name | auto |
| `UI-NET-01` | Server restarted mid-recording | page reconnects, buffered audio transcribed on the right mics | auto |
| `UI-LOOK-01` | Phone width (390 px) | no sideways scrolling | auto |
| `UI-CFG-01` | `MAX_MICS=1` | one "Microphone" menu, the page as before two mics existed | auto |
| `UI-CFG-02` | `MAX_MICS=3` | third menu, three mics record, Mic 3 has its own lines | auto |
| `UI-CFG-03` | `VAD=energy` | the Silero threshold slider is greyed out | auto |
| `UI-MODEL-01` | A model not downloaded | menu shows its download size; choosing it asks first; No changes nothing | auto |

## 8. Checks not automated yet

Do these when the area changes, and in every full run where noted. Record the outcome in the run's row in §12.

### 8.1 Visual review of the UI screenshots (every full run) — `review`

Open `test-results/<run>/screenshots/` and check:

| Id | Screenshot | Look for |
|---|---|---|
| VIS-01 | `two-mics-live.png`, `two-mics-final.png` | Mic 1 blue and Mic 2 orange are easy to tell apart; live text is a lighter shade of the mic colour; ⇄ next to simultaneous lines |
| VIS-02 | `light.png` | the same in light mode; text readable on white |
| VIS-03 | `projector.png`, `caption-window.png` | large centred text, colours per mic, older lines dimmer but readable |
| VIS-04 | `settings.png` | drawer with a meter per mic and the Mic separation slider with its hint |
| VIS-05 | `mic-disconnected.png` | red "not connected" next to Mic 2, warning above the transcript |
| VIS-06 | `phone.png` | everything reachable at 390 px, nothing cut off |

### 8.2 Desktop app — `manual`

| Id | Steps | Pass when |
|---|---|---|
| DESK-01 | `LT_TEST=1 SETTINGS_FILE=<tmp>/s.json TRANSCRIPTS_DIR=<tmp>/t env -u ELECTRON_RUN_AS_NODE npm run app`; wait 15 s; read `~/Library/Application Support/<app>/logs/server.log` (the app's log, append-only) | the log shows "ready"; quit with Ctrl+C |
| DESK-02 | GitHub Actions → *Desktop app* → Run workflow (only when the user asks) | both jobs green (smoke test on macOS and Windows), `.dmg` and `.exe` artifacts present |
| DESK-03 | First run downloads the default model: `MODELS_DIR=<empty tmp>` with DESK-01 | the page shows download progress, then ready |
| DESK-04 | Caption window with a second display (person) | opens on the other display, full screen |
| DESK-05 | Second launch while running | focuses the existing window |
| DESK-06 | macOS microphone permission denied (person) | the page explains how to allow it |
| DESK-07 | File / Help menu items | open the transcripts, logs and models folders |
| DESK-08 | Quit while someone speaks (person) | the last sentence is in the transcript file |

The desktop window runs the page sandboxed with context isolation; the UI suite runs it without (for the fake
mics). The page uses neither Node nor the preload, so this difference matters only if that changes.

### 8.3 Tools, engines and Docker — `manual`

| Id | Steps | Pass when |
|---|---|---|
| TOOL-01 | `npm run setup -- --list` | every model listed with installed status |
| TOOL-02 | `npm run compare -- <tmp copy of test/fixtures/ro.wav> --models parakeet-ro-110m`, then delete `transcripts/<name>.compare.md` | a table with speed per model |
| TOOL-03 | `npm run benchmark -- --models parakeet-ro-110m --limit 20 --name test-run` (downloads FLEURS ~500 MB the first time; ask before) | WER in the published range; delete `benchmarks/results/test-run*` afterwards |
| ENG-01 | Kill `whisper-server` while a Whisper model is loaded and a server is running | the server restarts it (at most 3 times a minute) and keeps transcribing |
| ENG-02 | Switch models several times while recording | old model unloaded (memory returns), no lost sentences beyond the switch moment |
| DOCK-01 | `docker compose up -d --build` (slow; ask before) | page on `127.0.0.1:3000`, Whisper marked "slow in Docker", stop saves the last sentence |

### 8.4 Performance — `review`

| Id | Where | Pass when |
|---|---|---|
| PERF-01 | the `model time per sentence` line at the end of each `scenarios*.log` | median within the README's table: Parakeet 110M < 100 ms, Canary < 300 ms, Whisper turbo < 1.5 s |
| PERF-02 | `SCN-08` | memory flat over 10 minutes |
| PERF-03 | suite durations in `summary.md` vs §4 budgets | no suite 3× slower than its budget |
| PERF-04 | `[mics]` lines (DEBUG) in the scenarios log | noise levels learned within a few seconds; "kept" close to "speech" for the speaking mic |

## 9. Hardware checklist (people, with real microphones)

Run when microphone, audio, crosstalk or desktop code changed, and before a release. The agent prepares it, a person
runs it, and the agent analyses the recordings.

**Setup:** `DEBUG=1 npm start` in a terminal (keep its output), open the page, turn on **Save audio**, choose the
devices. Note the devices (name, type: built-in / USB / jack / Bluetooth / wireless kit), the room, and the
distances.

| Id | Do | Expect |
|---|---|---|
| HW-01 | One mic only, talk normally | text as before two mics existed, no labels |
| HW-02 | Two mics, each person talks alone for 30 s | every line under the speaker's own mic and colour |
| HW-03 | Take turns, short and long | each turn on the right mic; nothing duplicated |
| HW-04 | Talk over each other for 10–20 s | both people's lines, marked ⇄; some accuracy loss is expected |
| HW-05 | One person talks for ~1 minute without pause | nothing appears under the other mic |
| HW-06 | Switch the Bluetooth mic off, then on again, while recording | "not connected" + warning, the other mic keeps going, it rejoins by itself |
| HW-07 | Unplug and replug a USB/jack mic while recording | same as HW-06 |
| HW-08 | Try to pick the same mic for Mic 1 and Mic 2 | not possible (greyed out) |
| HW-09 | An older Bluetooth headset (call mode) | 8 kHz warning if it records at 8 kHz |
| HW-10 | Noise suppression on vs off in a noisy room | note which attributes better |
| HW-11 | A 30–60 minute meeting | no freeze, no drift between the mics (lines keep their order), memory stable |
| HW-12 | Desktop app on Mac and on Windows, with the projector on a second screen | as above; captions coloured on the projector |
| HW-13 | Pressing Stop while both talk | both last sentences saved |

**Data to collect:** the transcript `.txt`, the two WAVs (`<stamp>-mic1.wav`, `<stamp>-mic2.wav`), the terminal
output (the `[mics]` lines every 10 s), and what went wrong with the time it happened.

**Agent analysis of a hardware session** (recordings stay on this computer):

1. Replay exactly what the server heard:
   `npm run test:wav -- transcripts/<stamp>-mic1.wav --mic2 transcripts/<stamp>-mic2.wav` against a test server
   (`startServer` or `PORT=<free> DEBUG=1 SETTINGS_FILE=<tmp> TRANSCRIPTS_DIR=<tmp> npm start`).
2. Compare with the session's `.txt`; find the wrong-mic or duplicated lines and their times.
3. Read the `[mics]` lines around those times: each mic's noise level and how much speech was kept. A mic that
   keeps speech while the other person talks means the gate needs the other mic to be clearer than the separation
   (raise/lower **Mic separation** and replay to confirm).
4. If a change is needed, reproduce it as a scenario (two real voices with the measured bleed, noise, lag and gain
   in `twoMics`) and add it to §7.5 before fixing, so it stays fixed.

## 10. When a test fails

### 10.1 Procedure

1. **Reproduce** with the smallest run: `node test/<suite>.js` or `--only <id>` (scenarios), twice. A failure that
   does not repeat is still a finding: record it as flaky with what you saw.
2. **Decide whether the product or the test is wrong**, with evidence (traces, levels, logs), not by reasoning alone.
   Real examples from this project:
   - product bug: a mic sending digital silence was learned as a −66 dB noise floor, so a Bluetooth mic that started
     late "stole" the other person's sentences (found by a scenario, fixed in `ca62a61`, now `UNIT-GATE-04`, `SCN-06`);
   - product bug: the same audio on two mics kept both copies (no tie-break; now `UNIT-SESS-04`, `SCN-05`);
   - test bug: a test streamed past the end of a 7-second clip and expected new sentences from silence;
   - test bug: two fake mics played the same clip, so which one kept the sentence was a coin flip (`UI-CFG-02`);
   - test bug: `session.close()` silences messages by design; the test must `flush()` first.
3. **Fix** on a branch. For a product bug, add a test that fails without the fix (new id, row in §7) before or with
   the fix.
4. **Record** it in §12 (and §13 if the plan changed).

Useful tools: `DEBUG=1` server logs (`[final #n mic m] … ms: text`, `dropped, another mic heard it more clearly`,
`[mics] …`); `sample <pid> 3` (macOS) for a server that stops answering; the gate can be traced offline by running
`Segmenter.analyze()` + `CrosstalkGate.push()` over two WAVs (see `gate()` in `test/unit.js`).

### 10.2 Known limits (tracked, do not fail a run)

| Id | Limit | Why | What would change it |
|---|---|---|---|
| `KNOWN-01` | When the person's own mic is much noisier than a clean mic farther away, their sentences can go to the clean mic (wrong colour, text kept) | The gate compares each mic's level above its own noise; a far mic turned up by auto gain (`SCN-04`) and a noisy close mic look the same in levels alone | Learning the level difference between the two mics once both people have spoken; hardware data first (§9) |
| `UNIT-GATE-05` | Before the first moment of silence, the gate can only compare raw volume, so a much louder mic wins | No noise level learned yet | The same learning as `KNOWN-01`, or a short calibration at Start |
| — | Table mics with simultaneous speech: the model's accuracy drops (`SCN-03`: 20–50 % from the reference) | Each mic really contains both voices | Not a gate problem; better mic placement |
| — | Killing the server mid-sentence loses what it had received of that sentence | The server is gone; the page only buffers audio sent while disconnected | Accepted |
| — | Chromium's built-in fake microphones are silent in Electron | Electron build | The UI suite uses `preload.cjs`; real capture is covered by §9 |
| — | On 2026-10-31 a scenario run stopped producing sentences for ~8 minutes, twice, then continued; not reproduced in 19+ runs since | Unknown | If a stream times out: keep the server running, `sample <pid> 3`, save its log, and record it in §12 |

## 11. Coverage map

| Feature | Covered by | Gaps |
|---|---|---|
| Transcription, one mic | `SMOKE-01`, `PROT-ERR-02`, `UI-1MIC-01`, `SCN-*` references | — |
| Live guesses (grey text) | `UI-TX-02`, scenario logs | timing of live guesses not asserted |
| Text cleanup (diacritics, tags, hallucinations) | `UNIT-TEXT-*` | — |
| Whisper context from previous text | `UNIT-TEXT-05`, `SCN-ENGINE` (Whisper) | effect on accuracy not asserted |
| Voice detection (Silero, loudness fallback) | `UNIT-SEG-*`, `UI-CFG-03`, all server suites | Silero threshold slider effect not asserted |
| Segmenting (pause, lead-in, clicks, long speech) | `UNIT-SEG-01…05` | — |
| Live settings and their saving | `UNIT-TUNE-*`, `PROT-TUNE-*`, `UI-SET-01` | — |
| Models: list, choose, remember, download prompt | `PROT-WS-02`, `PROT-MODEL-*`, `UI-MODEL-01` | real download path (network) only via `SMOKE-01` in CI |
| Engines (transcribe.cpp, whisper.cpp, sherpa-onnx, NeMo) | `SCN-ENGINE`, `PROT-MODEL-*` | crash recovery (`ENG-01`) manual |
| Transcript and audio files | `UNIT-SESS-05`, `PROT-MIC-04…06`, `PROT-RUN-02` | — |
| Reconnect and buffering | `UI-NET-01` | buffer limit (5 minutes) not asserted |
| Projector view, caption window | `UI-PROJ-*`, `VIS-03` | full screen, idle hiding of controls |
| Two mics: choosing, labels, colours | `UI-MIC-*`, `UI-TX-02…05`, `UI-CFG-01/02`, `VIS-01` | — |
| Two mics: crosstalk gate and duplicates | `UNIT-GATE-*`, `UNIT-SESS-*`, `SCN-01…08`, `SMOKE-02` | `KNOWN-01`, real rooms (§9) |
| Two mics: devices coming and going, 8 kHz | `UI-DEV-*`, `SCN-06` | real Bluetooth (`HW-06`) |
| Desktop app | `STATIC-02`, CI smoke, `DESK-*` | packaged app UI not automated |
| Docker | `DOCK-01` | manual only |
| Wake lock (screen stays on), Noise suppression checkbox | — | not tested |
| Browsers other than Chromium (Safari, Firefox) | — | not tested; Safari may allow one mic only |
| Accessibility (keyboard, screen readers) | projector keys in `UI-PROJ-02` | not tested |

## 12. Run history

Add one row per run on `main` (§3 step 5), newest first. Feature-branch runs go here only when they found something.

| Date | Commit | Branch | Tier | Result | ✔ / ✖ / ◌ / – | Notes |
|---|---|---|---|---|---|---|
| 2026-10-31 | `ca62a61` + this plan (uncommitted) | feature/testing-plan | full | PASS | 120 / 0 / 6 / 0 | Baseline, first run of the plan. 12 min on an M5. All four engines ran. Known limits as expected: `UNIT-GATE-05` once, `KNOWN-01` on every engine. `SCN-08` 240 → 259 MB. VIS-01 and VIS-04 reviewed, fine. PERF-01 was not readable from the logs, so `scenarios.js` now prints a timing line (Parakeet 110M median 33 ms). |
| 2026-10-31 | `ca62a61` + this plan (uncommitted) | feature/testing-plan | standard | PASS | 94 / 0 / 2 / 0 | 3 min. |

## 13. Plan change log

| Date | Change |
|---|---|
| 2026-10-31 | Plan created, covering the app up to `ca62a61` (two microphones). Test tooling added: `run-all.js`, `helpers.js`, `unit.js`, `protocol.js`, `scenarios.js`, `ui/`. |
| 2026-10-31 | After the baseline run: time budgets measured (full tier ~12 min, not 40); PERF-01 reads the new timing line from the scenario logs. |
