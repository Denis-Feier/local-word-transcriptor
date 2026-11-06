// @ts-check
// One model through the benchmark suite (scripts/benchmark-suite.js): load time, accuracy and speed on FLEURS
// Romanian, how steady its live text is (#27), how it copes with noise, a quiet speaker and a mic across the room,
// long sentences, and silence. Everything runs through the app's own Transcriber, so the numbers are the app's.
//
// A stage's clip counts come from a plan (planStages) that fits the model's share of the time budget; a deadline stops
// a stage early, and the result says so (truncated), so a slow computer still exports what it measured.
import { SteadyText } from '../steady.js';
import { resultToText } from '../text.js';
import { SAMPLE_RATE } from '../wav.js';
import { corpusWer, liveSteadiness, sumSteadiness, median, mean } from './metrics.js';
import { withNoise, withGain, inRoom, silence, noiseOnly, joinClips } from './audio.js';
import { selectClips, audioSeconds } from './dataset.js';
/** @import { Model } from '../../types/model.ts' */
/** @import { Transcriber } from '../transcriber.js' */
/** @import { Steadiness } from './metrics.js' */
/** @import { Clip } from './dataset.js' */
/** @import { MachineInfo } from './machine.js' */

// The shapes of a run's JSON (benchmarks/runs/<name>/run.json), as runModel() writes a model's part and
// scripts/benchmark-suite.js assembles the run; lib/benchmark/report.js reads them.
/** @typedef {{ id: string, label: string, apply: (s: Float32Array) => Float32Array }} Condition */
/** @typedef {{ id: string, label: string, make: () => Float32Array }} SilenceInput */
/** @typedef {{ accuracy: number, live: number, robustness: number, length: number, silence: number }} StageSizes */
/** @typedef {{ sizes: StageSizes, estimatedSec: number, fits: boolean }} Plan */
/** @typedef {{ seconds: number, firstSentenceMs: number, device: string | null, fallback: string | null, rssMb: number, message: string }} LoadInfo */
/** @typedef {{ seconds: string, clips: number, msPerClip: number | null, speed: number | null }} LengthBucket */
/**
 * @typedef {{ clips: number, done: number, truncated: boolean, audioSec: number, computeSec: number, werStrict: number, werPlain: number,
 *   werNoDigits: number, clipsNoDigits: number, speed: number | null, msPerClip: number | null, msMedian: number | null, msMax: number | null,
 *   empty: number, byLength: LengthBucket[], perClip: Record<string, { hyp: string, ms: number }> }} AccuracyStage
 */
/** @typedef {{ at: number, ms: number, text: string }} Guess */
/** @typedef {{ text: string, ms: number, wait: number }} FinalGuess */
/**
 * @typedef {{ seconds: number, guesses: Guess[], final: FinalGuess, raw: Steadiness, steady: Steadiness,
 *   firstLive: { raw: number | null, steady: number | null } }} LiveResult  one sentence on the live schedule (liveSentence())
 */
/**
 * @typedef {{ clips: number, done: number, truncated: boolean, sentences: (LiveResult & { file: string })[], raw: ReturnType<typeof sumSteadiness>,
 *   steady: ReturnType<typeof sumSteadiness>, guessesPerSentence: number | null, firstLiveSec: { raw: number | null, steady: number | null },
 *   finalMs: number | null, werPlain: number }} LiveStage
 */
/** @typedef {{ label: string, clips: number, werPlain: number, delta: number, msPerClip?: number, empty?: number }} ConditionResult */
/** @typedef {{ clips: number, truncated: boolean, conditions: Record<string, ConditionResult> }} RobustnessStage */
/** @typedef {{ target: number, sentences: number, seconds: number, msPerSentence: number, speed: number, werPlain: number, empty: number }} LengthResult */
/** @typedef {{ truncated: boolean, lengths: LengthResult[] }} LengthStage */
/** @typedef {{ id: string, label: string, ms: number, words: number, text: string }} SilenceResult */
/** @typedef {{ truncated: boolean, inputs: SilenceResult[], hallucinated?: number }} SilenceStage */
/** @typedef {{ accuracy?: AccuracyStage, live?: LiveStage, robustness?: RobustnessStage, length?: LengthStage, silence?: SilenceStage }} Stages */
/**
 * One model's part of a run: what runModel() returns, or an error with the model's name.
 * @typedef {{ id: string, label: string, engine?: string, startedAt?: string, finishedAt?: string, stages?: Stages, truncated?: boolean,
 *   load?: LoadInfo, plan?: Plan & { ratio: number, budgetSec: number }, seconds?: number, error?: string, pending?: boolean }} ModelResult
 */
/** A model that ran to its accuracy stage: what the report's tables are made of. @typedef {ModelResult & { load: LoadInfo, stages: Stages & { accuracy: AccuracyStage } }} Measured */
/**
 * @typedef {{ schema: number, name: string, label: string | null, startedAt: string, finishedAt?: string, seconds?: number, minutes: number,
 *   parallel: number, sizes: Partial<StageSizes>, machine: MachineInfo, dataset: { name: string, clips: number, minutes: number, selection: string[] },
 *   modelIds: string[], models: ModelResult[] }} Run
 */

const MIN_PARTIAL_SEC = 0.6; // as lib/session.js: the first live guess
const CHUNK_SEC = 0.1; // the page sends 100 ms of audio at a time
const WARMUP_CLIPS = 3;

/** The conditions of the robustness stage, each applied to the same clips. @type {Condition[]} */
export const CONDITIONS = [
  { id: 'noise20', label: 'noise, SNR 20 dB', apply: (s) => withNoise(s, 20) },
  { id: 'noise10', label: 'noise, SNR 10 dB', apply: (s) => withNoise(s, 10) },
  { id: 'quiet', label: 'quiet speaker, −20 dB', apply: (s) => withGain(s, -20) },
  { id: 'room', label: 'mic across the room', apply: (s) => inRoom(s) },
];

/** What the silence stage feeds the model: nothing to transcribe, and what it writes anyway is a hallucination. @type {SilenceInput[]} */
export const SILENCE_INPUTS = [
  { id: 'silence3', label: '3 s of silence', make: () => silence(3) },
  { id: 'silence10', label: '10 s of silence', make: () => silence(10) },
  { id: 'room-noise', label: '5 s of an empty room (−50 dBFS)', make: () => noiseOnly(5, -50) },
  { id: 'fan-noise', label: '5 s of a fan by the mic (−30 dBFS)', make: () => noiseOnly(5, -30) },
];

/** Full stage sizes for the one-hour suite, and the least a stage is shrunk to before it is dropped. @type {Record<keyof StageSizes, { full: number, min: number }>} */
export const STAGES = {
  accuracy: { full: 100, min: 20 },
  live: { full: 40, min: 10 },
  robustness: { full: 25, min: 8 },
  length: { full: 3, min: 1 }, // sentences per length
  silence: { full: SILENCE_INPUTS.length, min: SILENCE_INPUTS.length },
};
export const LENGTHS = [20, 40]; // seconds; 20 s is the app's default longest sentence, 40 s past its slider's limit

/**
 * How many clips each stage gets within `seconds` of model time, from the model's measured speed (`ratio`: seconds
 * of compute per second of audio). sizes: the full sizes wanted (STAGES, or --clips etc.). When everything fits,
 * the sizes stay; otherwise every stage shrinks in proportion, never below its minimum, and the deadline does the rest.
 * @param {Clip[]} clips
 * @param {number} ratio
 * @param {number} seconds
 * @param {Partial<StageSizes>} [sizes]
 * @returns {Plan}
 */
export function planStages(clips, ratio, seconds, sizes = {}) {
  const keys = /** @type {(keyof StageSizes)[]} */ (Object.keys(STAGES));
  const want = /** @type {StageSizes} */ (Object.fromEntries(keys.map((k) => [k, sizes[k] ?? STAGES[k].full])));
  /** @param {StageSizes} n */
  const cost = (n) => {
    const acc = selectClips(clips, n.accuracy);
    const live = selectClips(acc, n.live);
    const robust = selectClips(acc, n.robustness);
    const guesses = live.reduce((sum, c) => {
      const interval = Math.max(0.5, 2 * ratio * c.seconds);
      let s = 0;
      for (let at = MIN_PARTIAL_SEC; at < c.seconds; at += interval) s += at;
      return sum + s;
    }, 0);
    return ratio * (audioSeconds(acc) + guesses + audioSeconds(live) + CONDITIONS.length * audioSeconds(robust)
      + LENGTHS.reduce((s, l) => s + l * n.length, 0) + 23 * (n.silence / SILENCE_INPUTS.length));
  };
  const full = cost(want);
  if (full <= seconds) return { sizes: want, estimatedSec: full, fits: true };
  const f = Math.max(0.05, seconds / full);
  const shrunk = /** @type {StageSizes} */ (Object.fromEntries(keys.map((k) => [k, Math.max(Math.min(STAGES[k].min, want[k]), Math.floor(want[k] * f))])));
  return { sizes: shrunk, estimatedSec: cost(shrunk), fits: false };
}

/**
 * Runs `model` through every stage. clips: the sorted FLEURS clips (loadClips); load(clip) -> Float32Array samples.
 * deadline: epoch ms after which stages stop; budgetSec: the model time the plan may use. log(line) reports progress.
 * Returns the model's result object, as written to the run's JSON.
 * @param {{ model: Model, transcriber: Transcriber, clips: Clip[], load: (clip: Clip) => Float32Array, deadline?: number, budgetSec?: number,
 *   sizes?: Partial<StageSizes>, partialEverySec?: number, log?: (line: string) => void }} opts
 * @returns {Promise<ModelResult>}
 */
export async function runModel({ model, transcriber, clips, load, deadline = Infinity, budgetSec = Infinity, sizes = {}, partialEverySec = 0.5, log = () => {} }) {
  /** @type {ModelResult & { stages: Stages }} */
  const result = { id: model.id, label: model.label, engine: model.engine, startedAt: new Date().toISOString(), stages: {}, truncated: false };
  const t0 = Date.now();
  const past = () => Date.now() >= deadline;
  /** @param {Float32Array} samples */
  const transcribe = async (samples) => {
    const r = await transcriber.transcribe(samples, { prompt: '', fallback: true });
    return { text: resultToText(r), ms: r.ms };
  };

  // 1. Load: time to ready, where it runs, memory it took in this process (a sidecar's memory is not counted).
  const rssBefore = process.memoryUsage().rss;
  const tLoad = Date.now();
  await transcriber.select(model.id);
  if (transcriber.state !== 'ready') {
    result.error = transcriber.message;
    result.finishedAt = new Date().toISOString();
    return result;
  }
  const warm = selectClips(clips, WARMUP_CLIPS).map((c) => ({ c, samples: load(c) }));
  const first = await transcribe(warm[0].samples); // the first sentence is slower (shaders, caches): measured apart
  let warmSec = 0;
  for (const { samples } of warm) warmSec += (await transcribe(samples)).ms / 1000;
  const status = transcriber.status();
  result.load = {
    seconds: (Date.now() - tLoad) / 1000 - first.ms / 1000 - warmSec,
    firstSentenceMs: Math.round(first.ms),
    device: status.device,
    fallback: status.fallback,
    rssMb: Math.round((process.memoryUsage().rss - rssBefore) / 1024 ** 2),
    message: status.message,
  };
  const ratio = warmSec / audioSeconds(warm.map((w) => w.c));
  const spent = (Date.now() - t0) / 1000;
  // Planned against three quarters of the share: live guesses come a little closer than estimated, and reading the
  // clips from disk is not model time.
  const plan = planStages(clips, ratio, Math.max(0, 0.75 * (budgetSec - spent)), sizes);
  result.plan = { ratio, budgetSec, ...plan };
  log(`${model.label}: ready on ${status.device ?? 'the chip the OS picks'} in ${result.load.seconds.toFixed(1)} s, ${(1 / ratio).toFixed(0)}× real-time warm; plan ${JSON.stringify(plan.sizes)}${plan.fits ? '' : ' (shrunk to fit the time budget)'}`);

  // 2. Accuracy and speed on the FLEURS selection.
  const accClips = selectClips(clips, plan.sizes.accuracy);
  /** @type {Record<string, { hyp: string, ms: number }>} */
  const hyps = {}; // file -> { hyp, ms }
  {
    const stage = /** @type {AccuracyStage} */ ({ clips: accClips.length, done: 0, truncated: false }); // the scores follow
    for (const clip of accClips) {
      if (past()) {
        stage.truncated = true;
        break;
      }
      const r = await transcribe(load(clip));
      hyps[clip.file] = { hyp: r.text, ms: Math.round(r.ms) };
      stage.done++;
      if (stage.done % 10 === 0) log(`  accuracy ${stage.done}/${accClips.length}`);
    }
    const scored = accClips.filter((c) => c.file in hyps);
    const pairs = scored.map((c) => ({ ref: c.ref, hyp: hyps[c.file].hyp }));
    const audioSec = audioSeconds(scored);
    const computeSec = scored.reduce((n, c) => n + hyps[c.file].ms, 0) / 1000;
    const noDigits = scored.filter((c) => !/\d/.test(c.ref));
    const buckets = [[0, 6], [6, 10], [10, 15], [15, Infinity]].map(([lo, hi]) => {
      const inBucket = scored.filter((c) => c.seconds >= lo && c.seconds < hi);
      const audio = audioSeconds(inBucket);
      const compute = inBucket.reduce((n, c) => n + hyps[c.file].ms, 0) / 1000;
      return { seconds: hi === Infinity ? `${lo}+` : `${lo}–${hi}`, clips: inBucket.length, msPerClip: inBucket.length ? Math.round((1000 * compute) / inBucket.length) : null, speed: compute ? Math.round(audio / compute) : null };
    });
    Object.assign(stage, {
      audioSec,
      computeSec,
      werStrict: corpusWer(pairs, { diacritics: true }).wer,
      werPlain: corpusWer(pairs, { diacritics: false }).wer,
      werNoDigits: corpusWer(noDigits.map((c) => ({ ref: c.ref, hyp: hyps[c.file].hyp })), { diacritics: false }).wer,
      clipsNoDigits: noDigits.length,
      speed: computeSec ? audioSec / computeSec : null,
      msPerClip: scored.length ? (1000 * computeSec) / scored.length : null,
      msMedian: median(scored.map((c) => hyps[c.file].ms)),
      msMax: scored.length ? Math.max(...scored.map((c) => hyps[c.file].ms)) : null,
      empty: scored.filter((c) => !hyps[c.file].hyp).length,
      byLength: buckets,
      perClip: Object.fromEntries(scored.map((c) => [c.file, hyps[c.file]])),
    });
    result.stages.accuracy = stage;
    result.truncated ||= stage.truncated;
    log(`  accuracy: WER ${stage.werStrict.toFixed(2)} % (${stage.werPlain.toFixed(2)} % without diacritics), ${stage.speed?.toFixed(0)}× real-time${stage.truncated ? ' — stopped at the deadline' : ''}`);
  }

  // 3. Live text (#27): each sentence replayed on the app's live-guess schedule, on a simulated clock.
  {
    const liveClips = selectClips(accClips, plan.sizes.live);
    const stage = /** @type {LiveStage} */ ({ clips: liveClips.length, done: 0, truncated: false, sentences: /** @type {LiveStage['sentences']} */ ([]) }); // the scores follow
    for (const clip of liveClips) {
      if (past()) {
        stage.truncated = true;
        break;
      }
      stage.sentences.push({ file: clip.file, ...await liveSentence(transcriber, load(clip), { partialEverySec }) });
      stage.done++;
    }
    const s = stage.sentences;
    /** @param {'raw' | 'steady'} key */
    const steadiness = (key) => sumSteadiness(s.map((x) => x[key]));
    Object.assign(stage, {
      raw: steadiness('raw'),
      steady: steadiness('steady'),
      guessesPerSentence: mean(s.map((x) => x.guesses.length)),
      firstLiveSec: { raw: median(s.map((x) => x.firstLive.raw)), steady: median(s.map((x) => x.firstLive.steady)) },
      finalMs: median(s.map((x) => x.final.ms + 1000 * x.final.wait)),
      werPlain: corpusWer(s.map((x) => ({ ref: /** @type {Clip} */ (liveClips.find((c) => c.file === x.file)).ref, hyp: x.final.text })), { diacritics: false }).wer, // every sentence came from liveClips
    });
    result.stages.live = stage;
    result.truncated ||= stage.truncated;
    log(`  live text: erasure ${stage.raw.normalizedErasure.toFixed(2)} raw / ${stage.steady.normalizedErasure.toFixed(2)} steady, coverage ${(100 * stage.raw.coverage).toFixed(0)} % / ${(100 * stage.steady.coverage).toFixed(0)} %${stage.truncated ? ' — stopped at the deadline' : ''}`);
  }

  // 4. Robustness: the same clips clean (from the accuracy stage) and under each condition.
  {
    const robustClips = selectClips(accClips, plan.sizes.robustness).filter((c) => c.file in hyps);
    /** @type {RobustnessStage} */
    const stage = { clips: robustClips.length, truncated: false, conditions: {} };
    const clean = corpusWer(robustClips.map((c) => ({ ref: c.ref, hyp: hyps[c.file].hyp })), { diacritics: false });
    stage.conditions.clean = { label: 'clean', clips: robustClips.length, werPlain: clean.wer, delta: 0 };
    for (const cond of CONDITIONS) {
      /** @type {{ ref: string, hyp: string }[]} */
      const pairs = [];
      let ms = 0;
      for (const clip of robustClips) {
        if (past()) {
          stage.truncated = true;
          break;
        }
        const r = await transcribe(cond.apply(load(clip)));
        pairs.push({ ref: clip.ref, hyp: r.text });
        ms += r.ms;
      }
      if (!pairs.length) break;
      const scored = corpusWer(pairs, { diacritics: false });
      const base = corpusWer(robustClips.slice(0, pairs.length).map((c) => ({ ref: c.ref, hyp: hyps[c.file].hyp })), { diacritics: false });
      stage.conditions[cond.id] = { label: cond.label, clips: pairs.length, werPlain: scored.wer, delta: scored.wer - base.wer, msPerClip: Math.round(ms / pairs.length), empty: pairs.filter((p) => !p.hyp).length };
    }
    result.stages.robustness = stage;
    result.truncated ||= stage.truncated;
    log(`  robustness: ${Object.values(stage.conditions).map((c) => `${c.label} ${c.werPlain.toFixed(1)} %`).join(', ')}${stage.truncated ? ' — stopped at the deadline' : ''}`);
  }

  // 5. Long sentences: clips joined into 20 s and 40 s stretches of speech.
  {
    /** @type {LengthStage} */
    const stage = { truncated: false, lengths: [] };
    const pool = [...accClips];
    for (const target of LENGTHS) {
      /** @type {{ seconds: number, parts: number, ms: number, werPlain: number, words: number, empty: boolean }[]} */
      const rows = [];
      for (let i = 0; i < plan.sizes.length && !past(); i++) {
        /** @type {Clip[]} */
        const parts = [];
        while (audioSeconds(parts) < target - 2 && pool.length) parts.push(/** @type {Clip} */ (pool.shift()));
        if (!parts.length) break;
        const samples = joinClips(parts.map(load));
        const r = await transcribe(samples);
        const ref = parts.map((p) => p.ref).join(' ');
        rows.push({ seconds: samples.length / SAMPLE_RATE, parts: parts.length, ms: Math.round(r.ms), werPlain: corpusWer([{ ref, hyp: r.text }], { diacritics: false }).wer, words: ref.split(/\s+/).length, empty: !r.text });
      }
      if (past() && rows.length < plan.sizes.length) stage.truncated = true;
      if (!rows.length) continue;
      const avg = /** @param {(r: { seconds: number, ms: number, werPlain: number }) => number} pick */ (pick) => /** @type {number} */ (mean(rows.map(pick))); // rows is not empty here
      stage.lengths.push({ target, sentences: rows.length, seconds: avg((r) => r.seconds), msPerSentence: Math.round(avg((r) => r.ms)), speed: avg((r) => r.seconds) / (avg((r) => r.ms) / 1000), werPlain: avg((r) => r.werPlain), empty: rows.filter((r) => r.empty).length });
    }
    result.stages.length = stage;
    result.truncated ||= stage.truncated;
    log(`  long sentences: ${stage.lengths.map((l) => `${l.target} s → ${l.msPerSentence} ms, WER ${l.werPlain.toFixed(1)} %`).join('; ') || 'none'}${stage.truncated ? ' — stopped at the deadline' : ''}`);
  }

  // 6. Silence and noise alone: anything written is invented.
  {
    /** @type {SilenceStage} */
    const stage = { truncated: false, inputs: [] };
    for (const input of SILENCE_INPUTS) {
      if (past()) {
        stage.truncated = true;
        break;
      }
      const r = await transcribe(input.make());
      stage.inputs.push({ id: input.id, label: input.label, ms: Math.round(r.ms), words: r.text ? r.text.split(/\s+/).length : 0, text: r.text.slice(0, 120) });
    }
    stage.hallucinated = stage.inputs.filter((i) => i.words > 0).length;
    result.stages.silence = stage;
    result.truncated ||= stage.truncated;
    log(`  silence: ${stage.hallucinated}/${stage.inputs.length} inputs got invented text${stage.truncated ? ' — stopped at the deadline' : ''}`);
  }

  result.seconds = (Date.now() - t0) / 1000;
  result.finishedAt = new Date().toISOString();
  return result;
}

/**
 * One sentence on the app's live schedule (lib/session.js), on a simulated clock in audio time: the first guess at
 * 0.6 s of speech, then every max(partialEverySec, 2 × the model's average time), only while the model is free, each
 * guess on the audio so far; the final on the whole sentence once it ends, after any guess still running.
 * Returns the guesses, the texts shown raw and with Steady live text, their steadiness and timing.
 * @param {Transcriber} transcriber
 * @param {Float32Array} samples
 * @param {{ partialEverySec?: number }} [opts]
 * @returns {Promise<LiveResult>}
 */
export async function liveSentence(transcriber, samples, { partialEverySec = 0.5 } = {}) {
  const seconds = samples.length / SAMPLE_RATE;
  /** @type {Guess[]} */
  const guesses = [];
  let lastPartialAt = 0;
  let busyUntil = 0;
  for (;;) {
    const interval = Math.max(partialEverySec, (2 * (transcriber.avgMs ?? 0)) / 1000);
    let at = Math.max(MIN_PARTIAL_SEC, lastPartialAt + interval, busyUntil);
    at = Math.ceil(at / CHUNK_SEC - 1e-9) * CHUNK_SEC;
    if (at >= seconds) break;
    const r = await transcriber.transcribe(samples.subarray(0, Math.round(at * SAMPLE_RATE)), { prompt: '', fallback: false });
    guesses.push({ at: Number(at.toFixed(1)), ms: Math.round(r.ms), text: resultToText(r) });
    lastPartialAt = at;
    busyUntil = at + r.ms / 1000;
  }
  const wait = Math.max(0, busyUntil - seconds); // a guess still running when the sentence ends delays the final
  const r = await transcriber.transcribe(samples, { prompt: '', fallback: true });
  const final = { text: resultToText(r), ms: Math.round(r.ms), wait: Number(wait.toFixed(2)) };
  // What the page showed: raw, every non-empty guess as the model wrote it; steady, only the words two guesses agree on.
  const raw = guesses.filter((g) => g.text).map((g) => ({ shownAt: g.at + g.ms / 1000, text: g.text }));
  const steadyText = new SteadyText();
  /** @type {{ shownAt: number, text: string }[]} */
  const steady = [];
  for (const g of guesses) {
    if (!g.text) continue;
    const text = steadyText.update(g.text);
    if (text) steady.push({ shownAt: g.at + g.ms / 1000, text });
  }
  return {
    seconds: Number(seconds.toFixed(2)),
    guesses,
    final,
    raw: liveSteadiness(raw.map((d) => d.text), final.text),
    steady: liveSteadiness(steady.map((d) => d.text), final.text),
    firstLive: { raw: raw[0] ? Number(raw[0].shownAt.toFixed(2)) : null, steady: steady[0] ? Number(steady[0].shownAt.toFixed(2)) : null },
  };
}
