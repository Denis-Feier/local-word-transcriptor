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
npm run test:stress         # stress tier (§14), ~4.5 h: hours-long meetings and failures; before a release. --short ~25 min
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
   streaming tests. Do not run a UI suite and a scenario suite in parallel. The one exception is the stress tier,
   whose lanes run in parallel on purpose (§14.1); never run another tier at the same time as it.
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

**Before a release (version tag)**

8. Run the stress tier on `main` (`npm run test:stress`, §14.4) and record it in §12. A FAIL blocks the release unless
   the user accepts it.

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
| macOS `say` with the Romanian voice *Ioana* | stress tier: the voiced sentence bank (§14.2); without it the fixture's three sentences | built into macOS (System Settings → Accessibility → Spoken Content → System voice → Manage voices) |
| `hdiutil` (macOS), ~3 GB free disk | stress tier: `STRESS-DISK-01`; WAVs of hours-long meetings | built in |

Other systems: CI (`.github/workflows/desktop.yml`) runs `test/smoke.js` on macOS and Windows before building the
installers. The other suites are written for macOS; on Windows `PROT-RUN-02` (no SIGINT) and `PROT-ERR-03` (no
`ulimit`) are skipped and `SCN-08` uses `ps` (macOS/Linux only).

Time budgets (Apple M5): static < 5 s, unit ~1 s, protocol ~25 s, smoke ~40 s, scenarios ~70 s, UI ~50 s,
engines 1–3 min each, long conversation ~2 min; standard tier ~3 min, full tier ~12 min. A suite taking 3× its
budget is a finding even if it passes. Stress tier (§14.1): ~4.5 h (phase A ~2 h in two parallel lanes, phase
B ~2.5 h alone); measured: the 4-hour meeting 30 min at 8×, `PAGE` 5 min, the failure groups 25 min; `--short` ~25 min.

## 5. How the tests are built

| File | Role |
|---|---|
| `test/run-all.js` | Runs the tiers, the static checks (`STATIC-*`) and writes the report |
| `test/helpers.js` | Isolated server per test (`startServer`; `maxFileBlocks` caps its files with `ulimit -f`, like a full disk), streaming client (`streamWav`), test speakers, two-mic room simulator (`twoMics`), result bookkeeping (`suite`) |
| `test/unit.js` | Logic without a speech model (`UNIT-*`) |
| `test/protocol.js` | The server as clients use it (`PROT-*`) |
| `test/smoke.js` | End to end on any OS, downloads the model if needed; CI runs it (`SMOKE-*`) |
| `test/stream-wav.js` | Streams WAV files to a server like the page does: one mic, or two with `--mic2`, `--bleed`, `--lag`, `--gain2`, `--only-mic`; also used by people to replay recordings |
| `test/scenarios.js` | Two-mic conversations through the real model (`SCN-*`, `KNOWN-*`) |
| `test/ui/run.mjs` + `test/ui/preload.cjs` | The page in Electron's Chromium with fake microphones (`UI-*`) |
| `test/fixtures/ro.wav` | 16 s of clean synthetic Romanian speech, three sentences, silence at −88 dBFS |
| `test/meeting.js` | The synthetic meeting for the stress tier: script, N-mic room, ground truth, streaming and WAV output (§14.2) |
| `test/stress.js`, `test/ui/stress.mjs` | The stress tier: server-side groups (`--group meet`, `mic3`, `load`, `cap`, `eng`, `conn,conc,tune,disk`) and the page's groups in Electron (`page`, `soak`, `net`) (`STRESS-*`, §14) |
| `test/fixtures/meeting-ro.txt` | The stress tier's sentence bank: text only, voiced on the test computer |

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
report 8 kHz. It also lists two outputs, `out-laptop` "MacBook Pro Speakers" and `out-bt` "Party Speaker", and records
each mic the page opens with its auto-gain request (`window.__mics`). An output the page picks plays to a silent sink
(`setSinkId({ type: 'none' })`), so a test run never makes sound on this computer. `window.__speakerLevel()` measures
what it would have played. Clipboard and downloads are captured. Chromium's own test microphones
(`--use-fake-device-for-media-stream`) are silent in this Electron build, so they cannot replace this.
`scripts/manual.mjs` reuses `preload.cjs` (with its own device names, through `sessionStorage.__fake`) for the user
manual's screenshots; after changing the preload, run `npm run manual` to check that it still works.

**Statuses.** ✔ pass, ✖ fail, ◌ known limit (expected to fail today; a pass prints a reminder to promote it),
– skipped (with the reason).

## 6. Adding a test

1. Pick the suite: pure logic → `unit.js`; server behaviour → `protocol.js`; speech through a model →
   `scenarios.js`; anything a person sees or clicks → `ui/run.mjs`.
2. Give it an id `AREA-TOPIC-NN` (areas: `UNIT`, `PROT`, `SCN`, `KNOWN`, `UI`, `STATIC`, `SMOKE`, `STRESS`). Write
   ids in full in the code: STATIC-03 reads any `AREA-NAME` as an id, so refer to a group as `STRESS-<GROUP>`. Never reuse an
   id; when a test is removed, keep its row with "removed in <commit>".
3. Write it with `t.check(id, title, ok, detail)`: `title` says what must be true in plain words, `detail` shows the
   measured values, so a failure line explains itself.
4. Use `startServer()` for a server (never port 3000, never the user's folders) and stop it in `finally`.
5. Add its row to §7 with How = `auto`, update §11, run `npm run test:quick` (STATIC-03) and the suite twice: a test
   that passes once and fails once is flaky and must be fixed before it is committed (see `UI-CFG-02` in §10).

## 7. Test catalogue

How: `auto` = run by `run-all.js`; `manual` = steps an agent can do on this computer; `review` = an agent looks at
screenshots or logs; `hardware` = a person with real devices (§9); `planned` = designed but not written yet, becomes
`auto` when its test exists (STATIC-03 does not check `planned` rows).

### 7.1 Static checks (`run-all.js`)

| Id | Checks | Pass when | How |
|---|---|---|---|
| `STATIC-01` | Syntax of every `.js/.mjs/.cjs` in `lib/ public/ scripts/ desktop/ test/` and `server.js` | `node --check` succeeds for all | auto |
| `STATIC-02` | Installer contents (`package.json` → `build.files`) | includes `server.js`, `lib/**`, `public/**`, `desktop/main.mjs` | auto |
| `STATIC-03` | This plan and the tests agree | every test id in `test/` appears in §7, every `auto` row exists in `test/` | auto |
| `STATIC-04` | Page files are served | every file in `public/` is in `server.js`'s list (a missing one breaks the page with no error) | auto |
| `STATIC-05` | User manual is current and packaged | `docs/manual/manual.json` has `package.json`'s version (a version bump needs `npm run manual` / the user-manual skill), both PDFs exist, `build.files` includes `docs/manual/*.pdf` | auto |

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
| `UNIT-WAV-03` | The disk fills up while a WAV is written ([#1](https://github.com/Denis-Feier/local-word-transcriptor/issues/1)): a stand-in disk with room for 12,345½ samples, which cuts the last write short and fails the next one, as a real disk does | the chunk that does not fit throws `ENOSPC`; the header counts the 12,345 whole samples written; once there is room again the file carries on (without the fix: the error a chunk late, the header 12,800 samples) | auto |
| `UNIT-WAV-04` | A WAV started on a full disk | `ENOSPC`, and the file is not left open (without the fix it is) | auto |
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
| `UNIT-SESS-06` | Changing the mics keeps the clock ([#8](https://github.com/Denis-Feier/local-word-transcriptor/issues/8)): 1 ↔ 2 mics 11 times in 1600-sample chunks, 448 samples unframed at each change (loudness detector, no Silero needed) | after every chunk, on every mic, frames × 512 + unframed samples = the audio sent (0 samples behind; without the fix 4,928) | auto |
| `UNIT-SESS-07` | A sentence after those 11 changes, on mic 1 and on mic 2 | starts within half a frame of the same run with two mics from the start (without the fix 0.32 s early) | auto |
| `UNIT-SESS-08` | Save audio with two mics; the disk fills at 8 s of 24 s, a sentence every 4 s ([#1](https://github.com/Denis-Feier/local-word-transcriptor/issues/1); loudness detector, stand-in model, the stand-in disk of `UNIT-WAV-03`) | `audio()` never throws; one "Could not save audio" error; all 6 sentences, 4 of them after the disk filled; both WAVs playable up to 8 s (without the fix `audio()` throws at 8 s and nothing after it is transcribed) | auto |

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
| `PROT-ERR-03` | The disk fills up while Save audio is on ([#1](https://github.com/Denis-Feier/local-word-transcriptor/issues/1)): no file may grow past 300 blocks (`ulimit -f` in `sh`: 1,024 bytes each on macOS, 512 on Linux), so the WAV is full at 9.6 s of 40 s (Linux 4.8 s); skipped on Windows | the server stays up, keeps transcribing (≥ 2 sentences after the WAV filled; 3 on macOS, 4 on Linux) and saving the `.txt`; the page gets one error, "Could not save audio"; the WAV's header matches its data (without the fix the server exits when the WAV fills) | auto |
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
| `UI-SPK-01` | Speaker menu | None, System default and each output; starts at None, no volume slider, nothing playing | auto |
| `UI-SPK-02` | Choosing a speaker | plays the mic on that output at once, before Start (level > −50 dBFS); the speaker's mic stream asks for no auto gain; volume slider shown | auto |
| `UI-SPK-03` | Mic 2 chosen while the speaker plays | the speaker reopens with both mics | auto |
| `UI-SPK-04` | Start and Stop | the speaker keeps playing through both | auto |
| `UI-SPK-05` | Another output, volume 0 | the sound moves to the new output; volume 0 is silent (< −90 dBFS) | auto |
| `UI-SPK-06` | Reload | speaker back at None, volume remembered | auto |
| `UI-SPK-07` | Speaker switched off | stops playing (no fallback to the laptop), "Party Speaker (not connected)", warning | auto |
| `UI-SPK-08` | Speaker back under a new id (re-paired) | found by name, plays again, warning gone | auto |
| `UI-SPK-09` | Speaker → None | playing stops, volume slider hidden, the meters (moving before) back to zero | auto |
| `UI-SPK-10` | Sound check before Start | the meter moves while only the speaker plays | auto |
| `UI-NET-01` | Server restarted mid-recording | page reconnects, buffered audio transcribed on the right mics | auto |
| `UI-LOOK-01` | Phone width (390 px) | no sideways scrolling | auto |
| `UI-CFG-01` | `MAX_MICS=1` | one "Microphone" menu, the page as before two mics existed | auto |
| `UI-CFG-02` | `MAX_MICS=3` | third menu, three mics record, Mic 3 has its own lines | auto |
| `UI-CFG-03` | `VAD=energy` | the Silero threshold slider is greyed out | auto |
| `UI-MODEL-01` | A model not downloaded | menu shows its download size; choosing it asks first; No changes nothing | auto |

### 7.7 Stress: long meetings (`test/stress.js`, `test/ui/stress.mjs`, design in §14)

Run with `npm run test:stress` before a release (§14.4); it is not part of the other tiers. Meeting blocks (R, R′, 1–9)
and terms (wrong mic, caught, delay) are defined in §14.2 and §14.3. Thresholds are starting values until the baseline
(§14.3). Cases marked (D1)–(D4) wait for a decision (§14.6) and run as known limits until then. `--short` runs `MEET`
on a 34-minute meeting, `PAGE` with 1,000 lines, the failure groups smaller, `LOAD` on 10 minutes, and skips `SOAK`,
`MIC3`, `CAP`, `ENG` and `NET-02`.

| Id | Checks | Pass when | How |
|---|---|---|---|
| `STRESS-MEET-01` | 4-hour meeting, 2 mics, at 8× (Parakeet 110M): attribution | no wrong-mic or both-mic line in blocks 1, 3, 5, 9; ≤ 1 % of lines in blocks 2, 4, 6, 7, 8 | auto |
| `STRESS-MEET-02` | Nothing lost | ≥ 98 % of solo utterances caught, ≥ 90 % of overlapped ones (not counting a person whose mic is dropped out) | auto |
| `STRESS-MEET-03` | No phantom lines | 0 lines in silence, in the break, and from the transients | auto |
| `STRESS-MEET-04` | Accuracy holds over the hours | WER in R′ ≤ WER in R + 2 points | auto |
| `STRESS-MEET-05` | No clock drift | median clock offset of every block within 0.1 s of R's (dropouts, layout changes and Clear included) | auto |
| `STRESS-MEET-06` | Keeps up | delay p95 in R′ ≤ 1.25 × R's + 0.3 s; median model time per sentence in R′ ≤ 1.25 × R's | auto |
| `STRESS-MEET-07` | Live text to the end | live guesses in R′ ≥ 80 % of R's | auto |
| `STRESS-MEET-08` | Server memory | after the first 30 min: grows ≤ 50 MB in total, trend ≤ 10 MB per meeting hour | auto |
| `STRESS-MEET-09` | Files | `.txt` lines = published lines, `[h:mm:ss]` after the first hour, times never go back on a mic; each WAV = the audio sent for its mic ± 0.1 s with a correct header; after Clear a new `.txt` and new WAVs, none reopened | auto |
| `STRESS-MEET-10` | Server responsive | a page file and a WebSocket ping answered within 500 ms throughout | auto |
| `STRESS-MEET-11` | The 20-minute presentation (block 3) | cut into pieces ≤ 20 s; nothing on mic 2 except its questions; WER ≤ R's + 3 points | auto |
| `STRESS-MEET-12` | Resources released | after the client leaves, the server's open files are back to its baseline (± 2) | auto |
| `STRESS-MIC3-01` | 2-hour meeting, 3 mics (`MAX_MICS=3`): attribution, nothing lost, no phantoms | as `STRESS-MEET-01…03` | auto |
| `STRESS-MIC3-02` | 3 mics: clock, keeping up, memory | as `STRESS-MEET-05`, `06`, `08` | auto |
| `STRESS-SOAK-01` | 2 hours in real time through the page (Canary, Save audio, caption window): no audio lost between page and server | each saved WAV = the recording time ± 2 s | auto |
| `STRESS-SOAK-02` | Lines keep coming | every 10-min window catches ≥ 95 % of its utterances, with no wrong-mic line | auto |
| `STRESS-SOAK-03` | The delay people see | speech end → final line on the page: p95 ≤ 2 s in every window; last window ≤ first + 0.5 s | auto |
| `STRESS-SOAK-04` | Page memory | after the first 30 min, the page's process grows ≤ 30 MB per hour | auto |
| `STRESS-SOAK-05` | Caption window after 2 hours | shows the newest line within 1 s of the page | auto |
| `STRESS-SOAK-06` | Server memory in real time | as `STRESS-MEET-08` | auto |
| `STRESS-SOAK-07` | Stop after 2 hours | the last sentence is in the `.txt`; Download has the same lines; no console error and no error banner during the run | auto |
| `STRESS-PAGE-01` | 5,000 lines (≈ 6 hours) with their live guesses, from a fake server at 25 lines/s | the time per message for the last 500 ≤ 2 × the first 500's; longest main-thread task ≤ 200 ms | auto |
| `STRESS-PAGE-02` | All lines shown | 5,000 in order, hour times (`1:00:00`), ⇄ marks right | auto |
| `STRESS-PAGE-03` | Copy and Download with 5,000 lines | done within 1 s, every line, `[h:mm:ss]` | auto |
| `STRESS-PAGE-04` | Reading back | someone scrolled an hour back stays there while 300 lines arrive; at the bottom the page follows | auto |
| `STRESS-PAGE-05` | Projector view and caption window at line 5,000 | the newest line shown within 300 ms | auto |
| `STRESS-PAGE-06` | A catch-up burst: 500 lines at once | longest task ≤ 500 ms; a click handled within 200 ms after it | auto |
| `STRESS-PAGE-07` | Clear with 5,000 lines | done within 300 ms; page memory back within 20 MB of the start | auto |
| `STRESS-PAGE-08` | The page's console during the whole `PAGE` run | no errors | auto |
| `STRESS-LOAD-01` | Overload: 60 min of dense meeting sent as fast as the server takes it, on Parakeet 110M and (20 min) on Canary | the server stays up and answers within 1 s | auto |
| `STRESS-LOAD-02` | Nothing lost under overload | every sentence started gets exactly one final, in order; the `.txt` has every line | auto |
| `STRESS-LOAD-03` | Recovery: the same overload again | the second overload ends at most 50 MB above the first | auto |
| `STRESS-LOAD-04` | (D1) The page is told when transcription falls behind | as decided | auto |
| `STRESS-CAP-01` | Each installed model (`--models a,b` for some): block R at 2× real time, alone | it keeps up: median delay of the last 5 min ≤ the first 5 min's + 2 s, the model busy ≤ 80 % of the time, every sentence finished. Required of the default model (Canary) and Parakeet 110M; another model that cannot keep up is a known limit (◌) to note in the README's model table. Table in `stress/capacity.md` | auto |
| `STRESS-CONN-01` | 200 connections opened and closed, a quarter mid-sentence, some with Save audio | open files back to the baseline ± 2; memory ≤ +30 MB; the server still answers | auto |
| `STRESS-CONN-02` | Sentences cut off by a closing connection | every one is in a transcript file | auto |
| `STRESS-CONC-01` | Three recording clients for 20 min at once | each gets only its own lines; delay p95 ≤ 2 × a single client's | auto |
| `STRESS-CONC-02` | Two recordings starting in the same second | separate `.txt` and WAV files, neither corrupted (§14.5 #2) | auto |
| `STRESS-TUNE-01` | 500 slider changes during a 30-min meeting, the Silero threshold included | memory ≤ +30 MB; the last values applied and saved; the settings file is valid JSON | auto |
| `STRESS-NET-01` | (D2) Server killed (`kill -9`) and restarted at 10, 25 and 40 min of a 72-min recording through the page (outages of 5 s, 60 s, 4 min) | the page reconnects and its buffered audio is transcribed; every line shown before a kill is in a `.txt`; WAVs play up to the kill | auto |
| `STRESS-NET-02` | (D3) An outage of 7 min at 58 min, longer than the page's buffer | the page keeps recording; what is kept matches the decision | auto |
| `STRESS-ENG-01` | The model process killed at 4, 9 and 14 min of a 20-min meeting at 2× (Whisper turbo; Jackrabbit/NeMo) | back within 30 s each time; no sentence lost | auto |
| `STRESS-ENG-02` | (D4) Killed 4 times within a minute | as decided | auto |
| `STRESS-ENG-03` | Model switched 4 times during a meeting | no line lost; memory back within 100 MB once the first model is back | auto |
| `STRESS-DISK-01` | Save audio on a 20 MB disk that fills mid-meeting (macOS disk image) | the server keeps running and transcribing; the page gets one "Could not save audio" error | auto |
| `STRESS-DISK-02` | The transcripts folder disappears mid-meeting (a drive unplugged) | the server keeps transcribing and the lines keep coming; the page gets an error | auto |

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
| VIS-07 | `speaker.png`, `speaker-disconnected.png` | Speaker menu and Volume slider in the settings row, the meter moving before Start; "(not connected)" in the menu and the warning above the transcript |

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
| DESK-09 | The desktop window (sandboxed, the app's permission rules) can pick an output: Electron with `--use-fake-device-for-media-stream`, `enumerateDevices()` + `AudioContext.setSinkId(<output id>)`, no sound played | outputs listed with names, `setSinkId` succeeds, an unknown id fails with `NotFoundError` |
| DESK-10 | Help → *User manual* (`npm run app`, or the packaged app) | opens `Live-Transcriber-Manual-RO.pdf` when the system language is Romanian, `-EN.pdf` otherwise, in the system's PDF viewer |

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
| HW-14 | **Speaker** on a jack or USB speaker, before Start; talk into the mic | heard at once from the speaker; the talker hears no echo; the meter moves |
| HW-15 | The same with a Bluetooth speaker | note the delay the talker hears (expected ~0.2 s) and whether it bothers them |
| HW-16 | Raise **Volume** with the speaker behind the mics, then in front of them facing away | note the volume at which it howls in each place; turning it down stops the howl |
| HW-17 | Two mics with the speaker playing: each person alone, then taking turns (HW-02/03 again) | lines under the right mic as without the speaker; note any line under the wrong mic and where the speaker stood |
| HW-18 | Switch the Bluetooth speaker off, then on again, while it plays | silent, "not connected" + warning, nothing from the laptop's speakers; plays again by itself |
| HW-19 | Start transcribing while the speaker plays, then turn the speaker on while transcribing | the text is as accurate as without the speaker; note whether the speaker gets louder in pauses (auto gain, see §10.2) |
| HW-20 | A Bluetooth speaker with its own microphone, Mic 1 on *System default* | note whether the Mac switches its input to the speaker (call quality); with the real mic chosen it must not |
| HW-21 | A real meeting of 2 hours or more in the desktop app: two mics (one Bluetooth), Save audio, the caption window on a projector; the human counterpart of the stress tier (§14) | no freeze; the text keeps up (note the delay at the start and at the end); the app's memory in Activity Monitor at the start, after 1 hour and at the end; files complete |

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
4. **Record** it in §12 (and §13 if the plan changed). A product bug that is not fixed in the same branch gets a GitHub
   issue (`gh issue create`, label `bug`; a product decision gets `question`) with the case id and the measured values;
   never paste recording transcripts into an issue (§2).

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
| — | The speaker may get the transcription's auto gain | Chromium processes a mic once per page: when the transcription opened the mic first, the speaker's stream gets its auto gain even though it asks for none (checked with Electron's fake devices; when the speaker opens first, each gets its own) | Hardware data (`HW-19`); a page-level fix would mean giving up auto gain for the text |
| — | Bluetooth speakers play ~0.2 s late | Bluetooth audio buffering in the speaker and the OS | Nothing in the app; README recommends a cable or USB speaker |
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
| Engines (transcribe.cpp, whisper.cpp, sherpa-onnx, NeMo) | `SCN-ENGINE`, `PROT-MODEL-*` | `STRESS-ENG-*` (stress tier only) |
| Transcript and audio files | `UNIT-WAV-*`, `UNIT-SESS-05`, `PROT-MIC-04…06`, `PROT-RUN-02`; a full disk: `UNIT-SESS-08`, `PROT-ERR-03` (every run), `STRESS-DISK-01` (a real one, macOS); hours-long files, a drive unplugged, two recordings at once: `STRESS-MEET-09`, `STRESS-DISK-02`, `STRESS-CONC-02` | — |
| Reconnect and buffering | `UI-NET-01`, `STRESS-NET-*` (repeated server kills; the 5-minute buffer limit) | what to keep beyond the buffer: decision D3 (§14.6) |
| Long meetings (hours): attribution, accuracy, clock, files and memory over time | `SCN-07/08` (10 minutes), `STRESS-MEET-*`, `STRESS-MIC3-*`, `STRESS-SOAK-*` (§14); the clock across mic changes: `UNIT-SESS-06/07` | real rooms over hours: `HW-11`, `HW-21` |
| A model slower than the talk; each model's capacity | `STRESS-LOAD-*`, `STRESS-CAP-01` | telling the page it is behind: decision D1 (§14.6) |
| A page holding hours of transcript | `STRESS-PAGE-*`, `STRESS-SOAK-04` | — |
| Several recording clients, many reconnects, many setting changes | `STRESS-CONC-*`, `STRESS-CONN-*`, `STRESS-TUNE-01` | — |
| Projector view, caption window | `UI-PROJ-*`, `VIS-03` | full screen, idle hiding of controls |
| Two mics: choosing, labels, colours | `UI-MIC-*`, `UI-TX-02…05`, `UI-CFG-01/02`, `VIS-01` | — |
| Two mics: crosstalk gate and duplicates | `UNIT-GATE-*`, `UNIT-SESS-*`, `SCN-01…08`, `SMOKE-02` | `KNOWN-01`, real rooms (§9) |
| Two mics: devices coming and going, 8 kHz | `UI-DEV-*`, `SCN-06` | real Bluetooth (`HW-06`) |
| Speaker in the room: choosing, volume, coming and going, meters before Start | `UI-SPK-*`, `DESK-09`, `VIS-07` | real speakers, delay and howling only in §9 (`HW-14…20`); auto gain on the speaker (§10.2) |
| Desktop app | `STATIC-02`, CI smoke, `DESK-*` | packaged app UI not automated |
| User manual (PDFs, Help menu, release assets) | `STATIC-05`, `DESK-10`; content and screenshots reviewed by the user-manual skill on every rebuild | whether the text still matches the app is checked only when the manual is rebuilt (before each tag) |
| Docker | `DOCK-01` | manual only |
| Wake lock (screen stays on), Noise suppression checkbox | — | not tested |
| Browsers other than Chromium (Safari, Firefox) | — | not tested; Safari may allow one mic only; there the speaker can only be the system default |
| Accessibility (keyboard, screen readers) | projector keys in `UI-PROJ-02` | not tested |

## 12. Run history

Add one row per run on `main` (§3 step 5), newest first. Feature-branch runs go here only when they found something.

| Date | Commit | Branch | Tier | Result | ✔ / ✖ / ◌ / – | Notes |
|---|---|---|---|---|---|---|
| 2026-11-01 | `98ae01d` | claude/project-thread-4onwzk | full + `STRESS-DISK` | PASS | 140 / 0 / 6 / 0 | The fix for [#1](https://github.com/Denis-Feier/local-word-transcriptor/issues/1) (a full disk no longer stops the server), before the merge: full tier 12 min, the disk group 3 min. `UNIT-WAV-03/04`, `UNIT-SESS-08` and `PROT-ERR-03` pass; **`STRESS-DISK-01` passes for the first time** (it failed in both earlier runs): the server stays up, 25 lines after the 20 MB disk filled, one "Could not save audio". Found: (1) on a full disk the `.txt` cannot grow either, and `#saveLine` sends "Could not save transcript" for every sentence (the run had 49 errors in all, one of them about audio; [#19](https://github.com/Denis-Feier/local-word-transcriptor/issues/19), §14.5 #12); (2) macOS's `sh` counts `ulimit -f` in 1,024-byte blocks, not 512, so `PROT-ERR-03`'s WAV filled at 19.2 s, not 9.6 s, leaving exactly the 2 sentences it needed after it; the next commit uses 300 blocks (3 sentences after on macOS, 4 on Linux). Known limits as before (`UNIT-GATE-05`, `KNOWN-01` on every engine). PERF-01 in range (Parakeet 110M 33–35 ms, Canary 134 ms, Parakeet v3 169 ms, Jackrabbit 359 ms, Whisper turbo 519 ms); `SCN-08` 248 → 263 MB. Run in a clone in `$TMPDIR` with `models/` and `python/.venv` linked from the main checkout, so "uncommitted changes" in the report is those two links. |
| 2026-11-01 | `c5619c6` | main | full + 2 real recordings | FAIL | 139 / 1 / 7 / 0 | After merging the fix for [#8](https://github.com/Denis-Feier/local-word-transcriptor/issues/8) (mic changes no longer shift the clock); 15 min. Recordings `2026-10-29_23-27-58.wav` and `2026-10-30_10-39-26.wav`. The same result as `1271dbb` plus the new `UNIT-SESS-06/07` (both pass: 0 samples behind; the sentences start at 31.808 s and 35.808 s, as without the changes). **`SCN-04` still fails on real voices** with the same numbers (mic 1: 7 sentences, 3 % from the reference; 2 fragments under mic 2), tracked in [#3](https://github.com/Denis-Feier/local-word-transcriptor/issues/3); that scenario never changes the layout, so the fix does not touch it. `UI-CFG-02`, flaky once on the branch, passed. Known limits as before (`UNIT-GATE-05` once, `KNOWN-01` on every engine and on the recordings). PERF-01 in range (Parakeet 110M 34–38 ms, Canary 136 ms, Parakeet v3 155 ms, Jackrabbit 346 ms, Whisper turbo 522 ms); `SCN-08` 246 → 261 MB; VIS-01, VIS-04, VIS-06 and VIS-07 fine. The report's "uncommitted changes" is the untracked benchmark result. |
| 2026-11-01 | `1cc293e` + the fix for [#8](https://github.com/Denis-Feier/local-word-transcriptor/issues/8) (uncommitted) | fix/layout-change-clock-drift | full | FAIL (flaky) | 133 / 1 / 6 / 0 | 12 min, `test-results/2026-11-01-09-43_1cc293e/`. The new `UNIT-SESS-06/07` pass (0 samples behind; without the fix 4,928 samples, 308 ms, and both sentences 0.32 s early). **`UI-CFG-02` failed once** (no Mic 3 line within 20 s, no detail recorded) and passed in two re-runs of the UI suite (44 / 0 each): flaky. Not caused by the fix: the test picks all three mics before Start, so the server never changes layout with unframed samples, and the fix changes nothing there. Known limits as before (`UNIT-GATE-05`, `KNOWN-01` on every engine). PERF-01 in range (Parakeet 110M median 34 ms, Canary 126 ms, Parakeet v3 154 ms, Jackrabbit 336 ms, Whisper turbo 486 ms); `SCN-08` 247 → 256 MB. |
| 2026-11-01 | `1271dbb` | main | full + 2 real recordings | FAIL | 137 / 1 / 7 / 0 | After merging the stress tier (tests only; `lib/` and `public/` unchanged); 15 min. Recordings `2026-10-29_23-27-58.wav` and `2026-10-30_10-39-26.wav`. The same result as `459c591`: **`SCN-04` still fails on real voices** with the same numbers (mic 1: 7 sentences, 3 % from the reference; 2 fragments under mic 2), now tracked in [#3](https://github.com/Denis-Feier/local-word-transcriptor/issues/3). Known limits as before (`UNIT-GATE-05` once, `KNOWN-01` on every engine and on the recordings). PERF-01 in range (Parakeet 110M 32–34 ms, 59 ms in the long conversation against 40 ms last time, still under 100 ms; Canary 129 ms, Parakeet v3 154 ms, Jackrabbit 339 ms, Whisper turbo 492 ms); `SCN-08` 245 → 260 MB; VIS-01, VIS-04, VIS-06 and VIS-07 (`speaker-disconnected.png`) fine. `npm test` on the branch before the merge: PASS, 106 / 0 / 2 / 0. The report's "uncommitted changes" is the untracked benchmark result. |
| 2026-10-31 | `b1f4260` + the stress tier (uncommitted) | feature/stress-test | stress (stopped after the 4-hour meeting) | FAIL | 21 / 11 / 0 / 0 | The first stress run, `test-results/2026-10-31-21-20_b1f4260/` (`stress/meeting.md` has every metric per block and per 10 minutes). Run in full: static, `PAGE` (5,000 lines), `CONN`/`CONC`/`TUNE`/`DISK`, `MEET` (3.9 h of meeting, 3,421 utterances, 30 min at 8×). Stopped by the user after `MEET`: `SOAK` (at ~1 h), `MIC3` and `NET` stopped, phase B (`CAP`, `LOAD`, `ENG`) not run. Earlier short runs on the branch: `LOAD` 3 ✔ 1 ◌, `NET-01` ✔, a 3-minute `SOAK` (02 and 03 ✖), `CAP` on Parakeet 110M under the old criterion. **Confirmed product bugs** (§14.5): #1 a full disk crashes the server (`DISK-01`); #2 two recordings in the same second share files (`CONC-02`); #6 ~3 MB of native memory per Silero detector, per connection and per setting change (`CONN-01` +99 MB, `TUNE-01` +119 MB); #7 fragments on the Bluetooth mic and whole lines dropped by the duplicate check (`MEET-01`: 322 wrong-mic lines in 4 h, 312 of them 1–3 words; `MEET-02` 96.4 % caught; `MEET-11`: 42 stray fragments during the presentation); #8 the page's cost per message grows with the transcript (`PAGE-01`: 0.46 → 3.1 ms). Held for 4 hours: no phantom lines in silence or the break (`MEET-03`), accuracy R → R′ (`MEET-04`: 9.8 → 4.5 % and 6.9 → 5.1 %), no clock drift (`MEET-05`, ≤ 0.09 s, see #10), files with hour times and exact WAVs (`MEET-09`), server always answering (`MEET-10`, ≤ 150 ms), open files back (`MEET-12`). Not confirmed: `MEET-06`/`07`/`08` failed only while the bursty failure groups shared the GPU (model time 32 → 143 ms, back to 32 ms between them); the lanes are changed so they run alone. |
| 2026-10-31 | `459c591` | main | full + 2 real recordings | FAIL | 137 / 1 / 7 / 0 | After merging the user manual; 16 min. Recordings `2026-10-29_23-27-58.wav` and `2026-10-30_10-39-26.wav`. The same result as `bdeb32d` plus the new `STATIC-05`: **`SCN-04` still fails on real voices** with the same numbers (mic 1: 7 sentences, 3 % from the reference; 2 fragments under mic 2). Still open and not caused by this merge (`lib/` unchanged). Known limits as before (`UNIT-GATE-05` once, `KNOWN-01` on every engine and on the recordings). PERF-01 in range (Parakeet 110M 32–40 ms, Canary 129 ms, Parakeet v3 158 ms, Jackrabbit 341 ms, Whisper turbo 491 ms); `SCN-08` 248 → 261 MB; VIS-01, VIS-04, VIS-06, VIS-07 fine. The report's "uncommitted changes" is an untracked benchmark result that is not part of the merge. |
| 2026-10-31 | `bdeb32d` | main | full + 2 real recordings | FAIL | 136 / 1 / 7 / 0 | After merging the test plan and the speaker feature; 15 min. **`SCN-04` fails on real voices** (the first run with recordings; it passes on the fixture with every engine): A's text is right on mic 1 (3 % from the reference), but 2 fragments of 2 words each appear under mic 2. It repeats exactly. Traced: the gate lets short bursts through on the far, turned-up mic (kept 10–80 of ~200 speech frames per 10 s), and the duplicate check in `session.js` needs ≥ 2 shared content words, so these 1-word matches stay. With each of the 4 recordings as A, 3 leave 1–5 fragments of 2–3 words; about half share no word with mic 1's text, so a text-only fix would catch only some. Not caused by the merge: `lib/` unchanged since `6277c2a`. Open: to be fixed on a branch. `KNOWN-01` also on the recordings, as expected. PERF-01 in range (Parakeet 110M 32–43 ms, Canary 129 ms, Whisper turbo 491 ms); `SCN-08` 246 → 259 MB; VIS-01, VIS-04, VIS-06, VIS-07 fine. |
| 2026-10-31 | `ca62a61` + this plan (uncommitted) | feature/testing-plan | full | PASS | 120 / 0 / 6 / 0 | Baseline, first run of the plan. 12 min on an M5. All four engines ran. Known limits as expected: `UNIT-GATE-05` once, `KNOWN-01` on every engine. `SCN-08` 240 → 259 MB. VIS-01 and VIS-04 reviewed, fine. PERF-01 was not readable from the logs, so `scenarios.js` now prints a timing line (Parakeet 110M median 33 ms). |
| 2026-10-31 | `ca62a61` + this plan (uncommitted) | feature/testing-plan | standard | PASS | 94 / 0 / 2 / 0 | 3 min. |

## 13. Plan change log

| Date | Change |
|---|---|
| 2026-10-31 | Plan created, covering the app up to `ca62a61` (two microphones). Test tooling added: `run-all.js`, `helpers.js`, `unit.js`, `protocol.js`, `scenarios.js`, `ui/`. |
| 2026-10-31 | After the baseline run: time budgets measured (full tier ~12 min, not 40); PERF-01 reads the new timing line from the scenario logs. |
| 2026-10-31 | Speaker in the room (`feature/speaker-output`): `UI-SPK-01…09`, fake outputs in `preload.cjs` (silent sink, level tap), `VIS-07`, `DESK-09` (done once with a probe), `HW-14…20`, two known limits. `STATIC-04` added after the new `public/speaker.js` was not served and the page silently failed to start. |
| 2026-10-31 | The meters move while only the speaker plays (a sound check before Start): `UI-SPK-10`, `UI-SPK-09` also checks they return to zero. |
| 2026-10-31 | User manual (`feature/user-manual`): `STATIC-05` (manual built for this version and packaged), `DESK-10` (Help → User manual); `scripts/manual.mjs` reuses `preload.cjs` for its screenshots (§5). |
| 2026-10-31 | Stress plan for long meetings (`feature/stress-test`): §14 (design), §7.7 (45 cases, How = `planned`, a new How value), `HW-21`, §11 rows, the `STRESS` area. Not built yet. Six suspected weak spots found while planning (§14.5) and four product decisions needed (§14.6). |
| 2026-10-31 | Stress tier built (`feature/stress-test`): `test/meeting.js` (synthetic meeting, room, judge), `test/stress.js`, `test/ui/stress.mjs`, the sentence bank `test/fixtures/meeting-ro.txt`, `npm run test:stress` (run-all.js tier `stress`: lanes in parallel, then alone), STATIC-03 knows the `STRESS` area. `preload.cjs`: `--ui-loop` (fake mics loop; off by default). `helpers.js`: `room()` exported; `stop()` no longer waits 8 s for a server killed by a signal. Added `STRESS-PAGE-08` (console errors). Two thresholds corrected once, because they measured the wrong thing (§14.3): `STRESS-LOAD-03` compared memory with before the burst, but a process keeps memory it has used (it reuses it), so it now checks that a second overload needs ≤ 50 MB more; `STRESS-CAP-01` used the delay's p95, which lines waiting for overlapping speech on the other mic spread by seconds whatever the model, so it now uses the median, the model's busy time and completion. The generator avoids a sentence anyone said in the last minute (an exact repeat by another person made the duplicate check drop lines more than real speech would). |
| 2026-10-31 | After the first stress run (§12): only steady loads run in parallel (the soak beside `MEET`, `MIC3`, `PAGE`, `NET`); `CONN`/`CONC`/`TUNE`/`DISK` moved to phase B, alone, because their bursts slowed the model in the middle of the 4-hour meeting. §14.5 updated with the confirmed bugs and new findings #7–#11. |
| 2026-11-01 | Findings tracked as GitHub issues #1–#13 (label `stress-test`): an Issue column in §14.5 and §14.6; §10.1 step 4 opens an issue for a product bug not fixed in the same branch. |
| 2026-11-01 | Mic changes no longer shift the clock ([#8](https://github.com/Denis-Feier/local-word-transcriptor/issues/8), `fix/layout-change-clock-drift`): `UNIT-SESS-06/07` (fail without the fix: 308 ms behind after 11 changes); §14.5 #10 fixed; §11 clock row. |
| 2026-11-01 | A full disk no longer stops the server ([#1](https://github.com/Denis-Feier/local-word-transcriptor/issues/1), `claude/project-thread-4onwzk`): `UNIT-WAV-03/04` and `UNIT-SESS-08` (a stand-in disk that fills, every platform) and `PROT-ERR-03` (a real server whose files cannot grow past 300 blocks; `startServer({ maxFileBlocks })`), each failing without the fix; §14.5 #1 fixed, #12 new (the transcript on a full disk, [#19](https://github.com/Denis-Feier/local-word-transcriptor/issues/19)); §11 files row. |

## 14. Stress plan: long meetings (production readiness)

**Status: built** (2026-10-31): `test/meeting.js`, `test/stress.js`, `test/ui/stress.mjs`, run by `npm run test:stress`.
The cases are in §7.7; the findings of the first runs are in §14.5 and §12.

The other tiers show that features work. This tier shows that they keep working for hours under load, as in a real
meeting of two to eight hours. The app must not fall behind, lose text, put text on the wrong mic, drift in time,
grow in memory or lose files. It must also survive what goes wrong in long meetings: a model slower than the talk, a
Bluetooth mic dropping out, a full disk, a server or model crash, a page reload, a second tab.

### 14.1 How a stress run works

```bash
npm run test:stress                         # the release gate, ~4.5 h: phase A (lanes in parallel), then phase B (alone)
npm run test:stress -- --short              # ~25 min: the same checks on a 30-minute meeting; no soak, capacity or crashes
npm run test:stress -- --hours 8            # an all-day workshop instead of the 4-hour meeting
npm run test:stress -- --only STRESS-MEET   # one group
node test/run-all.js stress --recordings transcripts/a.wav,transcripts/b.wav   # real voices in the meeting (§2: stay local)
```

| Phase | Lane | Runs | Wall time |
|---|---|---|---|
| A | 1. soak | `STRESS-SOAK`: the real page (Electron, fake mics) records a 2-hour meeting in real time on the default model (Canary), with Save audio on and the caption window open | 2 h |
| A | 2. long meetings | `STRESS-MEET` (4-hour meeting at 8×, Parakeet 110M, 30 min), `STRESS-MIC3` (2 hours, three mics, 8×), `STRESS-PAGE` (5 min), `STRESS-NET` (72 min in real time) | ~2 h |
| B | — | `STRESS-CONN`, `STRESS-CONC`, `STRESS-TUNE`, `STRESS-DISK` (~25 min), `STRESS-CAP` (every installed model, ~1.5 h), `STRESS-LOAD`, `STRESS-ENG` | ~2.5 h |

- **Parallel on purpose.** Phase A's two lanes are steady loads, so they share the computer without making the trend
  checks unfair; this is the one exception to §2 rule 6. Everything bursty (several clients, 500 setting changes,
  overload, crashes) and everything that measures limits runs alone in phase B. The first run had the bursty groups
  beside the 4-hour meeting: the model slowed from ~35 to ~140 ms per sentence while they ran, and the meeting's trend
  checks failed for that reason (§12). Never run another tier at the same time as this one.
- **A failure in phase A** is re-run alone (`--only <id>`) before it counts as a product failure; record both results.
- Every server comes from `startServer()` (own port, own temporary folders). The tier needs ~3 GB of free disk for
  WAVs of up to 4 hours per mic, deleted after their checks.
- Output: `test-results/<run>/stress/`, with `meeting.md` (every metric per 10-minute window, so a slow climb is
  visible even when a check passes), the ground truth (`truth.json`) and the server logs. The content is synthetic, so
  these reports may be shared, except from a `--recordings` run.

### 14.2 The synthetic meeting

`test/meeting.js` builds a meeting from a script: blocks of minutes, each with its people, room and events. It plays
the meeting 100 ms at a time, so hours of audio are never held in memory. The same generator streams to a server the
way the page does (`STRESS-MEET`). It also writes WAVs for the fake mics (`STRESS-SOAK`) and for `npm run test:wav`
replays. It is seeded, so every run gets the same meeting.

- **Voices and text.** A sentence bank, `test/fixtures/meeting-ro.txt`, holds ~60 Romanian meeting sentences of 1–25
  words. It includes short replies ("Da.", "Exact."), numbers, dates and names. The sentences are voiced with macOS
  `say -v Ioana` into a cache folder, at a different speaking rate for each person; the audio is never committed.
  Without that voice (Windows, Linux, CI), the fixture's three sentences are used. The text of every utterance is known,
  so accuracy is measured against the truth, not only against a one-mic reference. With `--recordings`, the people
  speak pieces of the real recordings instead.
- **Room.** `twoMics()` extended to N mics. Each mic hears its own person, everyone else `bleedDb` quieter through the
  room model, and its own noise, lag and gain. Transients (door, chair, keyboard) reach every mic.
- **As the page sends it.** 100 ms frames with a mic count. A Bluetooth dropout is digital silence on that mic (the
  page keeps the count, `pcm-worklet.js`). Only choosing a mic in the menu changes the count; the page then reopens its
  capture, leaving a short gap.
- **Ground truth.** Every utterance is logged (person, mic, start, end, text), and so is every event (dropout, setting
  change, Clear).

The 4-hour meeting (`--hours` stretches or shrinks blocks 2, 6 and 7):

| Block | Min | What happens | What it stresses |
|---|---|---|---|
| 1 R | 15 | Two people, lapel mics (12 dB bleed), mic 2 on Bluetooth (150 ms late, +4 dB), turns of 1–4 sentences, a quarter overlapping by 1–3 s | the reference for the trend checks |
| 2 | 60 | A third person shares mic 1: 6 dB farther from it than its owner, 16 dB from mic 2 | one mic, two people |
| 3 | 20 | Presentation: one person talks for 20 min with pauses under 0.7 s; three questions from mic 2 | a cut every 20 s, words lost at cuts, mic 2 quiet for minutes |
| 4 | 20 | Debate: half the turns overlap, interruptions of 0.5–4 s, short replies | the gate and the duplicate check under overlap; very short speech |
| 5 | 15 | Coffee break: room noise only, a door slamming, chairs, keyboard clicks | phantom lines; noise learning over a long silence |
| 6 | 40 | Air conditioning: the noise rises 12 dB on every mic over a minute, stays for 30 min, then falls | noise levels following the room |
| 7 | 30 | Flaky Bluetooth: mic 2 drops to digital silence 6 times for 5–90 s while its owner keeps talking | dropouts and rejoining |
| 8 | 20 | Changes: Mic 2 → None and back twice, every slider changed and reset, Clear once, the speaker in the room on for 10 min (both mics played into the room 20 ms late, 18 dB under the voices) | layouts, live settings, new files, the speaker |
| 9 R′ | 15 | Block 1 again, identical | the trend checks compare R′ with R, so any difference comes from the hours in between |

`STRESS-MIC3` runs 2 hours with `MAX_MICS=3`: three people with their own mics (wired, Bluetooth, USB) through blocks
1, 4, 6, 7 and 9. The soak loops a 20-minute meeting (blocks 1, 4 and 5, shortened) six times; `preload.cjs` gets a
loop option for this, and `npm run manual` must still work afterwards (§5).

### 14.3 How lines are judged

A line (mic, start–end, text) is compared with the ground truth, allowing for the mic's lag.

| Term | Meaning |
|---|---|
| phantom | the line overlaps nobody's speech (less than 0.2 s) |
| wrong mic | the line overlaps only other people's speech, or its words match another person's utterance better than its own (≥ 3 shared content words, `sharedWords`) |
| on both mics | the session's own duplicate rule: overlap ≥ 0.5 s, ≥ 2 shared words, ratio > 0.5 |
| caught | an utterance whose mic has lines during it containing at least half of its content words |
| accuracy | diacritic-blind WER of each mic's text against the true text, per block |
| clock offset | line start minus utterance start, for turns with nobody else talking (≈ −0.3 s pre-roll); its median per block |
| delay | how far behind the live audio a line arrives: audio sent when the line arrived minus the line's end |

The thresholds in §7.7 are starting values. The first full run on main is the baseline and calibrates them. A value
that the baseline misses because of the test, not the app, is corrected once, and the reason goes in §13. After that,
thresholds only get stricter (§2 rule 7).

### 14.4 When to run it

- **Before every release (version tag):** `npm run test:stress` on main. A FAIL blocks the release unless the user
  accepts it. Record it in §12 with the per-window trends that matter (delay, memory, accuracy in R and R′).
- **On a feature branch** that changes the session, segmenter, crosstalk gate, transcriber, an engine, `server.js`, or
  the page's transcript or connection code: `npm run test:stress -- --short` as well as the §3 tiers.
- **After the baseline:** add the measured capacity of every model (`STRESS-CAP-01`) to the README's model table
  (can it keep up with a long meeting on this computer, and with how much to spare).

### 14.5 Weak spots: suspected while planning, then tested

The first run (2026-10-31, `feature/stress-test`: the 4-hour meeting, the page with 5,000 lines and the failure groups
at full size, the rest in short runs; §12) confirmed most of them and found more (#7–#11). Each confirmed one is a
product bug or a decision, tracked as a GitHub issue (label `stress-test`; [#13](https://github.com/Denis-Feier/local-word-transcriptor/issues/13) lists the groups still to run
in full): fix it on a branch with its case as the regression test (§10.1), and close the issue in that merge.

| # | Weak spot | Where | Case | Status | Issue |
|---|---|---|---|---|---|
| 1 | A full disk with Save audio on crashes the server. `Session.audio()` calls `WavWriter.append()` outside any `try`, so `ENOSPC` escapes the WebSocket handler as an uncaught exception, and the meeting stops being transcribed | `lib/session.js`, `lib/wav.js` | `STRESS-DISK-01` | **confirmed** twice: the server exits when the disk fills; nothing is transcribed after. Also found: the last write is cut short without an error, so the WAV's header counted audio that was never written. **Fixed** (`claude/project-thread-4onwzk`): a failed write stops Save audio with one error and the transcript goes on; each WAV keeps every whole sample written, with a matching header. `UNIT-WAV-03/04`, `UNIT-SESS-08` and `PROT-ERR-03` are the regression tests; `STRESS-DISK-01` passes on the 20 MB disk image (§12) | [#1](https://github.com/Denis-Feier/local-word-transcriptor/issues/1) |
| 2 | Two recordings that start within the same second share their files. The file stamp has one-second resolution, so both write to one `.txt`, and the second `WavWriter` (opened with `'w'`) truncates the first's WAV. Seen with two tabs, or the desktop app plus a browser tab | `lib/session.js` (`fileStamp`, `#base`) | `STRESS-CONC-02` | **confirmed** twice: both sessions wrote `<stamp>.txt`, `-mic1.wav` and `-mic2.wav` | [#2](https://github.com/Denis-Feier/local-word-transcriptor/issues/2) |
| 3 | No backpressure. When the model is slower than the talk, every sentence waits in the queue with its audio, live text stops (guesses run only when the model is idle), and the delay grows without telling anyone | `lib/transcriber.js`, `lib/session.js` | `STRESS-LOAD-*`, `STRESS-CAP-01` | **confirmed, nothing lost**: 10 min of meeting sent in 3 s left 98 sentences waiting and lines ~590 s of audio behind, every sentence then finished once, the server kept answering (≤ 0.5 s); the page is never told (D1) | [#9](https://github.com/Denis-Feier/local-word-transcriptor/issues/9) |
| 4 | A reconnect is a new session, with a new transcript file whose clock restarts at 00:00. During an outage longer than 5 minutes the page keeps the first 5 minutes of audio and silently drops the rest | `server.js`, `public/app.js` (`MAX_BACKLOG`) | `STRESS-NET-*` | **confirmed** (short run): back within 2 s, buffered audio transcribed 7/7, nothing lost; 3 files for 2 restarts, each from `[00:00]` (D2). The outage beyond 5 minutes not run yet (D3) | [#10](https://github.com/Denis-Feier/local-word-transcriptor/issues/10), [#11](https://github.com/Denis-Feier/local-word-transcriptor/issues/11) |
| 5 | After 4 model crashes in quick succession the transcriber stays in error for the rest of the meeting; nothing retries later | `lib/transcriber.js` (`#recover`) | `STRESS-ENG-02` | not run yet (D4) | [#12](https://github.com/Denis-Feier/local-word-transcriptor/issues/12) |
| 6 | Silero detectors are rebuilt for every new connection, every mic-layout change and every threshold change, and freed only by garbage collection | `lib/session.js`, `lib/vad.js` | `STRESS-CONN-01`, `STRESS-TUNE-01` | **confirmed**: each detector holds ~3 MB of native memory V8 does not see, so it is collected late (300 detectors: 70 → 1,007 MB until a forced GC; sherpa-onnx's `Vad` has no `free`, only `reset()`). 200 connections +99 MB, 500 setting changes +119 MB | [#4](https://github.com/Denis-Feier/local-word-transcriptor/issues/4) |
| 7 | **New.** A word or two of a sentence leaks onto the other mic: the late (Bluetooth, 150 ms), louder mic keeps the sentence's last syllables (the open `SCN-04` issue in §12, here with synthetic voices). Then the duplicate check can drop the whole sentence from the right mic: the two lines share ≥ 2 words, so they count as the same speech, and clarity is compared only where they overlap, the sentence's tail, where the late mic still has sound. `SAME_WORDS` is relative to the shorter text, so a short line can cancel a long one | `lib/crosstalk.js`, `lib/session.js` (`#heardBetterElsewhere`) | `STRESS-MEET-01`, `-02`, `-11`, `STRESS-SOAK-02` | **confirmed**: in 4 hours 322 wrong-mic lines (312 of them 1–3 words, mostly on the Bluetooth mic; 30 % of the lines in the block with two people on mic 1); 93 lines "dropped, another mic heard it more clearly", several of them whole turns; 117 of 3,292 utterances lost (96.4 %). Also on Canary through the page in real time (7 fragments in 3 min) | [#3](https://github.com/Denis-Feier/local-word-transcriptor/issues/3) |
| 8 | **New.** The page's work per message grows with the transcript: every message calls `render()`, which sorts all lines (`finalLines()`, only to enable Copy) and sorts them again for the projector (`publish()` → `snapshot()`), even when no projector or caption window is open | `public/app.js` | `STRESS-PAGE-01` | **confirmed**: 0.46 → 3.1 ms of main-thread time per message from line 500 to line 5,000. No long task yet; everything else on the page holds at 5,000 lines (order, hour times, Copy/Download, reading back, projector within 25 ms, Clear in 10 ms) | [#5](https://github.com/Denis-Feier/local-word-transcriptor/issues/5) |
| 9 | **New, minor.** The saved `.txt` is in the order lines were finished, not spoken: a short line on one mic is written before a longer line that started earlier on the other. The page's Download is in speaking order | `lib/session.js` (`#settle`) | `STRESS-SOAK-07` (reports the order) | **confirmed**: same lines, different order | [#7](https://github.com/Denis-Feier/local-word-transcriptor/issues/7) |
| 10 | **New, minor.** Every change of the mics (Mic 2 → None and back) shifts the transcript's clock up to 32 ms against the audio: the new segmenters drop the samples the old ones had not yet framed | `lib/session.js` (`#layout`), `lib/segmenter.js` | `STRESS-MEET-05`, `UNIT-SESS-06/07` | **seen**: −0.06 s after the four changes of block 8, −0.09 s at R′ (still within 0.1 s). **Fixed** (`fix/layout-change-clock-drift`): the unframed samples carry over to the new segmenters, a mic that joins gets as many of silence; `UNIT-SESS-06/07` are the regression tests | [#8](https://github.com/Denis-Feier/local-word-transcriptor/issues/8) |
| 11 | **New, to decide.** A finished sentence waits until any overlapping sentence on the other mic is finished too (so the duplicate check can compare them). In a lively discussion the final line comes late: delay p95 ~10–13 s of audio at 8× (the median ~1.5 s), and 5.3 s in real time on Canary through the page, against the 2 s `STRESS-SOAK-03` asks for. The grey live text shows meanwhile | `lib/session.js` (`#waiting`) | `STRESS-SOAK-03`, `STRESS-MEET-06` | **confirmed** | [#6](https://github.com/Denis-Feier/local-word-transcriptor/issues/6) |
| 12 | **New** (found once #1 was fixed). A full disk still breaks the saved transcript (the page's is fine): every sentence sends its own "Could not save transcript" (which hides "Could not save audio"), the line that did not fit is left cut in the `.txt` and glued to the next line once there is room, and the lines said meanwhile are never written. The page's Save audio box stays ticked after the server stopped saving | `lib/session.js` (`#saveLine`), `public/app.js` | `STRESS-DISK-01` (reports the errors) | **confirmed**: 48 "Could not save transcript" in one run (§12); a cut line measured on a small tmpfs | [#19](https://github.com/Denis-Feier/local-word-transcriptor/issues/19) |

Not confirmed: in the first run `STRESS-MEET-06`, `-07` and `-08` (delay, live guesses and memory over the 4 hours)
failed only while the bursty groups ran beside the meeting (model time ~35 → ~140 ms, back to ~35 ms between them);
the lanes are now changed (§14.1), and the next run decides them.

### 14.6 Decisions needed

These are about what the app should do, so the user decides (in the decision's issue); the tests then check it. Until
a decision is made, the case runs as a known limit (◌) and reports what happens today.

| # | Question | Proposal | Case | Issue |
|---|---|---|---|---|
| D1 | What should happen when the model falls behind the talk? | Never drop a sentence. Tell the page when it is more than 30 s behind ("Transcription is 45 s behind; a faster model would keep up"), and clear the message when it catches up | `STRESS-LOAD-04` | [#9](https://github.com/Denis-Feier/local-word-transcriptor/issues/9) |
| D2 | Should a reconnect (server restart, page reload) continue the same transcript? | Yes: the same file, with the clock continuing (the page tells the server where it was) | `STRESS-NET-01` checks that nothing is lost; the file split is reported | [#10](https://github.com/Denis-Feier/local-word-transcriptor/issues/10) |
| D3 | An outage longer than the page's 5-minute buffer | Keep the newest 5 minutes, and tell the user how much was lost | `STRESS-NET-02` | [#11](https://github.com/Denis-Feier/local-word-transcriptor/issues/11) |
| D4 | The model keeps crashing | After giving up, retry every 30 s and keep the error shown until it works again | `STRESS-ENG-02` | [#12](https://github.com/Denis-Feier/local-word-transcriptor/issues/12) |
