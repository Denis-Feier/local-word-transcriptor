// Phrases Whisper invents on silence/noise, learned from Romanian YouTube subtitles.
const HALLUCINATIONS = [
  /pentru vizionare/i,
  /subtitr(are|area|at|ări)/i,
  /\babon(ează|ați|a)[- ]?(te|vă)/i,
  /nu uita(ți)? să (vă )?abon/i,
  /like.*(și|si).*(subscribe|abon)/i,
  /amara\.org/i,
];

export function isHallucination(text) {
  return HALLUCINATIONS.some((re) => re.test(text));
}

/** Clean one Whisper text chunk: correct Romanian diacritics, drop sound tags. */
export function normalize(text) {
  return text
    // Romanian uses comma-below ș/ț; Whisper sometimes emits the cedilla forms ş/ţ.
    .replace(/ş/g, 'ș').replace(/Ş/g, 'Ș').replace(/ţ/g, 'ț').replace(/Ţ/g, 'Ț')
    .replace(/\[[^\]]*\]/g, '') // [Muzică], [Râsete], [BLANK_AUDIO]
    .replace(/\*[^*]*\*/g, '') // *râde*
    .replace(/[♪♫]+/g, '')
    // Some fine-tunes omit the space between sentences ("ziua!Mă"). Lowercase before the mark keeps "S.U.A." intact.
    .replace(/([\p{Ll}][.!?…])(?=\p{Lu})/gu, '$1 ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Turn a model result into clean text. Known hallucinations are dropped sentence by sentence,
 * so real speech in the same utterance survives ("…două zile. Mulțumim pentru vizionare!").
 */
export function resultToText({ text }) {
  return normalize(text)
    .split(/(?<=[.!?…])\s+/)
    .filter((sentence) => sentence && !isHallucination(sentence))
    .join(' ');
}

/** Last ~maxChars of the transcript, cut on a word boundary, to use as the decoder prompt. */
export function contextTail(text, maxChars = 200) {
  if (text.length <= maxChars) return text;
  const tail = text.slice(-maxChars);
  const space = tail.indexOf(' ');
  return space === -1 ? tail : tail.slice(space + 1);
}
