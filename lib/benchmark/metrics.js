// @ts-check
// Scores for the benchmark suite (scripts/benchmark-suite.js): word error rate over a set of clips, and how steady
// a model's live text is (#27), from the sequence of texts the page would have shown.
import { editDistance, words } from '../wer.js';
import { wordKey } from '../steady.js';

/**
 * How steady one sentence's live text was (liveSteadiness).
 * @typedef {{ erased: number, rewrites: number, updates: number, covered: number, finalWords: number }} Steadiness
 */

/**
 * Corpus-level word error rate in percent: all errors / all reference words.
 * @param {{ ref: string, hyp?: string | null }[]} pairs
 * @param {{ diacritics?: boolean }} [opts]
 */
export function corpusWer(pairs, { diacritics = true } = {}) {
  let errors = 0;
  let total = 0;
  for (const { ref, hyp } of pairs) {
    const r = words(ref, { diacritics });
    errors += editDistance(r, words(hyp ?? '', { diacritics }));
    total += r.length;
  }
  return { errors, total, wer: total ? (100 * errors) / total : 0 };
}

/**
 * A text as the words the page compares: lower case, letters and digits only; empty words dropped.
 * @param {string | null | undefined} text
 */
export const keys = (text) => String(text ?? '').split(/\s+/).map(wordKey).filter(Boolean);

/**
 * @param {string[]} a
 * @param {string[]} b
 */
function commonPrefix(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * Length of the longest common subsequence of two word lists.
 * @param {string[]} a
 * @param {string[]} b
 */
export function lcs(a, b) {
  /** @type {number[]} */
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = [0];
    for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return prev[b.length];
}

/**
 * How steady one sentence's live text was. displays: the texts shown on the page one after the other (the live line
 * each time it changed); final: the final line that replaced the last one. Words are compared the way the page's
 * Steady live text compares them (no case, no punctuation).
 *
 *   erased     words already on screen that a later display took back (the final replacing the live line counts
 *              too): the "erasure" of Arivazhagan et al., IWSLT 2020, before normalising by the final's length
 *   rewrites   displays (final included) that took a word back
 *   updates    displays + the final
 *   covered    words of the final that were on screen when it arrived (the longest common subsequence)
 *   finalWords words in the final
 * @param {string[]} displays
 * @param {string} final
 * @returns {Steadiness}
 */
export function liveSteadiness(displays, final) {
  const seq = [...displays.map(keys), keys(final)];
  const finalKeys = /** @type {string[]} */ (seq.at(-1)); // seq always has the final
  let erased = 0;
  let rewrites = 0;
  /** @type {string[]} */
  let prev = [];
  for (const cur of seq) {
    const kept = commonPrefix(prev, cur);
    const back = prev.length - kept;
    erased += back;
    if (back > 0) rewrites++;
    prev = cur;
  }
  const finalWords = finalKeys.length;
  const last = displays.length ? keys(displays.at(-1)) : [];
  return { erased, rewrites, updates: seq.length, covered: lcs(last, finalKeys), finalWords };
}

/**
 * Sums per-sentence steadiness into the numbers reported per model:
 *   normalizedErasure  words taken back per word of final text (0 = never rewrites)
 *   rewriteShare       share of updates that took a word back
 *   coverage           share of the final's words that were on screen before the final arrived
 * @param {Steadiness[]} items
 */
export function sumSteadiness(items) {
  /** @param {keyof Steadiness} key */
  const sum = (key) => items.reduce((n, x) => n + x[key], 0);
  const finalWords = sum('finalWords');
  const updates = sum('updates');
  return {
    sentences: items.length,
    normalizedErasure: finalWords ? sum('erased') / finalWords : 0,
    rewriteShare: updates ? sum('rewrites') / updates : 0,
    coverage: finalWords ? sum('covered') / finalWords : 0,
  };
}

/**
 * The middle value; gaps (null, undefined, NaN) are left out, and an empty list gives null.
 * @param {(number | null | undefined)[]} values
 * @returns {number | null}
 */
export function median(values) {
  const v = /** @type {number[]} */ ([...values].filter((x) => Number.isFinite(x))).sort((a, b) => a - b); // isFinite drops the gaps
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** @param {number[]} values */
export const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
