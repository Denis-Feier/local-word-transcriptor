import { normalize } from './text.js';

const PLAIN = { ă: 'a', â: 'a', î: 'i', ș: 's', ț: 't' };

/**
 * Words for scoring: lowercase, punctuation removed (as the Open ASR Leaderboard does), ş/ţ unified with ș/ț.
 * With diacritics: false, ă â î ș ț also count as a i s t, which matches published (diacritic-blind) numbers.
 */
export function words(text, { diacritics = true } = {}) {
  let t = normalize(text).toLowerCase();
  if (!diacritics) t = t.replace(/[ăâîșț]/g, (c) => PLAIN[c]);
  return t.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
}

/** Word-level edit distance (substitutions + insertions + deletions). */
export function editDistance(ref, hyp) {
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const cur = [i];
    for (let j = 1; j <= hyp.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[hyp.length];
}

export function wordErrorRate(ref, hyp, opts) {
  const r = words(ref, opts);
  return r.length ? editDistance(r, words(hyp, opts)) / r.length : 0;
}

/**
 * Words two texts have in common, in the same order: { count, ratio, share } where ratio is relative to the shorter
 * text and share to the first one (a). Diacritic-blind; words of one or two letters (și, de, la, în…) don't count,
 * since any two sentences share some.
 */
export function sharedWords(a, b) {
  const x = words(a, { diacritics: false }).filter((w) => w.length > 2);
  const y = words(b, { diacritics: false }).filter((w) => w.length > 2);
  if (!x.length || !y.length) return { count: 0, ratio: 0, share: 0 };
  let prev = new Array(y.length + 1).fill(0); // longest common subsequence
  for (let i = 1; i <= x.length; i++) {
    const cur = [0];
    for (let j = 1; j <= y.length; j++) cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  const count = prev[y.length];
  return { count, ratio: count / Math.min(x.length, y.length), share: count / x.length };
}
