// @ts-check
// Audio recorded while the server is unreachable, kept until it is back. An outage longer than the limit keeps the
// newest audio and drops the oldest, so the page catches up on what is being said now, and says how much was lost (#11).

/** @import { Backlog, BacklogTaken } from '../types/audio.ts' */

export const CHUNK_SEC = 0.1; // pcm-worklet.js sends 1600 samples at 16 kHz per chunk

/**
 * @param {number} max  chunks kept
 * @returns {Backlog}
 */
export function createBacklog(max) {
  /** @type {ArrayBuffer[]} */
  let chunks = [];
  let dropped = 0;
  return {
    push(chunk) {
      chunks.push(chunk);
      if (chunks.length > max) {
        chunks.shift();
        dropped++;
      }
    },
    get dropped() {
      return dropped;
    },
    // Everything kept, oldest first, and how many chunks were dropped; empties the backlog.
    take() {
      const out = { chunks, dropped };
      chunks = [];
      dropped = 0;
      return out;
    },
  };
}

/**
 * "4 min 12 s", "45 s", "5 min"
 * @param {number} sec
 */
export function duration(sec) {
  const s = Math.round(sec);
  const min = Math.floor(s / 60);
  const rest = s % 60;
  if (!min) return `${rest} s`;
  return rest ? `${min} min ${rest} s` : `${min} min`;
}

/**
 * What the page says after an outage that outlasted the backlog; '' when nothing was lost.
 * @param {BacklogTaken} taken
 */
export function lostNote({ chunks, dropped }) {
  if (!dropped) return '';
  const lost = dropped * CHUNK_SEC;
  const total = (chunks.length + dropped) * CHUNK_SEC;
  return `The server was unreachable for ${duration(total)} while recording. Only the last ${duration(chunks.length * CHUNK_SEC)} were kept, `
    + `so the first ${duration(lost)} of it were lost (not transcribed).`;
}
