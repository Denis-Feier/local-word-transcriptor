// Settings panel: speech detection (applied live on the server, shared by all windows) and
// projector display (stored in this browser).
import { SIZE, THEMES, loadPrefs } from './stage.js';
import type { SettingsHooks, SettingsPanel, Theme } from '../types/page.ts';
import type { TuningKey, TuningRanges } from '../types/config.ts';
import type { TuningMessage } from '../types/protocol.ts';
import type { DetectorName } from '../types/audio.ts';

/** one slider */
type Field = { key: TuningKey, label: string, format: (v: number) => string, hint: string };
type FieldUi = { f: Field, wrap: HTMLElement, input: HTMLInputElement, output: HTMLOutputElement, hint: HTMLElement };

const FIELDS: Field[] = [
  {
    key: 'vadThreshold',
    label: 'Speech detection threshold',
    format: (v) => v.toFixed(2),
    hint: 'Lower picks up quiet or distant voices. Higher ignores background noise.',
  },
  {
    key: 'silenceMs',
    label: 'Pause that ends a sentence',
    format: (v) => `${(v / 1000).toFixed(1)} s`,
    hint: 'Longer suits people who speak slowly or pause in the middle of a sentence.',
  },
  {
    key: 'minSpeechMs',
    label: 'Ignore sounds shorter than',
    format: (v) => `${v} ms`,
    hint: 'Filters coughs, clicks and moving chairs.',
  },
  {
    key: 'maxSegmentSec',
    label: 'Longest sentence',
    format: (v) => `${v} s`,
    hint: 'Longer speech is split at its quietest moment.',
  },
  {
    key: 'partialEverySec',
    label: 'Live text refresh',
    format: (v) => `${v.toFixed(1)} s`,
    hint: 'How often the grey live text updates. Slower models update less often by themselves.',
  },
  {
    key: 'crosstalkDb',
    label: 'Mic separation',
    format: (v) => `${v} dB`,
    hint: 'With two mics, each also hears the other person, only less clearly. Lower ignores more of the other person; higher keeps both when people talk at the same time.',
  },
];

export function createSettings(root: HTMLElement, { send, onDisplayPrefs, onOpenDisplay }: SettingsHooks): SettingsPanel {
  /** An element of the drawer, by selector; the markup has every one asked for. */
  const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => root.querySelector(sel) as T;
  const fieldsEl = $('#tuningFields');
  const fields: Record<string, FieldUi> = {};
  let returnFocus: HTMLElement | null = null;

  function build(ranges: TuningRanges) {
    for (const f of FIELDS) {
      const range = ranges[f.key];
      if (!range) continue;
      const wrap = document.createElement('div');
      wrap.className = 'setting';
      wrap.innerHTML = `
        <label for="tune-${f.key}"><span></span><output></output></label>
        <input type="range" id="tune-${f.key}" min="${range.min}" max="${range.max}" step="${range.step}">
        <p class="setting-hint"></p>`;
      (wrap.querySelector('span') as HTMLElement).textContent = f.label;
      const input = wrap.querySelector('input') as HTMLInputElement;
      const output = wrap.querySelector('output') as HTMLOutputElement;
      const hint = wrap.querySelector('.setting-hint') as HTMLElement;
      input.addEventListener('input', () => (output.textContent = f.format(Number(input.value))));
      // Send on release only: changing the threshold rebuilds the detector.
      input.addEventListener('change', () => send({ type: 'tuning', values: { [f.key]: Number(input.value) } }));
      fieldsEl.append(wrap);
      fields[f.key] = { f, wrap, input, output, hint };
    }
  }

  function setTuning({ values, defaults, ranges }: TuningMessage) {
    if (!Object.keys(fields).length) {
      build(ranges);
      setAvailable();
    }
    for (const { f, wrap, input, output, hint } of Object.values(fields)) {
      if (document.activeElement !== input) input.value = String(values[f.key]);
      output.textContent = f.format(values[f.key]);
      hint.textContent = `${f.hint} Default: ${f.format(defaults[f.key])}.`;
      wrap.classList.toggle('changed', values[f.key] !== defaults[f.key]);
    }
  }

  let detector: DetectorName | null = null;
  let mics = 1;

  /** Grey out the sliders that do nothing right now: the threshold with the loudness detector, separation with one mic. */
  function setAvailable() {
    const off = { vadThreshold: detector === 'energy', crosstalkDb: mics < 2 };
    for (const [key, disabled] of Object.entries(off)) {
      if (!fields[key]) continue;
      fields[key].input.disabled = disabled;
      fields[key].wrap.classList.toggle('disabled', disabled);
    }
  }

  // Projector display controls mirror the projector view's own toolbar.
  const size: HTMLInputElement = $('#displaySize');
  const sizeOut = $('#displaySizeOut');
  const lines: HTMLSelectElement = $('#displayLines');
  const theme: HTMLSelectElement = $('#displayTheme');
  Object.assign(size, { min: SIZE.min, max: SIZE.max, step: SIZE.step });
  for (let n = 1; n <= 5; n++) lines.add(new Option(String(n), String(n)));
  for (const [value, label] of Object.entries(THEMES)) theme.add(new Option(label, value));

  function refreshDisplay() {
    const prefs = loadPrefs();
    size.value = String(prefs.size);
    sizeOut.textContent = `${prefs.size}`;
    lines.value = String(prefs.lines);
    theme.value = prefs.theme;
  }

  size.addEventListener('input', () => {
    sizeOut.textContent = size.value;
    onDisplayPrefs({ size: Number(size.value) });
  });
  lines.addEventListener('change', () => onDisplayPrefs({ lines: Number(lines.value) }));
  theme.addEventListener('change', () => onDisplayPrefs({ theme: theme.value as Theme })); // its options are THEMES
  $('#openDisplay').addEventListener('click', onOpenDisplay);
  $('#tuningReset').addEventListener('click', () => send({ type: 'tuning', reset: true }));
  $('#settingsClose').addEventListener('click', () => close());
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });
  window.addEventListener('storage', (e) => e.key === 'stage' && refreshDisplay());

  function open() {
    returnFocus = document.activeElement as HTMLElement | null;
    refreshDisplay();
    root.hidden = false;
    $('#settingsClose').focus();
  }

  function close() {
    root.hidden = true;
    returnFocus?.focus?.();
  }

  return {
    open,
    close,
    toggle: () => (root.hidden ? open() : close()),
    setTuning,
    setDetector: (name) => {
      detector = name;
      setAvailable();
    },
    setMics: (count) => {
      mics = count;
      setAvailable();
    },
  };
}
