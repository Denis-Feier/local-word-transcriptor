// Run several models over the same recording and compare their text, speed and (optionally) accuracy.
//
//   npm run compare -- transcripts/2026-10-29_21-00-00.wav
//   npm run compare -- recording.wav --models whisper-large-v3-turbo,parakeet-tdt-0.6b-v3 --ref reference.txt
//
// The recording must be 16 kHz mono 16-bit WAV (what "Save audio" in the page writes).
// With --ref (the correct transcript as plain text) it also prints the word error rate (WER).
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../lib/config.js';
import { MODELS, findModel, isInstalled } from '../lib/models.js';
import { Transcriber } from '../lib/transcriber.js';
import { Segmenter } from '../lib/segmenter.js';
import { createDetector } from '../lib/vad.js';
import { decodeWav } from '../lib/wav.js';
import { resultToText, contextTail, normalize } from '../lib/text.js';
import { fmtTime } from '../lib/session.js';

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const file = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!file) {
  console.error('Usage: npm run compare -- <recording.wav> [--models id1,id2] [--ref reference.txt]');
  process.exit(1);
}

const ids = option('--models')?.split(',') ?? MODELS.filter(isInstalled).map((m) => m.id);
const models = ids.map((id) => findModel(id) ?? (console.error(`Unknown model "${id}"`), process.exit(1)));
for (const m of models) {
  if (!isInstalled(m)) {
    console.error(`${m.label} is not downloaded. Run: npm run setup -- ${m.id}`);
    process.exit(1);
  }
}
const reference = option('--ref') ? fs.readFileSync(option('--ref'), 'utf8') : null;

const { sampleRate, samples } = decodeWav(fs.readFileSync(file));
if (sampleRate !== 16000) {
  console.error(`Expected 16 kHz audio, got ${sampleRate} Hz. Convert with: afconvert -f WAVE -d LEI16@16000 -c 1 in.wav out.wav`);
  process.exit(1);
}
const audioSec = samples.length / sampleRate;

// 1. Cut the recording into utterances once, exactly like the live app, so every model gets identical input.
const segments = [];
const segmenter = new Segmenter({ ...config.vad, detector: createDetector(config.vad), onSegment: (s) => segments.push(s) });
for (let i = 0; i < samples.length; i += 1600) segmenter.push(samples.subarray(i, i + 1600));
segmenter.flush();
console.log(`\n${path.basename(file)}: ${fmtTime(audioSec)} of audio, ${segments.length} utterances, ${models.length} models\n`);
if (!segments.length) process.exit(0);

// 2. Transcribe with each model.
const transcriber = new Transcriber(config);
transcriber.on('state', ({ state, message }) => state === 'loading' && console.log(`  ${message}`));
const results = [];
for (const model of models) {
  await transcriber.select(model.id);
  if (transcriber.state !== 'ready') continue;
  await transcriber.transcribe(segments[0].samples); // warm-up, not counted
  let text = '';
  let totalMs = 0;
  const lines = [];
  for (const seg of segments) {
    const prompt = transcriber.supportsPrompt ? (text ? contextTail(text) : config.whisper.initialPrompt) : '';
    const result = await transcriber.transcribe(seg.samples, { prompt, fallback: true });
    totalMs += result.ms;
    const line = resultToText(result);
    if (line) {
      lines.push(`[${fmtTime(seg.start)}] ${line}`);
      text = `${text} ${line}`.trim();
    }
  }
  const wer = reference ? wordErrorRate(reference, text) : null;
  results.push({ model, text, lines, totalMs, wer });
  console.log(`  ✔ ${model.label}: ${(totalMs / 1000).toFixed(1)} s${wer === null ? '' : `, WER ${(wer * 100).toFixed(1)} %`}`);
}
await transcriber.shutdown();

// 3. Report.
const table = [
  `| Model | Engine | Inference | Speed | ${reference ? 'WER |' : ''}`,
  `|---|---|---|---|${reference ? '---|' : ''}`,
  ...results.map((r) =>
    `| ${r.model.label} | ${r.model.engine} | ${(r.totalMs / 1000).toFixed(1)} s | ${(audioSec / (r.totalMs / 1000)).toFixed(0)}× real-time | ${
      r.wer === null ? '' : `${(r.wer * 100).toFixed(1)} % |`}`),
].join('\n');
const report = [
  `# Model comparison: ${path.basename(file)}`,
  '',
  `${fmtTime(audioSec)} of audio, ${segments.length} utterances. Lower WER is better.`,
  '',
  table,
  '',
  ...results.flatMap((r) => [`## ${r.model.label}`, '', ...r.lines, '']),
].join('\n');
const out = path.join(config.transcriptsDir, `${path.basename(file, path.extname(file))}.compare.md`);
fs.mkdirSync(config.transcriptsDir, { recursive: true });
fs.writeFileSync(out, report);
console.log(`\n${table}\n\nFull transcripts: ${path.relative(process.cwd(), out)}\n`);
process.exit(0);

function words(text) {
  return normalize(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w));
}

/** Word-level edit distance divided by the reference length. */
function wordErrorRate(ref, hyp) {
  const r = words(ref);
  const h = words(hyp);
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const cur = [i];
    for (let j = 1; j <= h.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return r.length ? prev[h.length] / r.length : 0;
}
