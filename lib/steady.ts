/**
 * Steady live text (#26): live guesses re-transcribe the whole sentence so far, and a model with an attention decoder
 * (Canary in particular) revises earlier words, punctuation and capitals as more audio arrives, so the grey text jumps
 * around. LocalAgreement-2 (Macháček, Dabre & Bojar, "Turning Whisper into Real-Time Transcription System", 2023):
 * a word is shown only once two guesses in a row agree on it, and a word once shown is never taken back. The final line
 * replaces the live line once, at the end. The cost: a word appears about one guess (~0.5 s) later.
 *
 * Words are compared ignoring case and punctuation, and the form already on screen is kept, so a comma or a capital
 * appearing later does not rewrite a word. New words take the newest guess's form, without the punctuation after the
 * last one; the final line has the sentence's real punctuation.
 */

/** A word as compared: lower case, letters and digits only. */
export const wordKey = (word: string) => word.normalize('NFC').toLocaleLowerCase('ro').replace(/[^\p{L}\p{N}]+/gu, '');

const TRAILING = /[.,;:!?…]+$/u;
const ANCHOR = 2; // how far (in words) the last word shown may have moved in a new guess

export class SteadyText {
  prev: string[];
  shown: string[];

  constructor() {
    this.prev = []; // the previous guess, as words
    this.shown = []; // the words on screen, in the form first shown
  }

  /** A new guess of the whole sentence so far. Returns the text to show, or null when the screen stays as it is. */
  update(text: string): string | null {
    const words = text.split(/\s+/).filter(Boolean);
    const prev = this.prev;
    this.prev = words;
    const a = this.#after(prev);
    const b = this.#after(words);
    if (a < 0 || b < 0) return null;
    let agreed = 0;
    while (a + agreed < prev.length && b + agreed < words.length && wordKey(prev[a + agreed]) === wordKey(words[b + agreed])) agreed++;
    if (!agreed) return null;
    const added = words.slice(b, b + agreed);
    // A full stop or comma after the newest word is mostly the model guessing that the sentence ends there.
    added[agreed - 1] = added[agreed - 1].replace(TRAILING, '') || added[agreed - 1];
    this.shown.push(...added);
    return this.shown.join(' ');
  }

  /**
   * Where the words not shown yet begin in a guess: after the last word shown. A guess may have merged, split or
   * added a word earlier on, so the last word shown is looked for near its place, nearest first. -1: not found.
   */
  #after(words: string[]) {
    const n = this.shown.length;
    if (!n) return 0;
    const last = wordKey(this.shown[n - 1]);
    for (let d = 0; d <= ANCHOR; d++) {
      for (const i of d ? [n - 1 - d, n - 1 + d] : [n - 1]) {
        if (i >= 0 && i < words.length && wordKey(words[i]) === last) return i + 1;
      }
    }
    return -1;
  }
}
