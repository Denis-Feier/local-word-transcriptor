// Scores the models on the FLEURS Romanian test set: 883 recorded sentences with checked transcripts
// (Google, CC-BY-4.0). Downloads the set (~500 MB) into benchmarks/data the first time.
//
//   npm run benchmark                                  every downloaded model
//   npm run benchmark -- --models canary-1b-v2,jackrabbit-110m-ro --limit 200
//   npm run benchmark -- --name fleurs-ro-docker      separate results, e.g. for a run inside Docker
//
// Each model's transcripts are cached in benchmarks/results/<name>/<model>.json (name defaults to fleurs-ro),
// so an interrupted run resumes where it stopped. The report goes to benchmarks/results/<name>.md.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { config, ROOT } from '../lib/config.js';
import { MODELS, findModel, isInstalled, download } from '../lib/models.js';
import { Transcriber } from '../lib/transcriber.js';
import { decodeWav } from '../lib/wav.js';
import { resultToText } from '../lib/text.js';
import { editDistance, words } from '../lib/wer.js';

const DATA = path.join(ROOT, 'benchmarks', 'data', 'fleurs-ro');
const FLEURS = 'https://huggingface.co/datasets/google/fleurs/resolve/main/data/ro_ro/';

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const limit = Number(option('--limit')) || Infinity;
const name = option('--name') ?? 'fleurs-ro';
const RESULTS = path.join(ROOT, 'benchmarks', 'results', name);
const ids = option('--models')?.split(',') ?? MODELS.filter(isInstalled).map((m) => m.id);
const models = ids.map((id) => findModel(id) ?? (console.error(`Unknown model "${id}"`), process.exit(1)));

async function ensureDataset() {
  if (fs.existsSync(path.join(DATA, 'test.tsv')) && fs.existsSync(path.join(DATA, 'test'))) return;
  console.log('Downloading FLEURS Romanian test set (~500 MB)…');
  await download(`${FLEURS}test.tsv`, path.join(DATA, 'test.tsv'));
  const archive = path.join(DATA, 'test.tar.gz');
  await download(`${FLEURS}audio/test.tar.gz`, archive);
  const tar = spawnSync('tar', ['-xzf', archive, '-C', DATA], { stdio: 'inherit' });
  if (tar.status !== 0) throw new Error('Unpacking FLEURS failed');
  fs.rmSync(archive);
}

await ensureDataset();
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
const rows = [];
for (const model of models) {
  const cacheFile = path.join(RESULTS, `${model.id}.json`);
  if (!fs.existsSync(cacheFile)) continue;
  const { hyps, ms } = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  const scored = clips.filter((c) => c.file in hyps);
  if (scored.length < clips.length) continue;
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
fs.writeFileSync(`${RESULTS}.md`, report);
console.log(`\n${table}\n\nReport: benchmarks/results/${name}.md\n`);
process.exit(0);
