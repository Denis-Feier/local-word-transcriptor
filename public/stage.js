// Projector view: the last few sentences in large type, centred, plus the sentence being spoken.
// Used by the main page (Projector button) and by the caption-only window (/?display).

const PREFS_KEY = 'stage';
const DEFAULTS = { size: 4.5, lines: 3, theme: 'dark' }; // size in % of the screen width
export const SIZE = { min: 2.5, max: 10, step: 0.5 };
export const THEMES = { dark: 'White on black', contrast: 'Yellow on black', light: 'Black on white' };
const IDLE_MS = 2500;

export function loadPrefs() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREFS_KEY)) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); // other windows pick this up via the storage event
  } catch {
    // private mode: prefs last until the page closes
  }
}

/**
 * @param {HTMLElement} root  the .stage element
 * @param {object} hooks      onToggle (start/stop), onSettings, onClose; omitted ones hide their buttons
 */
export function createStage(root, hooks = {}) {
  const linesEl = root.querySelector('.stage-lines');
  const frame = root.querySelector('.stage-frame');
  const hint = root.querySelector('.stage-hint');
  const toolbar = root.querySelector('.stage-toolbar');
  const button = (action) => toolbar.querySelector(`[data-action="${action}"]`);
  let prefs = loadPrefs();
  let snap = { finals: [], partial: null, recording: false, speaking: false };
  let idleTimer = null;
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

  function setPrefs(patch) {
    prefs = { ...prefs, ...patch };
    savePrefs(prefs);
    applyPrefs();
  }

  function render() {
    const finals = snap.finals.slice(-prefs.lines);
    const rows = finals.map((l, i) => ({ ...l, kind: i === finals.length - 1 ? 'latest' : 'older' }));
    // The live sentence goes underneath; an empty row keeps the block from jumping when someone starts talking.
    rows.push(snap.partial ? { ...snap.partial, kind: 'partial' } : { key: 'next', text: '', kind: 'placeholder' });

    // Reuse elements by key so a live sentence turns final in place instead of being redrawn.
    const existing = new Map([...linesEl.children].map((el) => [el.dataset.key, el]));
    const wanted = new Set(rows.map((r) => String(r.key)));
    for (const [key, el] of existing) if (!wanted.has(key)) el.remove();
    rows.forEach((row, i) => {
      let el = existing.get(String(row.key));
      if (!el) {
        el = document.createElement('p');
        el.dataset.key = row.key;
      }
      el.className = `stage-line ${row.kind}`;
      if (el.textContent !== row.text) el.textContent = row.text;
      el.setAttribute('aria-hidden', String(row.kind === 'partial' || row.kind === 'placeholder'));
      if (linesEl.children[i] !== el) linesEl.insertBefore(el, linesEl.children[i] ?? null);
    });
    // offsetHeight ignores the slide-in animation's transform, so a new line doesn't count as overflow.
    frame.classList.toggle('overflowing', linesEl.offsetHeight > frame.clientHeight + 1);

    const empty = !finals.length && !snap.partial;
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
    clearTimeout(idleTimer);
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

  function onKey(e) {
    if (root.hidden || e.target.closest?.('input, select, textarea, .drawer')) return;
    const keys = {
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

  const nextTheme = () => {
    const names = Object.keys(THEMES);
    return names[(names.indexOf(prefs.theme) + 1) % names.length];
  };

  toolbar.addEventListener('click', (e) => {
    const action = e.target.closest('button')?.dataset.action;
    if (action === 'toggle') hooks.onToggle();
    else if (action === 'smaller') setPrefs({ size: Math.max(SIZE.min, prefs.size - SIZE.step) });
    else if (action === 'bigger') setPrefs({ size: Math.min(SIZE.max, prefs.size + SIZE.step) });
    else if (action === 'lines') setPrefs({ lines: (prefs.lines % 5) + 1 });
    else if (action === 'theme') setPrefs({ theme: nextTheme() });
    else if (action === 'settings') hooks.onSettings();
    else if (action === 'fullscreen') toggleFullscreen();
    else if (action === 'close') hooks.onClose();
  });
  root.addEventListener('dblclick', (e) => !e.target.closest('.stage-toolbar') && toggleFullscreen());
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
