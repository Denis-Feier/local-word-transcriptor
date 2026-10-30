// Speech-detection settings that can be changed live from the page's Settings panel.
// The ranges here are the single source of truth: the page builds its sliders from them.
export const TUNING = {
  vadThreshold: { min: 0.1, max: 0.9, step: 0.05 },
  silenceMs: { min: 300, max: 3000, step: 100 },
  minSpeechMs: { min: 100, max: 1000, step: 50 },
  maxSegmentSec: { min: 5, max: 28, step: 1 },
  partialEverySec: { min: 0.3, max: 2, step: 0.1 },
  crosstalkDb: { min: 3, max: 20, step: 1 },
};

export const tuningFrom = (config) => ({
  vadThreshold: config.vad.sileroThreshold,
  silenceMs: config.vad.silenceMs,
  minSpeechMs: config.vad.minSpeechMs,
  maxSegmentSec: config.vad.maxSegmentSec,
  partialEverySec: config.partialEverySec,
  crosstalkDb: config.crosstalkDb,
});

/** Clamp to range and snap to step; unknown keys and non-numbers are dropped. */
export function sanitizeTuning(values = {}) {
  const out = {};
  for (const [key, { min, max, step }] of Object.entries(TUNING)) {
    const v = Number(values?.[key]);
    if (values?.[key] === undefined || !Number.isFinite(v)) continue;
    out[key] = Number((Math.round(Math.min(max, Math.max(min, v)) / step) * step).toFixed(3));
  }
  return out;
}

/** Write tuning values into the shared config that sessions read. */
export function applyTuning(config, t) {
  if (t.vadThreshold !== undefined) config.vad.sileroThreshold = t.vadThreshold;
  if (t.silenceMs !== undefined) config.vad.silenceMs = t.silenceMs;
  if (t.minSpeechMs !== undefined) config.vad.minSpeechMs = t.minSpeechMs;
  if (t.maxSegmentSec !== undefined) config.vad.maxSegmentSec = t.maxSegmentSec;
  if (t.partialEverySec !== undefined) config.partialEverySec = t.partialEverySec;
  if (t.crosstalkDb !== undefined) config.crosstalkDb = t.crosstalkDb;
}
