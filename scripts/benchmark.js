// Scores the models on the whole FLEURS Romanian test set: 883 recorded sentences with checked transcripts
// (Google, CC-BY-4.0). Downloads the set (~500 MB) into benchmarks/data the first time. The one-hour, shareable
// benchmark of everything (accuracy, live text, noise, long sentences, silence) is scripts/benchmark-suite.js.
//
//   npm run benchmark                                  every downloaded model
//   npm run benchmark -- --models canary-1b-v2,jackrabbit-110m-ro --limit 200
//   npm run benchmark -- --name fleurs-ro-docker      separate results, e.g. for a run inside Docker
//
// Each model's transcripts are cached in benchmarks/results/<name>/<model>.json (name defaults to fleurs-ro),
// so an interrupted run resumes where it stopped. The report goes to benchmarks/results/<name>.md.
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from '../lib/config.ts';
import { MODELS, findModel, isInstalled } from '../lib/models.ts';
import { ensureDataset, FLEURS_DIR as DATA } from '../lib/benchmark/dataset.js';
import { Transcriber } from '../lib/transcriber.ts';
import { decodeWav } from '../lib/wav.ts';
import { resultToText } from '../lib/text.ts';
import { editDistance, words } from '../lib/wer.ts';
/** @import { Model } from '../types/model.ts' */

const args = process.argv.slice(2);
/** @param {string} name */
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const limit = Number(option('--limit')) || Infinity;
const name = option('--name') ?? 'fleurs-ro';
const RESULTS = path.join(ROOT, 'benchmarks', 'results', name);
// The cloud model only when named: ElevenLabs bills every second of the ~2.5 h test set.
const ids = option('--models')?.split(',') ?? MODELS.filter((m) => isInstalled(m) && !m.cloud).map((m) => m.id);
const models = ids.map((id) => findModel(id) ?? (console.error(`Unknown model "${id}"`), process.exit(1)));

await ensureDataset(DATA);
// TSV columns: id, file, raw transcription, normalized transcription, characters, samples, gender
const clips = fs.readFileSync(path.join(DATA, 'test.tsv'), 'utf8').trim().split('\n')
  .map((line) => line.split('\t'))
  .map(([, file, ref, , , samples]) => ({ file, ref, seconds: Number(samples) / 16000 }))
  .slice(0, limit);
const audioSec = clips.reduce((n, c) => n + c.seconds, 0);
console.log(`\nFLEURS Romanian test: ${clips.length} clips, ${(audioSec / 60).toFixed(0)} min of audio, ${models.length} models\n`);

// 1. Transcribe (or reuse cached transcripts).
fs.mkdirSync(RESULTS, { recursive: true });
const transcriber = new Transcriber(config);
for (const model of models) {
  const cacheFile = path.join(RESULTS, `${model.id}.json`);
  const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : { hyps: {}, ms: {} };
  const todo = clips.filter((c) => !(c.file in cache.hyps));
  if (!todo.length) {
    console.log(`  ✔ ${model.label}: cached`);
    continue;
  }
  await transcriber.select(model.id);
  if (transcriber.state !== 'ready') {
    console.error(`  ✖ ${model.label}: ${transcriber.message}`);
    continue;
  }
  /** @param {{ file: string }} c */
  const load = (c) => decodeWav(fs.readFileSync(path.join(DATA, 'test', c.file))).samples;
  await transcriber.transcribe(load(todo[0])); // warm-up, not timed
  const t0 = Date.now();
  for (const [i, clip] of todo.entries()) {
    // Clips are independent sentences: no previous-text prompt.
    const result = await transcriber.transcribe(load(clip), { prompt: '', fallback: true });
    cache.hyps[clip.file] = resultToText(result);
    cache.ms[clip.file] = Math.round(result.ms);
    if (i % 25 === 24 || i === todo.length - 1) {
      fs.writeFileSync(cacheFile, JSON.stringify(cache));
      const eta = ((Date.now() - t0) / (i + 1)) * (todo.length - i - 1) / 60000;
      process.stdout.write(`\r  … ${model.label}: ${i + 1}/${todo.length} (about ${eta.toFixed(0)} min left)   `);
    }
  }
  console.log(`\r  ✔ ${model.label}: ${todo.length} clips transcribed                       `);
}
await transcriber.shutdown();

// 2. Score: corpus-level WER (all errors / all reference words), with and without diacritics.
/** @type {{ model: Model, strict: number, plain: number, speed: number, perClip: number }[]} */
const rows = [];
for (const model of models) {
  const cacheFile = path.join(RESULTS, `${model.id}.json`);
  if (!fs.existsSync(cacheFile)) continue;
  const { hyps, ms } = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  const scored = clips.filter((c) => c.file in hyps);
  if (scored.length < clips.length) continue;
  /** @param {boolean} diacritics */
  const tally = (diacritics) => {
    let errors = 0;
    let total = 0;
    for (const c of scored) {
      const r = words(c.ref, { diacritics });
      errors += editDistance(r, words(hyps[c.file], { diacritics }));
      total += r.length;
    }
    return (100 * errors) / total;
  };
  const computeSec = scored.reduce((n, c) => n + (ms[c.file] ?? 0), 0) / 1000;
  rows.push({ model, strict: tally(true), plain: tally(false), speed: audioSec / computeSec, perClip: (1000 * computeSec) / scored.length });
}
rows.sort((a, b) => a.strict - b.strict);

const table = [
  '| # | Model | WER (with diacritics) | WER (diacritics ignored) | Speed | Per sentence |',
  '|---|---|---|---|---|---|',
  ...rows.map((r, i) =>
    `| ${i + 1} | ${r.model.label} | ${r.strict.toFixed(2)} % | ${r.plain.toFixed(2)} % | ${r.speed.toFixed(0)}× real-time | ${r.perClip.toFixed(0)} ms |`),
].join('\n');
const report = `# FLEURS Romanian benchmark

${clips.length} recorded sentences (${(audioSec / 60).toFixed(0)} min), measured on this Mac on ${new Date().toISOString().slice(0, 10)}.

${table}

How it is scored: corpus-level word error rate (all errors / all reference words) against FLEURS's raw
transcriptions. Text is lowercased and punctuation removed, as the Open ASR Leaderboard does. "With diacritics"
counts "sa" for "să" as an error; "diacritics ignored" doesn't, which is how published numbers are computed.
Numbers count as errors when a model writes words for digits ("o sută" vs "100"), the same for every model.
Per-clip transcripts: \`benchmarks/results/${name}/<model>.json\`.
`;
// Sections added by hand after the table (from "## " on, e.g. the one-hour suite's 12-model table) are kept.
const previous = fs.existsSync(`${RESULTS}.md`) ? fs.readFileSync(`${RESULTS}.md`, 'utf8') : '';
const extra = previous.indexOf('\n## ');
fs.writeFileSync(`${RESULTS}.md`, extra >= 0 ? `${report}${previous.slice(extra)}` : report);
console.log(`\n${table}\n\nReport: benchmarks/results/${name}.md\n`);
process.exit(0);
