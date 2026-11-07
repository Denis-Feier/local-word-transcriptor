// The order of the transcript's lines: the order they were spoken in. The page (its lines, Copy and Download) and the
// server (the saved .txt, lib/session.ts) both sort with this one rule, so the two cannot disagree (#7, #50).
/** @import { Spoken } from '../types/protocol.ts' */

/**
 * Compare two lines `{ connection, start, id }` for Array.sort: negative when `a` was spoken first.
 *
 * A line of an earlier connection comes first: sentence ids restart on every connection, and so do the times when the
 * server could not carry the transcript on (#10). Then the sentence that started first; two that started at the same
 * moment, by id. Not by id alone (#50): a sentence longer than the longest the model takes is cut at a pause up to 5 s
 * back, and the rest gets its id only then, after a sentence another mic started in those seconds.
 * @param {Spoken} a
 * @param {Spoken} b
 */
export function spokenOrder(a, b) {
  return (a.connection ?? 0) - (b.connection ?? 0) || a.start - b.start || a.id - b.id;
}
