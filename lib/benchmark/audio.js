// Synthetic conditions for the benchmark suite: noise at a given signal-to-noise ratio, a quiet speaker, a mic across
// the room, silence. Seeded, so every computer makes the same audio from the same clip.
import { SAMPLE_RATE } from '../wav.js';

/** Uniform white noise in -1..1 from a small seeded generator (Park–Miller). */
export function noiseSource(seed = 7) {
  let s = (seed % 2147483647) || 1;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
}

export function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

export const db = (ratio) => 20 * Math.log10(ratio);

/** The clip with white noise added, snrDb quieter than the speech (measured as RMS over the whole clip). */
export function withNoise(samples, snrDb, seed = 7) {
  const speech = rms(samples) || 1e-4;
  const amp = (speech / 10 ** (snrDb / 20)) * Math.sqrt(3); // uniform noise with this RMS
  const rnd = noiseSource(seed);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, samples[i] + rnd() * amp));
  return out;
}

/** The clip gainDb louder (negative: quieter), clipped to -1..1. */
export function withGain(samples, gainDb) {
  const g = 10 ** (gainDb / 20);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, samples[i] * g));
  return out;
}

/** What a mic across the room hears: a few early reflections and duller sound (one-pole low-pass), at the same level. */
export function inRoom(samples) {
  const taps = [[0, 1], [0.011, 0.5], [0.023, 0.35], [0.041, 0.25], [0.067, 0.15]].map(([t, g]) => [Math.round(t * SAMPLE_RATE), g]);
  const out = new Float32Array(samples.length + taps.at(-1)[0]);
  for (const [delay, gain] of taps) for (let i = 0; i < samples.length; i++) out[i + delay] += gain * samples[i];
  let y = 0;
  for (let i = 0; i < out.length; i++) out[i] = y = y + 0.35 * (out[i] - y);
  const level = rms(samples) / (rms(out) || 1e-9);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, out[i] * level));
  return out;
}

export const silence = (seconds) => new Float32Array(Math.round(seconds * SAMPLE_RATE));

/** White noise alone, at levelDbfs (RMS), e.g. an empty room (-50) or a fan next to the mic (-30). */
export function noiseOnly(seconds, levelDbfs, seed = 11) {
  const amp = 10 ** (levelDbfs / 20) * Math.sqrt(3);
  const rnd = noiseSource(seed);
  const out = silence(seconds);
  for (let i = 0; i < out.length; i++) out[i] = rnd() * amp;
  return out;
}

/** Clips one after the other with a short pause between them, as one long sentence. */
export function joinClips(clips, pauseSec = 0.3) {
  const pause = silence(pauseSec);
  const length = clips.reduce((n, c) => n + c.length, 0) + pause.length * (clips.length - 1);
  const out = new Float32Array(Math.max(0, length));
  let offset = 0;
  clips.forEach((c, i) => {
    if (i) offset += pause.length;
    out.set(c, offset);
    offset += c.length;
  });
  return out;
}
