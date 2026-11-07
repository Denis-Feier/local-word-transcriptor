// Projector view: the last few sentences in large type, centred, plus the sentence being spoken.
// Used by the main page (Projector button) and by the caption-only window (/?display).

import type { Stage, StageHooks, StagePrefs, StageSnapshot, Theme } from '../types/page.ts';

const PREFS_KEY = 'stage';
const DEFAULTS: StagePrefs = { size: 4.5, lines: 3, theme: 'dark' }; // size in % of the screen width
export const SIZE = { min: 2.5, max: 10, step: 0.5 };
export const THEMES = { dark: 'White on black', contrast: 'Yellow on black', light: 'Black on white' };
const IDLE_MS = 2500;

export function loadPrefs(): StagePrefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREFS_KEY) as string) }; // nothing saved: null, which parses to null and spreads to nothing
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(prefs: StagePrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); // other windows pick this up via the storage event
  } catch {
    // private mode: prefs last until the page closes
  }
}

export function createStage(root: HTMLElement, hooks: StageHooks = {}): Stage {
  const linesEl = root.querySelector('.stage-lines') as HTMLElement;
  const frame = root.querySelector('.stage-frame') as HTMLElement;
  const hint = root.querySelector('.stage-hint') as HTMLElement;
  const toolbar = root.querySelector('.stage-toolbar') as HTMLElement;
  const button = (action: string) => toolbar.querySelector(`[data-action="${action}"]`) as HTMLButtonElement;
  let prefs = loadPrefs();
  let snap: StageSnapshot = { finals: [], partials: [], recording: false, speaking: false };
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let leavingFullscreen = false;

  button('toggle').hidden = !hooks.onToggle;
  button('settings').hidden = !hooks.onSettings;
  button('close').hidden = !hooks.onClose;

  function applyPrefs() {
    root.style.setProperty('--stage-size', `${prefs.size}vw`);
    root.dataset.theme = prefs.theme;
    button('lines').textContent = `${prefs.lines} ${prefs.lines === 1 ? 'line' : 'lines'}`;
    button('theme').textContent = THEMES[prefs.theme];
    render();
  }

  function setPrefs(patch: Partial<StagePrefs>) {
    prefs = { ...prefs, ...patch };
    savePrefs(prefs);
    applyPrefs();
  }

  function render() {
    const finals = snap.finals.slice(-prefs.lines);
    const rows: { key: number | string, text: string, mic?: number | null, kind: string }[] = finals.map((l, i) => ({ ...l, kind: i === finals.length - 1 ? 'latest' : 'older' }));
    // Live sentences go underneath (one per mic when people talk at once); an empty row keeps the block from
    // jumping when someone starts talking.
    if (snap.partials.length) rows.push(...snap.partials.map((p) => ({ ...p, kind: 'partial' })));
    else rows.push({ key: 'next', text: '', kind: 'placeholder' });

    // Reuse elements by key so a live sentence turns final in place instead of being redrawn.
    const existing = new Map(([...linesEl.children] as HTMLElement[]).map((el) => [el.dataset.key, el] as [string, HTMLElement]));
    const wanted = new Set(rows.map((r) => String(r.key)));
    for (const [key, el] of existing) if (!wanted.has(key)) el.remove();
    rows.forEach((row, i) => {
      let el = existing.get(String(row.key));
      if (!el) {
        el = document.createElement('p');
        el.dataset.key = String(row.key);
      }
      el.className = `stage-line ${row.kind}`;
      if (row.mic === null || row.mic === undefined) delete el.dataset.mic;
      else el.dataset.mic = String(row.mic + 1); // with several mics, each speaker's text has the mic's colour
      if (el.textContent !== row.text) el.textContent = row.text;
      el.setAttribute('aria-hidden', String(row.kind === 'partial' || row.kind === 'placeholder'));
      if (linesEl.children[i] !== el) linesEl.insertBefore(el, linesEl.children[i] ?? null);
    });
    // offsetHeight ignores the slide-in animation's transform, so a new line doesn't count as overflow.
    frame.classList.toggle('overflowing', linesEl.offsetHeight > frame.clientHeight + 1);

    const empty = !finals.length && !snap.partials.length;
    hint.hidden = !empty;
    hint.textContent = snap.waiting
      ? 'Waiting for the transcriber window…'
      : !snap.recording ? 'Microphone is off' : 'Listening…';
    root.dataset.state = !snap.recording ? 'off' : snap.speaking ? 'speech' : 'listening';
    if (hooks.onToggle) button('toggle').textContent = snap.recording ? 'Stop' : 'Start';
  }

  // Controls and cursor fade out so the audience only sees text; any movement brings them back.
  function wake() {
    root.classList.remove('idle');
    clearTimeout(idleTimer ?? undefined);
    idleTimer = setTimeout(() => {
      if (!toolbar.matches(':hover, :focus-within')) root.classList.add('idle');
    }, IDLE_MS);
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) {
        leavingFullscreen = true;
        await document.exitFullscreen();
      } else {
        // The whole page goes full screen (not just this view) so the Settings panel can open on top of it.
        await document.documentElement.requestFullscreen();
      }
    } catch {
      // not allowed (e.g. no user gesture); the view still fills the window
    }
  }

  function onKey(e: KeyboardEvent) {
    if (root.hidden || (e.target as Element | null)?.closest?.('input, select, textarea, .drawer')) return;
    const keys: Record<string, () => void> = {
      '+': () => setPrefs({ size: Math.min(SIZE.max, prefs.size + SIZE.step) }),
      '=': () => setPrefs({ size: Math.min(SIZE.max, prefs.size + SIZE.step) }),
      '-': () => setPrefs({ size: Math.max(SIZE.min, prefs.size - SIZE.step) }),
      f: toggleFullscreen,
      l: () => setPrefs({ lines: (prefs.lines % 5) + 1 }),
      t: () => setPrefs({ theme: nextTheme() }),
      Escape: () => hooks.onClose?.(),
    };
    const action = keys[e.key];
    if (!action) return;
    e.preventDefault();
    action();
    wake();
  }

  const nextTheme = (): Theme => {
    const names = Object.keys(THEMES) as Theme[];
    return names[(names.indexOf(prefs.theme) + 1) % names.length];
  };

  toolbar.addEventListener('click', (e) => {
    const action = (e.target as Element).closest('button')?.dataset.action;
    if (action === 'toggle') hooks.onToggle?.(); // a button without its hook is hidden (above)
    else if (action === 'smaller') setPrefs({ size: Math.max(SIZE.min, prefs.size - SIZE.step) });
    else if (action === 'bigger') setPrefs({ size: Math.min(SIZE.max, prefs.size + SIZE.step) });
    else if (action === 'lines') setPrefs({ lines: (prefs.lines % 5) + 1 });
    else if (action === 'theme') setPrefs({ theme: nextTheme() });
    else if (action === 'settings') hooks.onSettings?.();
    else if (action === 'fullscreen') toggleFullscreen();
    else if (action === 'close') hooks.onClose?.();
  });
  root.addEventListener('dblclick', (e) => !(e.target as Element).closest('.stage-toolbar') && toggleFullscreen());
  root.addEventListener('pointermove', wake);
  document.addEventListener('keydown', onKey);
  document.addEventListener('fullscreenchange', () => {
    const full = Boolean(document.fullscreenElement);
    button('fullscreen').textContent = full ? 'Exit full screen' : 'Full screen';
    // Esc in full screen leaves the projector view entirely; the button only leaves full screen.
    if (!full && !leavingFullscreen && !root.hidden) hooks.onClose?.();
    leavingFullscreen = false;
    render();
  });
  window.addEventListener('storage', (e) => {
    if (e.key === PREFS_KEY) {
      prefs = loadPrefs();
      applyPrefs();
    }
  });
  window.addEventListener('resize', render);

  applyPrefs();

  return {
    get open() {
      return !root.hidden;
    },
    show({ fullscreen = true } = {}) {
      root.hidden = false;
      render();
      wake();
      if (fullscreen) toggleFullscreen();
    },
    hide() {
      if (document.fullscreenElement) {
        leavingFullscreen = true;
        document.exitFullscreen().catch(() => {});
      }
      root.hidden = true;
    },
    update(next) {
      snap = next;
      if (!root.hidden) render();
    },
    get prefs() {
      return prefs;
    },
    setPrefs,
  };
}
