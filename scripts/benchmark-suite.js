// The shareable benchmark: every installed local model through accuracy, speed, live-text steadiness, noise, long
// sentences and silence, on open audio (FLEURS Romanian), sized to fit about an hour, exported with a description of
// the computer so the results can be sent back and compared across machines.
//
//   npm run benchmark:suite                                  every installed local model, 60 min, one at a time
//   npm run benchmark:suite -- --install                     first download every model this computer can run
//   npm run benchmark:suite -- --models canary-1b-v2,orukeet --minutes 30 --parallel 2 --label my-laptop
//   npm run benchmark:suite -- --name 2026-11-03_my-laptop   resume an interrupted run (models already done are kept)
//   npm run benchmark:suite -- --report benchmarks/runs/<name>   rewrite a run's report.md from its run.json
//
// Options: --minutes N (budget, at most 120), --parallel N (models at once; speeds are only comparable at 1),
// --clips N / --live N / --robust N (stage sizes, default 100 / 40 / 25 clips; shrunk to fit the budget),
// --label text (a name for this computer in the results), --fresh (redo models already in the run).
// Results: benchmarks/runs/<date>_<label>/run.json + report.md (+ models/<id>.json, models/<id>.log).
// Send the whole folder back (a GitHub issue or pull request); it holds no personal data (README: Benchmarking).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config, ROOT } from '../lib/config.ts';
import { MODELS, findModel, isInstalled, isAvailable, installModel } from '../lib/models.ts';
import { Transcriber } from '../lib/transcriber.js';
import { machineInfo } from '../lib/benchmark/machine.js';
import { ensureDataset, loadClips, clipSamples, selectClips, audioSeconds, FLEURS_DIR } from '../lib/benchmark/dataset.js';
import { runModel, STAGES } from '../lib/benchmark/suite.js';
import { renderReport } from '../lib/benchmark/report.js';
/** @import { Model } from '../types/model.ts' */
/** @import { ModelResult, Run } from '../lib/benchmark/suite.js' */

/**
 * The command line as the run understands it (parseArgs).
 * @typedef {{ minutes: number, parallel: number, sizes: { accuracy: number, live: number, robustness: number }, models: string[] | undefined,
 *   label: string | undefined, name: string | undefined, install: boolean, fresh: boolean, report: string | undefined, worker: boolean,
 *   out: string | undefined, deadline: number, budgetSec: number }} Opts
 */

const MAX_MINUTES = 120;
const RUNS = path.join(ROOT, 'benchmarks', 'runs');

/**
 * The command line as the run understands it; exported for the tests.
 * @param {string[]} argv
 * @returns {Opts}
 */
export function parseArgs(argv) {
  /** @param {string} name */
  const option = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  /**
   * @param {string} name
   * @param {number} fallback
   * @param {number} [min]
   * @param {number} [max]
   */
  const int = (name, fallback, min = 1, max = Infinity) => {
    const v = option(name);
    if (v === undefined) return fallback;
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n)) throw new Error(`${name} needs a number, got "${v}"`);
    return Math.max(min, Math.min(max, n));
  };
  return {
    minutes: int('--minutes', 60, 5, MAX_MINUTES),
    parallel: int('--parallel', 1, 1, 8),
    sizes: { accuracy: int('--clips', STAGES.accuracy.full, 5, 883), live: int('--live', STAGES.live.full, 3, 883), robustness: int('--robust', STAGES.robustness.full, 3, 883) },
    models: option('--models')?.split(',').map((s) => s.trim()).filter(Boolean),
    label: option('--label')?.replace(/[^\w.-]+/g, '-').slice(0, 40),
    name: option('--name'),
    install: argv.includes('--install'),
    fresh: argv.includes('--fresh'),
    report: option('--report'),
    worker: argv.includes('--worker'),
    out: option('--out'),
    deadline: Number(option('--deadline')) || Infinity,
    budgetSec: Number(option('--budget')) || Infinity,
  };
}

const stamp = () => new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
/**
 * @param {string} file
 * @param {unknown} data
 */
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 1));

/**
 * One model, in this process: writes <out>/models/<id>.json. Started by the orchestrator below (or by a test).
 * @param {Opts} opts
 */
export async function worker(opts) {
  const model = /** @type {Model} */ (findModel(/** @type {string[]} */ (opts.models)[0])); // the orchestrator names one installed model
  const out = /** @type {string} */ (opts.out); // and where to write
  const clips = loadClips(FLEURS_DIR);
  const transcriber = new Transcriber(config);
  /** @param {string} line */
  const log = (line) => console.log(line);
  /** @type {ModelResult} */
  let result;
  try {
    result = await runModel({
      model, transcriber, clips, load: (c) => clipSamples(c, FLEURS_DIR), deadline: opts.deadline, budgetSec: opts.budgetSec, sizes: opts.sizes, partialEverySec: config.partialEverySec, log,
    });
  } catch (/** @type {any} */ err) {
    result = { id: model.id, label: model.label, engine: model.engine, error: err.message, finishedAt: new Date().toISOString() };
    console.error(`✖ ${model.label}: ${err.message}`);
  }
  await transcriber.shutdown();
  fs.mkdirSync(path.join(out, 'models'), { recursive: true });
  writeJson(path.join(out, 'models', `${model.id}.json`), result);
  return result;
}

/**
 * Writes run.json and report.md from the models' files.
 * @param {string} out
 * @param {Run} run
 */
function assemble(out, run) {
  const dir = path.join(out, 'models');
  run.models = run.modelIds.map((id) => {
    const file = path.join(dir, `${id}.json`);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { id, label: findModel(id)?.label ?? id, pending: true };
  }).filter((m) => !m.pending);
  writeJson(path.join(out, 'run.json'), run);
  fs.writeFileSync(path.join(out, 'report.md'), renderReport(run));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.worker) {
    await worker(opts);
    process.exit(0);
  }
  if (opts.report) {
    const run = JSON.parse(fs.readFileSync(path.join(opts.report, 'run.json'), 'utf8'));
    fs.writeFileSync(path.join(opts.report, 'report.md'), renderReport(run));
    console.log(`Report: ${path.relative(ROOT, path.join(opts.report, 'report.md'))}`);
    return;
  }

  // 1. Models: the local ones this computer can run and has downloaded (never the cloud model: it bills and uploads).
  if (opts.install) {
    for (const m of MODELS.filter((m) => !m.cloud && isAvailable(m) && !isInstalled(m) && (!opts.models || opts.models.includes(m.id)))) {
      console.log(`↓ ${m.label} (${m.downloadSize ?? m.size})…`);
      try {
        await installModel(m, () => {});
      } catch (/** @type {any} */ err) {
        console.error(`  could not install ${m.id}: ${err.message}`);
      }
    }
  }
  const wanted = opts.models ?? MODELS.filter((m) => !m.cloud && isAvailable(m) && isInstalled(m)).map((m) => m.id);
  const models = wanted.map((id) => findModel(id) ?? (console.error(`Unknown model "${id}". See: npm run setup -- --list`), process.exit(1)));
  const missing = models.filter((m) => !isInstalled(m) || m.cloud);
  if (missing.length) {
    console.error(`Not installed (npm run setup -- <id>, or --install): ${missing.map((m) => m.id).join(', ')}`);
    process.exit(1);
  }
  if (!models.length) {
    console.error('No local model is installed. Run: npm run setup -- --all   (or npm run benchmark:suite -- --install)');
    process.exit(1);
  }

  // 2. Audio and the run folder.
  await ensureDataset(FLEURS_DIR);
  const clips = loadClips(FLEURS_DIR);
  const name = opts.name ?? `${stamp()}_${opts.label ?? os.platform()}`;
  const out = path.join(RUNS, name);
  fs.mkdirSync(path.join(out, 'models'), { recursive: true });
  if (opts.fresh) for (const m of models) fs.rmSync(path.join(out, 'models', `${m.id}.json`), { force: true });
  const machine = await machineInfo();
  /** @type {Run} */
  const run = {
    schema: 1,
    name,
    label: opts.label ?? null,
    startedAt: new Date().toISOString(),
    minutes: opts.minutes,
    parallel: opts.parallel,
    sizes: opts.sizes,
    machine,
    dataset: { name: 'FLEURS Romanian test (google/fleurs ro_ro, CC-BY-4.0)', clips: clips.length, minutes: Math.round(audioSeconds(clips) / 60), selection: selectClips(clips, opts.sizes.accuracy).map((c) => c.file) },
    modelIds: models.map((m) => m.id),
    models: [],
  };
  const todo = models.filter((m) => !fs.existsSync(path.join(out, 'models', `${m.id}.json`)));
  console.log(`\nBenchmark ${name}: ${models.length} models (${todo.length} to run), ${opts.parallel} at a time, ${opts.minutes} min budget`);
  console.log(`Computer: ${machine.cpu.model.trim()}, ${machine.ramGb} GB, ${machine.gpus.map((g) => g.name).join(', ') || 'no GPU detected'}; transcribe.cpp sees ${machine.compute.map((d) => d.name).join(', ')}`);
  console.log(`Audio: ${clips.length} FLEURS clips, ${run.dataset.minutes} min; up to ${opts.sizes.accuracy} per model (${Math.round(audioSeconds(selectClips(clips, opts.sizes.accuracy)) / 60)} min)\n`);
  assemble(out, run);

  // 3. The models, through workers: each gets an even share of what is left of the budget. A worker is a process of its
  // own, so a model that crashes takes only its own result with it, and --parallel N runs N models side by side.
  const t0 = Date.now();
  const deadline = t0 + opts.minutes * 60000;
  const queue = [...todo];
  let running = 0;
  await /** @type {Promise<void>} */ (new Promise((resolve) => {
    const next = () => {
      while (running < opts.parallel && queue.length) {
        const model = /** @type {Model} */ (queue.shift()); // the loop runs while the queue has one
        const rounds = Math.ceil((queue.length + 1 + running) / opts.parallel);
        const budgetSec = Math.max(60, (deadline - Date.now()) / 1000 / rounds);
        running++;
        startWorker(model, out, { ...opts, deadline, budgetSec, tag: opts.parallel > 1 || todo.length > 1 }).then(() => {
          running--;
          assemble(out, run);
          next();
        });
      }
      if (!running && !queue.length) resolve();
    };
    next();
  }));
  run.seconds = (Date.now() - t0) / 1000;
  run.finishedAt = new Date().toISOString();
  assemble(out, run);
  const done = run.models.filter((m) => !m.error).length;
  console.log(`\n✔ ${done}/${models.length} models measured in ${(run.seconds / 60).toFixed(0)} min${run.models.some((m) => m.truncated) ? ' (some stages stopped at the deadline)' : ''}`);
  console.log(`Results: ${path.relative(ROOT, out)}/  (report.md, run.json)\nSend that folder back, as a GitHub issue or pull request, to add this computer to the comparison.\n`);
}

/**
 * @param {Model} model
 * @param {string} out
 * @param {{ deadline: number, budgetSec: number, sizes: Opts['sizes'], tag: boolean }} opts
 * @returns {Promise<void>}
 */
function startWorker(model, out, { deadline, budgetSec, sizes, tag }) {
  return new Promise((resolve) => {
    const args = [path.join(ROOT, 'scripts', 'benchmark-suite.js'), '--worker', '--models', model.id, '--out', out, '--deadline', String(deadline), '--budget', String(budgetSec),
      '--clips', String(sizes.accuracy), '--live', String(sizes.live), '--robust', String(sizes.robustness)];
    const log = fs.createWriteStream(path.join(out, 'models', `${model.id}.log`));
    const child = spawn(process.execPath, args, { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const prefix = tag ? `[${model.id}] ` : '';
    /**
     * @param {NodeJS.ReadableStream} stream
     * @param {NodeJS.WritableStream} to
     */
    const relay = (stream, to) => {
      let pending = '';
      stream.on('data', (d) => {
        log.write(d);
        const lines = (pending + d).split('\n');
        pending = /** @type {string} */ (lines.pop()); // split() gives at least one piece
        for (const l of lines) if (l.trim()) to.write(`${prefix}${l}\n`);
      });
    };
    relay(child.stdout, process.stdout);
    relay(child.stderr, process.stderr);
    child.on('exit', (code, signal) => {
      log.end();
      const file = path.join(out, 'models', `${model.id}.json`);
      if (!fs.existsSync(file)) {
        writeJson(file, { id: model.id, label: model.label, engine: model.engine, error: `the benchmark process ended (exit ${code ?? signal}) before writing a result; see models/${model.id}.log`, finishedAt: new Date().toISOString() });
      }
      resolve();
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ROOT, 'scripts', 'benchmark-suite.js')) {
  main().catch((err) => {
    console.error(`✖ ${err.message}`);
    process.exit(1);
  });
}
