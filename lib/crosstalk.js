import { FRAME } from './vad.js';
import { SAMPLE_RATE } from './wav.js';

const FRAME_SEC = FRAME / SAMPLE_RATE; // 32 ms
const HOLD = 8; // frames either side (~0.25 s): a Bluetooth mic delivers its audio up to this much later than a wired one
const OWN = 3; // frames either side (~0.1 s) for a mic's own level: one syllable, not the previous speaker's last words
const MIN_FLOOR = 0.0005; // -66 dBFS; mics with built-in noise cancelling can go almost silent between words
const NO_SIGNAL = 1e-5; // -100 dBFS: digital silence from a mic that is not connected (yet), not its room noise
const MIN_CLARITY = 10; // dB above a mic's noise; the detector stays on briefly after speech ends
const HISTORY = Math.round(120 / FRAME_SEC); // clarity is kept for 2 minutes, for clarity()

const db = (level) => 20 * Math.log10(Math.max(level, 1e-9));
const frames0 = (count) => Array.from({ length: count }, () => ({ speech: 0, kept: 0 }));

/** A mic's background noise in dB, learned while no mic hears speech. Until then every mic counts as equally noisy. */
class NoiseFloor {
  db = db(MIN_FLOOR);
  learned = false;

  push(level) {
    if (level < NO_SIGNAL) return;
    const value = db(Math.max(level, MIN_FLOOR));
    // Falls faster than it rises, so a stray louder frame moves it only a little.
    this.db = this.learned ? this.db + (value - this.db) * (value < this.db ? 0.3 : 0.1) : value;
    this.learned = true;
  }
}

/**
 * Mics in one room all hear every speaker, the farther ones more quietly ("bleed"). Each mic should only
 * transcribe its own speaker, so a mic's frame keeps its speech only while that mic hears it nearly as clearly
 * as the clearest other mic does around the same moment (within marginDb).
 *
 * Clarity is a mic's level above its own background noise, which cancels out the different volumes of, say,
 * a Bluetooth headset and a wired mic. Decisions come HOLD frames late, so a mic that delivers its audio later
 * is still compared with the same moment on the others.
 */
export class CrosstalkGate {
  constructor(count, marginDb) {
    this.marginDb = marginDb;
    this.floors = Array.from({ length: count }, () => new NoiseFloor());
    this.history = Array.from({ length: count }, () => new Float32Array(HISTORY).fill(NaN));
    this.latest = -1; // index of the newest frame in history
    this.past = []; // decided entries, kept as look-back
    this.ahead = []; // entries waiting for look-ahead: { frames, speech, clarity }
    this.counts = frames0(count); // speech frames per mic, and how many were kept, for report()
  }

  setMargin(marginDb) {
    this.marginDb = marginDb;
  }

  /** One frame per mic, all from the same moment (Segmenter.analyze). Returns the frames from HOLD frames ago, decided, or null. */
  push(frames) {
    const speech = frames.map((f) => f.loud);
    const clarity = frames.map((f, mic) => {
      const value = db(f.level) - this.floors[mic].db;
      this.history[mic][f.index % HISTORY] = value;
      return value;
    });
    this.latest = frames[0].index;
    this.ahead.push({ frames, speech, clarity });
    return this.ahead.length > HOLD ? this.#decide() : null;
  }

  /** Decide the frames still waiting for look-ahead (Stop pressed). */
  drain() {
    const out = [];
    while (this.ahead.length) out.push(this.#decide());
    return out;
  }

  /** One line for the server log: each mic's noise and how much of the speech it heard was kept as its own. */
  report() {
    const line = this.floors.map((floor, mic) => {
      const { speech, kept } = this.counts[mic];
      return `mic ${mic + 1}: noise ${floor.learned ? `${floor.db.toFixed(0)} dB` : 'not measured yet'}, kept ${kept} of ${speech} speech frames`;
    });
    this.counts = frames0(this.floors.length);
    return line.join(' · ');
  }

  /** A mic's average clarity (dB above its noise) between two session times in seconds; NaN if not recorded. */
  clarity(mic, start, end) {
    const from = Math.max(Math.floor(start / FRAME_SEC), this.latest - HISTORY + 1);
    const to = Math.min(Math.ceil(end / FRAME_SEC), this.latest + 1);
    let sum = 0;
    let n = 0;
    for (let i = from; i < to; i++) {
      const value = this.history[mic][i % HISTORY];
      if (Number.isNaN(value)) continue;
      sum += value;
      n++;
    }
    return n ? sum / n : NaN;
  }

  #decide() {
    const entry = this.ahead.shift();
    const window = [...this.past, entry, ...this.ahead];
    // Background noise is learned where no mic hears speech now or in the next ~0.25 s (the detector needs that
    // long to notice speech starting; after speech it stays on a little longer by itself).
    if ([entry, ...this.ahead].every((w) => !w.speech.some(Boolean))) entry.frames.forEach((f, mic) => this.floors[mic].push(f.level));
    // Each mic's clearest moment in the whole window (allowing for lag), against this mic's own current syllable.
    const peak = (w, mic) => Math.max(...w.map((x) => x.clarity[mic]));
    const at = this.past.length;
    const near = window.slice(Math.max(0, at - OWN), at + OWN + 1);
    entry.frames.forEach((frame, mic) => {
      const rival = Math.max(...entry.frames.map((_, other) => (other === mic ? -Infinity : peak(window, other))));
      if (entry.clarity[mic] < MIN_CLARITY || peak(near, mic) < rival - this.marginDb) frame.loud = false;
      this.counts[mic].speech += entry.speech[mic];
      this.counts[mic].kept += frame.loud;
    });
    this.past.push(entry);
    if (this.past.length > HOLD) this.past.shift();
    return entry.frames;
  }
}
