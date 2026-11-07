# TypeScript migration plan

How the app moves from plain JavaScript to TypeScript without a big-bang rewrite: first the tooling, then the types
as a reviewable artifact, then the types into the existing JavaScript file by file (JSDoc, nothing runs differently),
then the files themselves become `.ts`, server side first, page second. Every step leaves `main` runnable and
`npm test` green. The runtime stays as it is today: no bundler, `node server.*` from source, the same Docker image,
the same installers.

Written on 2026-11-06 from a scan of the code on `main` at `133a274`. The progress log at the end says where the
migration stands; update it with every merged step.

## 1. What the scan found

**Size and shape.** Everything is ES modules (`"type": "module"`), no build step anywhere, no TypeScript tooling
installed, three files carry some JSDoc (`lib/convert-whisper.js`, `public/stage.js`, `public/settings.js`).

| Area | Files | Lines | Runs in |
|---|---|---|---|
| `server.js` | 1 | 268 | Node (also as an Electron utility process) |
| `lib/` (+ `engines/`, `benchmark/`) | 14 + 6 + 6 | 3 866 | Node |
| `public/` | 8 modules + `pcm-worklet.js` | 1 630 | the browser, as native ES modules, served by `server.js`'s route table |
| `desktop/main.mjs` | 1 | 208 | Electron main process |
| `scripts/` | 5 | 743 | Node |
| `test/` | 12 (`ui/preload.cjs` is CommonJS) | 4 568 | Node and Electron |

**Module graph** (what imports what, from `graphify query` and the import lines):

- Leaves with no project imports: `lib/wav.js`, `lib/text.js`, `lib/tuning.js`, `lib/config.js`, `lib/steady.js`,
  `public/order.js`, `public/backlog.js`, `public/stage.js`, `public/pcm-worklet.js`, `lib/benchmark/audio.js`.
- Middle: `lib/wer.js` → text; `lib/vad.js` → wav; `lib/segmenter.js` → wav, vad; `lib/crosstalk.js` → vad, wav;
  `lib/python-env.js` → config; `lib/convert-whisper.js`; `lib/models.js` → config, convert-whisper, python-env;
  `lib/engines/sidecar.js`; the other engines → sidecar, wav, config, python-env.
- Top: `lib/transcriber.js` → models, engines/*; `lib/session.js` → segmenter, vad, crosstalk, text, steady, wer, wav
  and **`public/order.js`** (one module shared by server and page); `server.js` → config, models, transcriber,
  session, tuning.
- Page: `app.js` → stage, settings, mics, speaker, backlog, order; `settings.js` → stage; `speaker.js` → mics.
  The page imports with absolute paths (`from '/stage.js'`), which the server's route table resolves.
- Tests import `lib/*` directly (`test/unit.js` alone has 27 project imports) and start `server.js` as a child
  process (`test/helpers.js`, `test/smoke.js`, `test/protocol.js`).

**Everything that names a source file by path** (a rename touches each): 136 import specifiers; `package.json`
(`start`, `main`, `build.files`); `Dockerfile` (`CMD`); `.github/workflows/desktop.yml` (`node test/smoke.js`);
`desktop/main.mjs` (`utilityProcess.fork(… 'server.js')`); `test/helpers.js`, `test/smoke.js`, `test/protocol.js`,
`test/run-all.js` (`server.js`, `stream-wav.js`, `smoke.js`); `scripts/benchmark-suite.js` (re-spawns itself);
`server.js`'s route table (`public/*.js`); `STATIC-01/02/04` and `PROT-STATIC-01/02`; README (27 distinct paths);
TESTING.md (§5, §7 and the text throughout).

**Runtime facts, verified on this Mac on 2026-11-06:**

| Fact | Result |
|---|---|
| Node here / in CI / in Docker | 24.21 / 24 (`setup-node`) / 24 (`node:24-bookworm-slim`); `package.json` says `>=22.12` |
| Node bundled in Electron 45.1.0 | 24.22.1 |
| `node main.ts` with interfaces, `import type`, inline `type` specifiers | runs, no flag, no warning (type stripping is on by default since Node 22.18 / 23.6) |
| Import specifiers between `.ts` files | must name the `.ts` file (`from './wav.ts'`); Node does not rewrite `.js` to `.ts` |
| `enum` in a `.ts` file | refused by Node (only erasable syntax runs: no `enum`, `namespace`, parameter properties, `experimentalDecorators`) |
| `node --check file.ts` | fails: `--check` does not strip types, so `STATIC-01` cannot parse `.ts` files that way |
| `ELECTRON_RUN_AS_NODE=1 electron main.ts` | runs (Electron's Node strips types like Node does) |
| Electron 45 main process importing a `.ts` module, and `utilityProcess.fork('child.ts')` | both run (checked with a `.mjs` bootstrap that imports `main.ts` after `ready`); a `.ts` file as the `"main"` entry itself is open check E1 |
| Dependencies with type declarations | `transcribe-cpp` (`dist/index.d.ts`), `@elevenlabs/elevenlabs-js`, `dotenv`, `electron` ship their own; `ws` needs `@types/ws`; `sherpa-onnx-node` ships none (only `Vad` is used, from `lib/vad.js`) |
| `graphify` | indexes `.ts` (listed with `.py`, `.go`), so `graphify update .` keeps working |

## 2. Decisions

Each needs a yes from the owner before its phase starts; the recommendation is first.

| # | Decision | Recommendation | Why |
|---|---|---|---|
| D1 | How `.ts` runs on the server side | **Node's own type stripping, no build step.** `node server.ts`, `.ts` import specifiers, `tsc --noEmit` as the checker. Bump `engines.node` to `>=22.18`. | Everything already runs Node 24 (CI, Docker, Electron 45). Stack traces keep their line numbers (types are replaced by blanks). No emitted files, no `dist/` for the server, the installers package the sources as today. |
| D2 | How `.ts` reaches the browser | **Sources in `web/*.ts`, `tsc -p tsconfig.web.json` emits `public/*.js`; the emitted files are committed, and a static check fails when they are stale.** | Browsers do not strip types, so the page needs one emit step. Committing the output keeps `git clone && npm install && npm start`, the Dockerfile (`npm install --omit=dev`, `COPY . .`), the CI workflow and `build.files` exactly as they are, and the route table, `STATIC-04` and `PROT-STATIC-02` unchanged. The output is the current JavaScript with the annotations removed, so diffs stay readable. Alternative: gitignore `public/*.js` and add `prestart`/`pretest`/`predist` hooks plus a build stage in the Dockerfile and a step in CI; choose this if committed output is unwanted. |
| D3 | One compiler for both sides | **`typescript` only; no esbuild, no bundler.** | `tsc` checks and emits; `rewriteRelativeImportExtensions` lets `web/*.ts` import `./stage.ts` and emit `./stage.js`. One devDependency. |
| D4 | Types before syntax | **Phase 1 writes the types as `types/*.ts`, Phase 2 attaches them to the JavaScript with JSDoc, Phase 3 renames.** | The user asked for it in this order; it also means every module is typed and checked before any rename, so the renames are mechanical and the test suites catch nothing new. |
| D5 | Strictness | **`strict: true` from day one, `checkJs` per file (`// @ts-check`) until every file has it, then global.** Amended in N7 (2026-11-07): the test suites are checked in their own project, `tsconfig.test.json`, strict except for `noImplicitAny`. | Turning strict on later means doing the annotations twice. The suites' callbacks probe messages and stand-ins loosely by design; `noImplicitAny` would have asked for about 700 parameter annotations that say nothing, while the rest of `strict` found the real gaps. |
| D6 | What stays JavaScript | `test/ui/preload.cjs` (Electron preload, CommonJS, injected into Chromium: no stripping there); `python/`, `native/` untouched. | Not worth a build step for one file. |
| D7 | Step size | **One branch and one pull request per batch in §5–§7; `npm test` before each merge, `test:full` where CLAUDE.md asks (audio, voice detection, crosstalk, session, engines, transcriber).** | Small diffs, each reviewable in minutes; `main` stays green between them. |

## 3. Phase 0 — tooling (no code changes)

Branch `ts/0-tooling`. Nothing in `lib/`, `public/` or `server.js` changes.

1. `npm install -D typescript @types/node @types/ws @types/audioworklet` (the last one gives `pcm-worklet.js` its
   `AudioWorkletProcessor` and `sampleRate` globals).
2. `tsconfig.json` — the Node project: `server.js`, `lib/`, `scripts/`, `desktop/`, `test/`, `types/`:
   `strict`, `allowJs`, `checkJs: false` (files opt in with `// @ts-check` in Phase 2), `noEmit`,
   `module: nodenext`, `target: es2024`, `lib: ["es2024"]`, `types: ["node"]`, `allowImportingTsExtensions`,
   `verbatimModuleSyntax`, `erasableSyntaxOnly` (TypeScript 5.8+: rejects exactly what Node rejects),
   `skipLibCheck`. `test/ui/preload.cjs` is included as JavaScript and stays so.
3. `tsconfig.web.json` — the page: `public/` now, `web/` from Phase 4: `lib: ["es2024", "dom", "dom.iterable"]`,
   `types: ["audioworklet"]`, no Node types (the page must not see `process` or `Buffer`),
   `moduleResolution: bundler`, same strictness. The page's absolute imports (`'/stage.js'`) become relative
   (`'./stage.js'`) in Phase 2 so the compiler resolves them without a `paths` map; the browser treats the two the
   same, and `server.js`'s route table is untouched.
4. `types/vendor.d.ts`: `declare module 'sherpa-onnx-node'` with the `Vad` class as `lib/vad.js` uses it (and any
   other module without declarations that turns up).
5. `package.json`: `"typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.web.json"`;
   `engines.node` → `>=22.18`; README's prerequisites say the same.
6. New static check **`STATIC-06`** in `test/run-all.js`: `npm run typecheck` exits 0 (its output is the detail).
   It runs in every tier (`quick` included), so a type error fails `npm run test:quick` from here on. TESTING.md
   §7.1 row, §11 (a new "Source code: syntax and types" row), §13 line.
7. `graphify update .` (nothing to index yet; confirms `.ts` support on this install).

Done when: `npm run typecheck` passes on the untouched code, `npm run test:quick` passes with `STATIC-06`.

What happened (2026-11-06): `npm install` brought TypeScript **7.0.2**, the native compiler (`tsc` is a small Node
launcher for a platform binary, so `test/run-all.js` runs it through `process.execPath` as it runs everything else);
it knows every option above, and both projects passed on the untouched code at the first run, in well under a
second each. `@types/audioworklet` sits next to `lib: ["dom"]` without a clash. The owner started Phase 0 with the
recommendations of §2 (D1, D3, D4, D5 in effect; D2 is decided when Phase 4 starts).

## 4. Phase 1 — the types

Branch `ts/1-types`. A `types/` folder of type-only `.ts` files: the shapes that cross module boundaries, written from
what the code does today, not from what it should do. Nothing imports them yet, so nothing runs differently; the
pull request is a review of the domain model. Shapes that live inside one module (a class's private bookkeeping)
are not here; they get their annotations in that module in Phase 2.

`types/protocol.ts` — the WebSocket contract between `server.js`/`lib/session.js` and `public/app.js`, the one
place both sides must agree. Server → page, a discriminated union on `type`:

| `type` | fields (from the `send(...)` sites) |
|---|---|
| `models` | `active: string \| null`, `models: ModelInfo[]` (`id, label, engine, tier, reason, size, download, notes, cloud, installed, progress: number \| null`) |
| `status` | `state: TranscriberState`, `message`, `model: string \| null`, `device: string \| null`, `fallback: string \| null`, `language`; `detector?: string` on the first message of a connection |
| `tuning` | `values: Tuning`, `defaults: Tuning`, `ranges: TuningRanges` |
| `mics` | `max: number` |
| `progress` | `id: string`, `progress: number` (0–1) |
| `error` | `message: string` |
| `vad` | `mic: number`, `speaking: boolean`, `id: number` |
| `partial` | `mic`, `id`, `start: number`, `text: string` |
| `final` | `mic`, `id`, `text: string`; with text: `start`, `end`, `model: string`, `ms: number`; `text: ''` withdraws the line |
| `file` | `kind: 'text' \| 'audio'`, `mic?: number`, `name: string`, `path: string` |
| `behind` | `seconds: number` (0 = caught up) |
| `options` | `saveAudio: boolean` (the server turned saving off) |

Page → server: `options { saveAudio?, steadyLive? }`, `resume { name: string \| null, samples: number }`, `flush`,
`reset`, `select { id }`, `install { id }`, `tuning { values?: Partial<Tuning>, reset?: boolean }`. Binary frames:
`Float32Array` PCM at 16 kHz; on `/ws?mics` a `Uint32` mic count first, then each mic's samples. Also here: the
`BroadcastChannel` messages between the main window and the caption windows (`hello`, `here`, `bye`, `gone`,
`snapshot`, `options`), typed from `public/app.js`.

`types/model.ts` — `EngineKind = 'whisper.cpp' | 'transcribe.cpp' | 'python-nemo' | 'apple-speech' | 'elevenlabs'`,
`Tier = 'recommended' | 'other'`, and `Model`: the common fields every entry of `MODELS` has (`id, label, tier,
reason, engine, size, notes`) plus the per-engine ones as a union on `engine` (`file`/`url` for a single-file
download, `dir`/`files` for a folder, `downloadSize`, `convert` for the Whisper fine-tunes, `nemo` and `python`,
`apple { module, preset }`, `elevenlabs { modelId }`, `cloud`, `noPrompt`, `dockerSlow`). `SILERO_VAD`'s shape.

`types/config.ts` — `Config` as `lib/config.js` builds it (`host, port, publicPort, inDocker, transcriptsDir,
settingsFile, defaultModel, autoInstall, language, threads, whisper {bin, port, initialPrompt}, vad {engine, sileroModel,
sileroThreshold, minRms, noiseRatio, silenceMs, preRollMs, minSpeechMs, maxSegmentSec}, partialEverySec, elevenlabs
{apiKey, baseUrl}, maxMics, crosstalkDb`), `Tuning` (the six live settings), `TuningKey`, `TuningRange {min, max,
step}`, `TuningRanges`, and `Settings` (the `.settings.json` file: `model?`, `tuning?`).

`types/engine.ts` — what `lib/transcriber.js` needs from an engine: `load()`, `unload()`, `kill()`,
`transcribe(samples, { prompt? }) → Promise<TranscribeResult>`, `device: string | null`, `fallback: string | null`,
`supportsPrompt`, optional `stream(opts) → StreamingSentence { push, commit, cancel, closed, ready }` (ElevenLabs);
the `SidecarEngine` hooks (`command(port, { cpu })`, `deviceFromLog?`, `cpuFallback`); `TranscribeResult`
(`text`, `segments?`) and the transcriber's `{ ...result, ms, model }`; `TranscriberState = 'idle' | 'loading' |
'ready' | 'error'`, `TranscriberStatus` (the `status()` object, also the `status` message's body); the `Transcriber`
events (`'state'`).

`types/audio.ts` — `Frame` (one 32 ms frame as `Segmenter.analyze()` returns it and `CrosstalkGate.push()` reads it),
`Segment` (`{ id, samples, start, end }` from `onSegment`), `SegmenterOptions` (detector, the three callbacks,
`startFrame`, `leftover`, `newId`, the four timing values), `Detector` (`name`, `setThreshold?`, the frame method
both detectors share), `Floors` (what the gate learned, carried across reconnects, #44), `WavWriter` options.

`types/page.ts` — `StagePrefs { size, lines, theme: 'dark' | 'contrast' | 'light' }`, `StageSnapshot`, `MicPick
{ id, label, muted? }`, `SpeakerPick`, `Line` (the `lines` map's records), `Backlog` and what `take()` returns,
`CaptureHandle { slots, reattach, mute, close }`, the hooks `createStage`, `createSettings`, `openCapture` and
`openSpeaker` take, the `store` wrapper over `localStorage`.

`types/test.ts` — what `test/helpers.js` returns: the server handle from `startServer` (`port, pid, dir, url, ws(),
…`), `suite()`'s `check`, the fake ElevenLabs and the fake server, `streamWav`'s options.

Review rules: every `send({ type: … })` in `server.js` and `lib/session.js`, every `case '…'` in `public/app.js`,
every field read off a message, every entry of `MODELS`, is accounted for; `PROT-*` tests are the second reader.
Done when `npm run typecheck` still passes (the files are checked but unused) and the owner has read the folder.

What happened (2026-11-06): seven files, `types/config.ts`, `model.ts`, `engine.ts`, `audio.ts`, `protocol.ts`,
`page.ts` and `test.ts`, next to Phase 0's `vendor.d.ts`. `page.ts` needs the DOM's types, so it belongs to the web
project alone (`tsconfig.web.json` includes it, `tsconfig.json` excludes it); `CaptionRow` and `StageSnapshot` live in
`protocol.ts`, where the caption-window channel is, so neither project sees the other's globals. `Model` is a union
on `engine` over a base whose per-engine fields are optional, so code that reads `model.file ?? model.dir` on any
model still types. The `final` message is one interface with optional times: its withdrawn and published forms
share a `type`. Both projects pass with the folder in; nothing imports it yet.

## 5. Phase 2 — the types into the JavaScript (JSDoc, `// @ts-check`)

The longest phase, in batches from the leaves of the module graph to its roots, so a module is annotated only after
everything it imports is. Each file: `// @ts-check` on line one, `/** @import { Model } from '../types/model.ts' */`
for the shared shapes, `@param`/`@returns`/`@type`/`@typedef` on the rest, `@satisfies` for the literal tables
(`MODELS`, `TUNING`, `STATIC`), class fields typed where the constructor assigns them. Keep every line of logic;
a real bug the checker finds is fixed in its own commit, with a test (`UNIT-*` or `PROT-*`), named in TESTING.md
§13. Where the checker complains about something that is correct, narrow the type or add a one-line reason; never
`// @ts-ignore` without one, never widen to `any` to be done faster.

| Batch | Files | Before merge |
|---|---|---|
| N1 | `lib/wav.js`, `lib/text.js`, `lib/wer.js`, `lib/steady.js`, `lib/tuning.js`, `lib/config.js`, `lib/python-env.js`, `lib/benchmark/audio.js`, `lib/benchmark/metrics.js`, `public/order.js` | `npm test` |
| N2 | `lib/vad.js`, `lib/segmenter.js`, `lib/crosstalk.js`, `lib/convert-whisper.js`, `lib/models.js`, `lib/engines/sidecar.js` | `npm test`, then `npm run test:full` |
| N3 | `lib/engines/whisper-cpp.js`, `transcribe-cpp.js`, `python-nemo.js`, `apple-speech.js`, `elevenlabs.js`, `lib/transcriber.js` | `npm test`, then `npm run test:full` |
| N4 | `lib/session.js`, `server.js` | `npm test`, then `npm run test:full` |
| N5 | `lib/benchmark/dataset.js`, `machine.js`, `suite.js`, `report.js`, `scripts/*.js`, `scripts/manual.mjs` | `npm test`; `npm run benchmark -- --help`-level smoke of each script (no model downloads, no ElevenLabs) |
| N6 | `desktop/main.mjs` (Electron's own `electron.d.ts`) | `npm test` (`UI-*` runs in Electron), `npm run app` started and quit once |
| B1 | `public/backlog.js`, `public/stage.js`, `public/pcm-worklet.js`; imports made relative | `npm test` |
| B2 | `public/settings.js`, `public/mics.js`, `public/speaker.js` | `npm test` |
| B3 | `public/app.js` | `npm test` |
| N7 | `test/helpers.js`, `test/stream-wav.js`, `test/unit.js`, `test/protocol.js`, `test/smoke.js`, `test/scenarios.js`, `test/meeting.js`, `test/stress.js`, `test/run-all.js`, `test/ui/run.mjs`, `test/ui/stress.mjs` | `npm test`; `npm run test:stress -- --short` only if the owner asks |
| N8 | flip `checkJs: true` in both tsconfigs, delete every `// @ts-check` | `npm run test:quick` |

A batch may be split further when its diff passes about 400 changed lines.

What happened in N1 (2026-11-06, `ts/2-n1`): ten files, about 210 lines added, all comments but for five casts and one
local alias, where `strict` could not see what the code knows: `Object.entries(TUNING)` loses its keys (cast to
`[TuningKey, TuningRange][]`), `.at(-1)` may be undefined (a cast in `inRoom`, an alias `finalKeys` in
`liveSteadiness`), a catch variable is `unknown` (`/** @type {any} */` on it in `WavWriter`), and `child.on('error')`
hands an `Error` without `code` (`NodeJS.ErrnoException`). The checker inferred `WavWriter`'s `fd` and the
segmenter-free modules without help. `Spoken`, which `public/order.js` shares with `lib/session.js`, moved from
`types/page.ts` (web only) to `types/protocol.ts`, so the Node project can import it. The drafts were written in a
detached worktree in the scratchpad while the gate run read the main tree; worth repeating for every batch.

What happened in N2 (2026-11-06, `ts/2-n2`): six files. Casts and short aliases as in N1, plus three things a
comment could not do. `SidecarEngine` now names on itself what its subclasses provide (`cpuFallback = false`,
`defaultDevice = undefined`, a `command()` that throws, a `deviceFromLog()` that answers null): the checker cannot see
a subclass's additions through `this`, and these defaults do exactly what their absence did. The crosstalk gate's two
`+= boolean` counters coerce with `Number()`. The segmenter's timing fields, set by `setTiming()` rather than the
constructor, carry a declared type, or the checker adds `undefined` to them. `NoiseFloor.forget` compares `.at(-1)`
with `>=` and relies on undefined comparing false; a `number` cast with a comment keeps that. The models catalogue
typed as `Model[]` without a change, and so did `Readable.fromWeb(res.body)` once told the two stream types are one.
Full tier: 236 / 0 / 5 / 0. After N8 every file is checked under

What happened in N3 (2026-11-06, `ts/2-n3`): the five engines and the transcriber. The engines' `Object.assign(this,
{ … })` shorthands became plain `this.x = x` assignments, which is the only way the checker learns a class's fields.
The in-process engine types what it needs from a loaded model (`LoadedModel`), so transcribe.cpp's `TranscribeModel`
and the tests' stand-ins both fit; the cloud engine takes its connection and query types from the SDK's client
(`Awaited<ReturnType<…connect>>`), and its two private resolver fields start as no-ops because the checker cannot see
that a Promise executor runs at once. `clearTimeout(x)` on a `Timeout | null` field became `clearTimeout(x ??
undefined)`, Node's types taking no null. Full tier: 236 / 0 / 5 / 0.

What happened in N4 (2026-11-06, `ts/2-n4`): `lib/session.js` and `server.js`, with four typedefs for the session's
records (a mic's channel, a sentence from the moment it goes to the model, a held line, an audio file) and the
server's messages typed against `types/protocol.ts` end to end: every `send()` is checked against the contract, and
the page's messages are narrowed by `type` in the switch. Casts where the code knows what the checker cannot (the
current sentence during its own callbacks, the transcript's name once claimed, the gate when the callers checked);
`Number.isSafeInteger()` does not narrow, so `resume()` names its count once. `types/vendor.d.ts` declares the
`parentPort` an Electron utility process has. Full tier: 236 / 0 / 5 / 0.

What happened in N5 (2026-11-07, `ts/2-n5`): the benchmark library and the scripts. The shapes of a run's JSON are
written down in `lib/benchmark/suite.js` (stages, a model's result, the run) and read by the report and the runner,
so the producer and the consumer are checked against each other; `machine.js` describes its `MachineInfo`.
`median()` says it skips gaps, as it always did. Standard tier: 216 / 0 / 2 / 0; `npm run setup -- --list` runs.

What happened in N6 (2026-11-07, `ts/2-n6`): `desktop/main.mjs`, typed by Electron's own `electron.d.ts`. Three casts:
the utility process's `env` (a spread of `process.env` loses its index signature), its two output streams (typed as
possibly absent), and a menu entry inside a conditional spread, which loses its literal type. Standard tier 216 / 0 /
2 / 0, and the app started once from source in test mode (`LT_TEST=1`, scratch settings): its server reported the model
ready on the GPU, and it quit cleanly on the signal.

What happened in N7 (2026-11-07, `ts/2-n7`): every file in `test/` but `ui/preload.cjs`. Checked under full `strict`,
the five large suites reported about a thousand errors, two thirds of them untyped callback parameters: test code
probes messages, files and stand-ins loosely, by design. So the suites got their own project, `tsconfig.test.json`,
strict except for `noImplicitAny` (D5 amended); `STATIC-06` and `npm run typecheck` run all three projects. The 230
errors that remained were real gaps, mostly stand-ins the app's types did not take: three became interfaces the
app's code takes (`TranscriberLike` for what a session needs from the transcriber, `VadPool` generic over what its
maker returns, `ReportRun` for what the report needs of a run), `Engine.supportsPrompt` became optional, and the rest
were `let x = null` variables and empty arrays inside object literals, which the checker types as `null` and `never[]`.
Code changes only where the checker was right about a gap, each behaviour-neutral: `JSON.parse(data)` on a Buffer now
`.toString()`s it, `FinalizationRegistry.register` gets its second argument, the stand-in model carries the catalogue's
fields, two `Date` subtractions use `getTime()`. Standard tier: every check passed (157 of 157), but the UI suite then
hung in its teardown and was killed at its 10-minute limit (`UI-RUN` failed); the same tier on the page batches right
after, with the same test code, passed with the UI suite at its usual 2 minutes (216 / 0 / 2 / 0), so the hang was a one-off
(TESTING.md §12). The batch was committed before that report was read: the gate's result was taken from the exit code
of a piped command, which is the pipe's, not the runner's. Read the verdict line.

What happened in B1, B2 and B3 (2026-11-07, `ts/2-b1` … `ts/2-b3`): the page, typed against `types/protocol.ts` and
`types/page.ts`. The backlog's types moved to `types/audio.ts`, because the unit tests import the backlog and the
Node project must not see DOM types; `types/page.ts` declares Chromium's `AudioContext.setSinkId`, which the DOM
library lacks. The page's imports of its own modules became relative. Numbers written to `dataset` and input values
go through `String()`, the stage and settings handles start without a null, a final line is a `Line` with its `end`,
and a stage button with no hook calls it optionally (the button is hidden then). Casts where the DOM's types are wider
than the markup. One gate for the three stacked branches: standard tier 216 / 0 / 2 / 0.

What happened in N8 (2026-11-07, `ts/2-n8`): `checkJs: true` in `tsconfig.json` and `tsconfig.web.json` (the test
project inherits it), and the 52 `// @ts-check` lines gone. All three projects pass; quick tier 149 / 0 / 1 / 0 with
`STATIC-06` naming the three projects. Phase 2 is complete: every JavaScript file in the app is type-checked under
`strict` (the suites without `noImplicitAny`), with the shared shapes in `types/` and the rest as JSDoc. Phase 3 can
rename files mechanically.
`strict`, and the only `any` left are the ones written on purpose with a reason.

## 6. Phase 3 — the server side becomes `.ts`

Mechanical once Phase 2 is done: `git mv x.js x.ts`, the JSDoc becomes inline annotations (and is deleted where it
only repeated a type), type-only imports become `import type`, and **every importer's specifier changes to
`./x.ts`** (Node needs the real extension; the compiler enforces it with `allowImportingTsExtensions` and the test
suites catch a missed one at once, since the module fails to load). Same order as Phase 2, one batch per pull
request: N1, N2, N3, then N4, N5, N6, N7.

What else moves when `server.js` becomes `server.ts` (batch N4) and the tests and desktop follow (N6, N7):

- `package.json`: `"start": "node server.ts"`, `build.files` (`server.ts`, `desktop/main.ts`), `"main"` → `desktop/main.ts`
  if E1 (§10) confirms Electron takes a `.ts` entry, else `desktop/main.mjs` becomes the one-line bootstrap
  `import './main.ts';` and the typed code lives in `desktop/main.ts`;
- `Dockerfile` `CMD ["node", "server.ts"]`; `.github/workflows/desktop.yml` `node test/smoke.ts`;
- `desktop/main.*`: `utilityProcess.fork(… 'server.ts')`; `test/helpers.js`, `test/smoke.js`, `test/protocol.js`
  (`server.ts`, `stream-wav.ts`), `test/run-all.js` (`smoke.ts`), `scripts/benchmark-suite.ts` (its own name);
- `test/run-all.js`: `STATIC-01` walks `.ts` too but parses `.ts` through `STATIC-06` (`node --check` cannot), its
  file list also feeds the `STATIC-03` id scan, so `.ts` test files must be in it; `STATIC-02` expects `server.ts`
  and `desktop/main.ts`; TESTING.md §5, §7.1 and every `file.js` mention in it; README's 27 paths;
- Node 22.18–23.x print one `ExperimentalWarning` for type stripping on stderr (24 does not); `startServer` waits
  for the ready line on stdout, so nothing in the tests depends on it.

Check in N1 of this phase, once, that `node server.ts` starts no slower than `node server.js` did (the first `.ts`
import loads the stripper; expected well under 100 ms against a model load of seconds), and that a thrown error's
stack trace still names the right line.

What happened in N1 (2026-11-07, `ts/3-n1`): nine files renamed (`git mv`, so `git log --follow` keeps their
history), their JSDoc turned into inline types and deleted where it only repeated one: `import type` for the shared
shapes, parameter and return types, class fields declared (`WavWriter`'s four), `satisfies TuningRanges` on `TUNING`,
`export type Steadiness` in `metrics.ts` instead of a `@typedef`, `err: any` in the catches. One local changed
shape: `WavWriter`'s resume path kept a `fd` variable that was `undefined` until the file opened; it is now typed
`number | undefined` and assigned once, so `this.fd` is a plain `number`. Twenty-five importers were repointed
(`server.js`, `lib/`, `scripts/`, `test/`; a `perl` substitution, then a grep for any `.js` specifier left), and the
`.js` mentions in README, TESTING.md §7, `types/config.ts`'s comments and the user-manual skill followed.
`public/order.js` stays JavaScript until Phase 4: the page loads it unbuilt, so it cannot become `.ts` on its own.
The checks the plan asked for: importing `lib/session.js` (which pulls in the nine) takes ~24 ms against ~4 ms
before, the stripper's one-time load, well under the 100 ms budget and nothing against a model load of seconds;
`node server.ts` itself is measured in N4, when the entry moves. A thrown error's stack trace names the `.ts` line
(`lib/tuning.ts:36:44`, checked against the source). `node --check` cannot parse `.ts`, so `STATIC-01` keeps
parsing the `.js` files and `STATIC-06` (tsc) is the syntax check for `.ts` until N7 extends the walk.

What happened in N2 (2026-11-07, `ts/3-n2`): six files, N1's pattern, with one addition: a field the constructor
does not set (`SidecarEngine`'s `url`, `ready`, `device` and `fallback`, which `load()` sets; `Segmenter`'s four frame
counts, which `setTiming()` sets; `Transcriber`'s `device` and `lastCrashAt` in N3) is a `declare` field. Node strips
it like a type, so the running class defines no property the old code did not; a plain field declaration would
define it as `undefined` from the constructor on. `VadPool<V extends { reset(): void } = Vad>` replaces the
`@template`. Two things typed differently once the file was TypeScript: `Object.entries` of a `JSON.parse` result
is `[string, unknown][]` in a `.ts` file where the `.js` file got `any`, so `convert-whisper.ts` names the safetensors
header (`SafeTensor`) and the vocabulary (`Record<string, number>`); and `SidecarEngine.fallback` is
`string | undefined` where the JavaScript inference had `any`, so `UNIT-GPU-04` wraps it in `String()` as
`UNIT-GPU-03` already did. The `.js` mentions followed in README's file table, TESTING.md §7, the types' comments,
`public/app.js`'s one comment and the user-manual skill's `git log` paths; the history rows of TESTING.md §13 and
§14 keep the names the files had then.

What happened in N3 (2026-11-07, `ts/3-n3`): the five engines and the transcriber, six files, nothing new in kind.
`declare` for `TranscribeCppEngine.hint`, `ElevenLabsEngine.query`, `Transcriber.device` and `Transcriber.lastCrashAt`,
which `load()` or a crash sets. The three `@typedef`s of `transcribe-cpp` (`LoadedModel`, `DeviceInfo`, `LoadModel`)
are exported types, so a test's stand-in can name them; the ElevenLabs shapes stay derived from the SDK's own types
(`typeof import('@elevenlabs/elevenlabs-js')`), as the JSDoc had them; `Sentence.onPartial` is
`NonNullable<StreamOptions['onPartial']>`. The three projects were green on the first run. README's file table
(`lib/engines/*.ts`) and the types' comments followed.

What happened in N4 (2026-11-07, `ts/3-n4`): `lib/session.ts` and `server.ts`, N1's pattern throughout (the
session's four `@typedef`s are local types; its twenty-six fields are declared, all set by the constructor). The
entry's name moved with it: `package.json` (`start`, `build.files`), the Dockerfile's `CMD`, `tsconfig.json`'s
include, the desktop app's `utilityProcess.fork`, the tests that start a server (`test/helpers.js`, `test/smoke.js`,
`test/protocol.js`) and `test/run-all.js`, whose `STATIC-02` expects `server.ts` and whose `STATIC-04` reads it; the
workflow's smoke step (`node test/smoke.js`) did not change. `STATIC-01` no longer lists the entry: `node --check`
cannot parse `.ts`, and tsc (`STATIC-06`) parses every `.ts` file; N7 extends the walk. The start-up check the plan
asked for: `node server.ts` reaches its ready line in 64 ms, `node server.js` did in 63 ms (medians of five starts,
`parakeet-ro-110m` chosen; the stripper was already loaded by the `.ts` modules the server imports since N1). The `.js` mentions followed in README (the diagram and the file table), TESTING.md §5 and §7.1,
the types' comments, `public/order.js`'s comment, `lib/benchmark/suite.js`'s and the user-manual skill's `git log`
paths.

What happened in N5 (2026-11-07, `ts/3-n5`): the four benchmark modules, the four scripts and `scripts/manual.mjs`,
which is `scripts/manual.ts` now: it starts itself again inside Electron, and Electron 45 took the `.ts` entry (that
settles E1, §10). The run's JSON shapes (`suite.ts`'s twenty-four `@typedef`s), `machine.ts`'s five, `dataset.ts`'s
`Clip`, `report.ts`'s `ReportRun` and the suite script's `Opts` are exported types, as the tests import some of them.
`benchmark-suite.ts` names its own file twice (the worker it spawns, and the guard that runs `main()` only when it is
the entry), both say `.ts`. `package.json`'s five scripts run `node scripts/<name>.ts`. One importer the `from`
pattern missed: `test/run-all.js` loads `lib/benchmark/machine` with a dynamic `import()`, which tsc resolves to the
`.ts` source either way, so only running the file shows the stale specifier; the landing scripts now rewrite that
form too. Smoke, each script run once: `setup.ts --list` lists the models, `compare.ts` without a file prints its usage, `benchmark.ts --models no-such` refuses the
model before touching the dataset, `benchmark-suite.ts --report benchmarks/runs/2026-11-02_20-09_mac-m5` rewrote that run's
`report.md` byte for byte, and `manual.ts --pdf-only` built both PDFs inside Electron (restored afterwards: the
manual is not part of this batch). The `.js` mentions followed in README's file table, TESTING.md §5, the suite's and the
metrics' header comments and the user-manual skill.

What happened in N6 (2026-11-07, `ts/3-n6`): `desktop/main.ts`, and `package.json`'s `"main"` and `build.files` point
at it, as E1 allows (§10): Electron 45 loads a `.ts` entry itself, so the one-line bootstrap the plan kept in reserve
was not needed. Sixteen tags became eleven annotations and casts; `env` is `{ ... } as Record<string, string>` since
`process.env`'s values may be undefined. The static check `STATIC-02` expects `desktop/main.ts` in the installers'
files. Started from source with `LT_TEST=1` (hidden window, no microphone prompt): Electron loaded `desktop/main.ts` as its
entry, forked `server.ts` as the utility process, the server's log said `Parakeet Romanian 110M ready on GPU (Metal)`
within a second, and the app quit on SIGTERM within a second. The `.js` mentions
followed in README's file table, TESTING.md §7.1, `types/vendor.d.ts`'s comment and the user-manual skill.

What happened in N7 (2026-11-07, `ts/3-n7`): the eleven test files (`test/*.js`, `test/ui/run.mjs`, `test/ui/stress.mjs`;
`test/ui/preload.cjs` stays, D6), 264 tags. Too many to patch by hand, so a converter did them: `@import` to
`import type`, one-line `@typedef`s to type aliases, `/** @type */` casts to `as` (a compound expression in its own
parentheses, so `as` binds to all of it), parameter and return types from the `@param`/`@returns` of the block before
each signature (functions, methods, arrows, object-literal arrows), `@template` to a type parameter; it ran until
nothing changed, which reaches a cast inside a cast. Left for the hand: two multi-line `@typedef`s in `stress.ts`,
one `@type` at the end of a doc line in `meeting.ts`, and `meeting.ts`'s arrays and `Room` fields, which JavaScript
inferred from their later pushes and assignments and a `.ts` file does not (`const x = []` is `never[]` there), typed
`any[]` where the module treats them as such and by shape where one is written beside them. A doc comment that had
drifted off `streamWav` is back on it. `STATIC-01` parses the JavaScript files only (`node --check` cannot read
`.ts`) and walks the `.ts` files too, for `STATIC-03`'s id scan; its detail says how many of each. `package.json`'s
`test*` scripts, CI's smoke step, the runner's suite paths, the spawned tools (`stream-wav.ts`), the types' comments
and the docs name the new files. The converter is a session script, not part of the repository: every file it wrote
is in the diff.

## 7. Phase 4 — the page becomes `.ts`

Branch `ts/4-web`. `public/*.js` move to `web/*.ts` (`git mv`, so history follows), keep `web/order.ts` as the one
source `lib/session.ts` imports (`import { spokenOrder } from '../web/order.ts'`), and `tsconfig.web.json` gains
`noEmit: false`, `outDir: public`, `rewriteRelativeImportExtensions: true`, `target: es2022` (what the Electron
Chromium and current browsers run). `npm run build:web` (`tsc -p tsconfig.web.json`) writes `public/app.js` and the
others under their current names: `index.html`, `style.css`, `server.js`'s route table, `STATIC-04` and
`PROT-STATIC-02` do not change. `npm run watch:web` for development.

New static check **`STATIC-07`**: the committed `public/*.js` equal a fresh emit of `web/*.ts` (emit into a temp
folder, compare byte for byte; the detail names the stale file). Per D2 the output is committed; if D2 goes the
other way, this check is replaced by `prestart`/`pretest`/`predist:*` hooks, a `RUN npm run build:web` with a
build stage in the Dockerfile, a build step in the workflow, and `public/*.js` in `.gitignore`.

`web/pcm-worklet.ts` is emitted like the others (`@types/audioworklet` for its globals). The tests that read page
files (`test/ui/*`, `scripts/manual.mjs`) keep reading `public/`.

What happened (2026-11-07, `ts/4-web`): the eight page files moved to `web/*.ts` (`git mv`) and N7's converter turned
their 220 tags into inline types; three things were left to the hand (a `@template` with a constraint and a default,
`<T extends HTMLElement = HTMLElement>`; the multi-line `@type` cast on `els`, now its annotation; the worklet
processor's eight fields, `declare`d), and the project passed `tsc` with no other error, the JSDoc of Phase 2 having
been complete. **One deviation from the plan above:** `tsc` refuses to emit when a source file lies outside `rootDir`
(TS6059), and the page imports the shared types in `types/`, so `outDir: public` with `rootDir: web` is impossible and
`rootDir` is the repository. `scripts/build-web.ts` (`npm run build:web`) therefore emits into a temporary folder and
copies `web/`'s output into `public/`; `--check` is what `STATIC-07` runs, and `npm run watch:web` reruns the build
on every save (`node --watch-path`). `tsconfig.web.json` stays a checking project (`noEmit`; the script passes
`--noEmit false --outDir`), with `rootDir: .`, `newLine: lf` (so the emit is the same on Windows) and
`rewriteRelativeImportExtensions` (`./stage.ts` is emitted as `./stage.js`); `allowJs`/`checkJs` are gone from it,
nothing JavaScript being left in the page project. The emitted `public/*.js` is `tsc`'s formatting, not the
hand-written one: four-space indentation, no blank lines, one-line `if`s split in two, the doc comments kept and the
tags gone, so this batch rewrites the eight files once (same code, the browser runs the same program; `node --check`
and the UI suite agree) and later diffs are local again. Two commits, so that `git log --follow web/app.ts` reaches
`public/app.js`: the move with the types first (the page is not served at that commit), then the emit and its checks. `lib/session.ts` and the unit tests import the sources
(`web/order.ts`, `web/backlog.ts`), so the installers get `web/**` (`STATIC-02`); the UI suite, the manual and the
server keep reading `public/`. Nothing changes for `npm start`, Docker or CI: the emitted files are committed (D2).

## 8. Phase 5 — tighten and clean up

- Remove `allowJs`/`checkJs` from `tsconfig.json` except for `test/ui/preload.cjs`; consider
  `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` (each as its own small pull request, only if the
  errors they raise are worth fixing);
- move types that only one module uses out of `types/` into that module; `types/` keeps the shared contracts
  (`protocol`, `model`, `config`, `engine`, `audio`, `page`, `test`);
- `graphify update .`, README's "How it works" and prerequisites, TESTING.md §5 file table, CLAUDE.md's testing
  section (the `test:full` triggers name `.js` files nowhere, so only this plan's pointer changes);
- `.github/workflows/desktop.yml` gets `npm run typecheck` before the smoke test, so a type error cannot reach a tag.

## 9. Rules for every step

1. Branch off `main` first (`ts/<phase>-<batch>`); commit, merge and push only when the owner asks.
2. No behaviour change in a migration commit. A bug the types reveal is fixed in a separate commit with a test, and
   a line in TESTING.md §13 says what the checker found.
3. `npm run test:quick` while working (it now includes `STATIC-06`); `npm test` before every merge; `npm run
   test:full` for the batches §5 marks, run by the owner or with their go-ahead (TESTING.md §2; the stress tier
   never without being asked). After a merge into `main`: `test:quick` and `smoke`, the heavy tiers when the owner runs
   them (TESTING.md §12 gets the result).
4. TESTING.md changes in the same branch as the test change: §7 ids, §11 coverage, §13 line; `STATIC-03` fails
   otherwise.
5. `graphify update .` after each batch (AST only, no cost).
6. Tests never use `transcripts/`, `.settings.json`, `.env.local` or a real microphone; nothing here changes that.
7. Update the progress log (§11) in the same pull request.

## 10. Risks and open checks

| # | Risk / check | Status | Handling |
|---|---|---|---|
| E1 | A `.ts` file as package.json's `"main"` entry | **confirmed** (2026-11-07, N5): Electron 45 ran `scripts/manual.ts` as its entry script (`electron scripts/manual.ts` built the manual's PDFs); a `.ts` module imported by its main process and a `.ts` utility process had run on 2026-11-06 | N6 tries `"main": "desktop/main.ts"`; if Electron does not take it, `desktop/main.mjs` shrinks to a one-line bootstrap, `import './main.ts';`, and the typed code lives in `desktop/main.ts`. `server.ts` as the utility process works either way |
| E2 | `node --check` cannot parse `.ts` | verified | `STATIC-01` keeps `node --check` for `.js/.mjs/.cjs`; `.ts` is parsed by `tsc` (`STATIC-06`) |
| E3 | Node refuses non-erasable syntax (`enum`, `namespace`, parameter properties) | verified | `erasableSyntaxOnly` in both tsconfigs: the checker refuses it before Node does; string-literal unions instead of enums |
| E4 | A `.js` specifier left behind after a rename | will happen | the module fails to load, every suite that imports it fails at once; `allowImportingTsExtensions` plus `tsc` report it before that |
| E5 | Windows CI (`windows-latest`, Node 24) | low | type stripping is platform-independent; the smoke test on both runners is the check, and it runs on every tag |
| E6 | Startup time of `node server.ts` | low | measured once in Phase 3 N1 (§6) |
| E7 | Stale emitted page files (Phase 4) | by design | `STATIC-07`, in every tier |
| E8 | A type-only import written as a value import of `types/*.ts` | caught | `verbatimModuleSyntax` makes it a compile error; `types/` ships with `lib/**`? No: it is not in `build.files`, and need not be, because every import of it is erased |
| E9 | `engines.node >= 22.18` drops Node 22.12–22.17 | accepted | README says Node 22.18 or newer; CI, Docker and Electron already run 24 |
| E10 | The checker finds real bugs (likely in `public/app.js` and `lib/session.js`, the biggest files) | welcome | own commit, own test, TESTING.md §13 |
| E11 | `sherpa-onnx-node` has no declarations | known | `types/vendor.d.ts` declares the `Vad` surface `lib/vad.js` uses |

## 11. Progress log

| Step | Branch | Status | Date | Notes |
|---|---|---|---|---|
| Plan | `feature/typescript-plan` | written | 2026-11-06 | this document, from the scan of `133a274` |
| Phase 0 | `ts/0-tooling` | merged (`9254b4f`) | 2026-11-06 | TypeScript 7.0.2; `STATIC-06`; both projects green on the untouched code |
| Phase 1 | `ts/1-types` | merged | 2026-11-06 | seven type files; both projects green; nothing imports them yet |
| Phase 2 N1 | `ts/2-n1` | merged | 2026-11-06 | ten files; both projects green; standard tier 216 / 0 / 2 / 0 |
| Phase 2 N2 | `ts/2-n2` | merged | 2026-11-06 | six files; full tier 236 / 0 / 5 / 0 |
| Phase 2 N3 | `ts/2-n3` | merged | 2026-11-06 | six files; full tier 236 / 0 / 5 / 0 |
| Phase 2 N4 | `ts/2-n4` | merged | 2026-11-06 | session and server; full tier 236 / 0 / 5 / 0 |
| Phase 2 N5 | `ts/2-n5` | merged | 2026-11-07 | benchmark library and scripts; standard tier 216 / 0 / 2 / 0 |
| Phase 2 N6 | `ts/2-n6` | merged | 2026-11-07 | the desktop app; standard tier 216 / 0 / 2 / 0; the app started and quit once |
| Phase 2 N7 | `ts/2-n7` | merged | 2026-11-07 | the test suites, in their own project; standard tier 156 / 1 / 2 / 0, the one failure the UI suite's teardown hang (TESTING.md §12); the next run on the same test code passed |
| Phase 2 B1, B2, B3 | `ts/2-b1`, `ts/2-b2`, `ts/2-b3` | merged | 2026-11-07 | the page; one standard tier on the tip: 216 / 0 / 2 / 0 |
| Phase 2 N8 | `ts/2-n8` | merged | 2026-11-07 | `checkJs` on everywhere, no pragmas; quick tier 149 / 0 / 1 / 0. **Phase 2 complete.** |
| Phases 0–2 | `main` | merged, `1541a37` | 2026-11-07 | twelve fast-forwards (`ts/0-tooling` … `ts/2-n8`); full tier on `main` 236 / 0 / 5 / 0 (TESTING.md §12) |
| Phase 3 N1 | `ts/3-n1` | merged | 2026-11-07 | nine leaf modules are `.ts`; the three projects green; standard tier 216 / 0 / 2 / 0 (`test-results/2026-11-07-17-05-16_204bd99/`) |
| Phase 3 N2 | `ts/3-n2` | merged | 2026-11-07 | the detectors, the segmenter, the crosstalk gate, the catalogue, the converter and the sidecar base; full tier 236 / 0 / 5 / 0 (`test-results/2026-11-07-17-15-20_65c785f/`) |
| Phase 3 N3 | `ts/3-n3` | merged | 2026-11-07 | the five engines and the transcriber; full tier 236 / 0 / 5 / 0 (`test-results/2026-11-07-17-30-35_76f3524/`) |
| Phase 3 N4 | `ts/3-n4` | merged | 2026-11-07 | the session and the server entry (`node server.ts`); full tier 176 / 1 / 5 / 0, the one failure the UI suite's teardown hang (TESTING.md §12), then the UI suite alone 60 / 0 / 0 / 0 |
| Phase 3 N5 | `ts/3-n5` | merged | 2026-11-07 | the benchmark library, the scripts and the manual script; standard tier 216 / 0 / 2 / 0 (`test-results/2026-11-07-18-25-33_e30b57b/`); each script smoked |
| Phase 3 N6 | `ts/3-n6` | merged | 2026-11-07 | `desktop/main.ts` is the app's `"main"`; standard tier 216 / 0 / 2 / 0 (`test-results/2026-11-07-18-31-03_8fe032c/`); the app started and quit once (`electron .` from source, `LT_TEST=1`) |
| Phase 3 N7 | `ts/3-n7` | merged | 2026-11-07 | the eleven test files; standard tier 216 / 0 / 2 / 0 (`test-results/2026-11-07-18-36-31_e42855e/`), run by `node test/run-all.ts`. **Phase 3 complete.** |
| Phase 3 | `main` | merged, `085236f` | 2026-11-07 | eight fast-forwards (`ts/3-n1` … `ts/3-n7`, `fix/ui-teardown` between N4 and N5); full tier on `main` 236 / 0 / 5 / 0 in 12 min 12 s (TESTING.md §12) |
| Phase 4 | `ts/4-web` | done, awaiting merge | 2026-11-07 | `web/*.ts` emitted into the committed `public/*.js` (`npm run build:web`, `STATIC-07`); the three projects green; standard tier 217 / 0 / 2 / 0 (`test-results/2026-11-07-19-12-45_4180608/`; the one check more is `STATIC-07`). **Phase 4 complete.** |
| Phase 5 | `ts/5-tighten` | not started | | |
