import { SAMPLE_RATE, concatFloat32 } from './wav.js';
import { FRAME } from './vad.js';

const FRAME_MS = (FRAME / SAMPLE_RATE) * 1000; // 32 ms
const KEEP_TAIL_FRAMES = 6; // keep ~200 ms of trailing silence so the last word isn't clipped
const SPLIT_SEARCH_FRAMES = Math.round(5000 / FRAME_MS); // look back 5 s for a quiet spot when splitting

function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/**
 * Cuts a continuous 16 kHz stream into utterances, using a frame-level speech detector
 * (see vad.js) plus pre-roll, a pause timeout and a maximum utterance length.
 * push() does everything; with several mics the session calls analyze() and feed() separately,
 * so it can compare the mics' frames before they are fed (see crosstalk.js).
 *
 * Events:
 *   onSpeechStart(id)
 *   onSegment({ id, samples, start, end })   speech ended (or was split at maxSegmentSec)
 *   onDiscard(id)                             too little speech, e.g. a click or a cough
 */
export class Segmenter {
  constructor({ detector, onSpeechStart, onSegment, onDiscard, startFrame = 0, newId, ...timing }) {
    this.detector = detector;
    this.setTiming(timing);
    this.onSpeechStart = onSpeechStart ?? (() => {});
    this.onSegment = onSegment ?? (() => {});
    this.onDiscard = onDiscard ?? (() => {});

    this.leftover = new Float32Array(0);
    this.frameIndex = startFrame; // a mic added mid-session starts at the session's current time
    let nextId = 1;
    this.newId = newId ?? (() => nextId++); // several mics share one id sequence
    this.preRoll = []; // recent frames while idle
    this.frames = null; // frames of the current segment; null when idle
    this.loudRun = 0;
    this.silentRun = 0;
    this.id = 0;
  }

  /** Pause length, pre-roll, minimum speech and maximum utterance length; can change mid-session. */
  setTiming({ silenceMs, preRollMs, minSpeechMs, maxSegmentSec }) {
    this.hangFrames = Math.round(silenceMs / FRAME_MS);
    this.preRollFrames = Math.round(preRollMs / FRAME_MS);
    this.minSpeechFrames = Math.round(minSpeechMs / FRAME_MS);
    this.maxFrames = Math.round((maxSegmentSec * 1000) / FRAME_MS);
  }

  /** The utterance currently being spoken, or null. */
  current() {
    if (!this.frames) return null;
    return {
      id: this.id,
      duration: (this.frames.length * FRAME_MS) / 1000,
      start: (this.frames[0].index * FRAME_MS) / 1000,
      samples: () => concatFloat32(this.frames.map((f) => f.samples)),
    };
  }

  push(samples) {
    for (const frame of this.analyze(samples)) this.feed(frame);
  }

  /** Cut audio into detector frames: { samples, level, loud, index }. */
  analyze(samples) {
    const data = this.leftover.length ? concatFloat32([this.leftover, samples]) : samples;
    const frames = [];
    let offset = 0;
    for (; offset + FRAME <= data.length; offset += FRAME) {
      const frame = data.slice(offset, offset + FRAME);
      const level = rms(frame);
      frames.push({ samples: frame, level, loud: this.detector.isSpeech(frame, level), index: this.frameIndex++ });
    }
    this.leftover = data.slice(offset);
    return frames;
  }

  /** Force-end the current utterance (e.g. the user pressed Stop). */
  flush() {
    if (!this.frames) return;
    this.silentRun = Math.max(this.silentRun, KEEP_TAIL_FRAMES);
    this.#end();
  }

  /** Advance by one frame from analyze(). */
  feed(frame) {
    const { loud } = frame;
    if (!this.frames) {
      this.preRoll.push(frame);
      if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
      this.loudRun = loud ? this.loudRun + 1 : 0;
      if (this.loudRun >= this.detector.onsetFrames) this.#start(this.preRoll);
      return;
    }

    this.frames.push(frame);
    this.silentRun = loud ? 0 : this.silentRun + 1;
    if (this.silentRun >= this.hangFrames) this.#end();
    else if (this.frames.length >= this.maxFrames) this.#split();
  }

  #start(frames) {
    this.frames = frames;
    this.preRoll = [];
    this.loudRun = 0;
    this.silentRun = 0;
    this.id = this.newId();
    this.onSpeechStart(this.id);
  }

  #end() {
    const keep = this.frames.length - this.silentRun + Math.min(this.silentRun, KEEP_TAIL_FRAMES);
    const frames = this.frames;
    this.#emit(this.id, frames.slice(0, keep));
    this.frames = null;
    this.preRoll = frames.slice(-this.preRollFrames);
    this.loudRun = 0;
    this.silentRun = 0;
  }

  /** Utterance is too long for one Whisper window: cut at the quietest recent frame and keep going. */
  #split() {
    const frames = this.frames;
    let cut = frames.length - 2; // always leave at least one frame for the continuation
    for (let i = Math.max(1, frames.length - SPLIT_SEARCH_FRAMES); i < frames.length - 1; i++) {
      if (frames[i].level < frames[cut].level) cut = i;
    }
    this.#emit(this.id, frames.slice(0, cut + 1));
    this.#start(frames.slice(cut + 1));
  }

  #emit(id, frames) {
    const voiced = frames.reduce((n, f) => n + (f.loud ? 1 : 0), 0);
    if (voiced < this.minSpeechFrames) {
      this.onDiscard(id);
      return;
    }
    this.onSegment({
      id,
      samples: concatFloat32(frames.map((f) => f.samples)),
      start: (frames[0].index * FRAME_MS) / 1000,
      end: ((frames[frames.length - 1].index + 1) * FRAME_MS) / 1000,
    });
  }
}
