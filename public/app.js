const $ = (id) => document.getElementById(id);
const els = {
  status: $('status'),
  statusText: $('statusText'),
  lang: $('lang'),
  toggle: $('toggle'),
  toggleText: $('toggleText'),
  meter: $('meter'),
  speaking: $('speaking'),
  copy: $('copy'),
  download: $('download'),
  clear: $('clear'),
  model: $('model'),
  modelNotes: $('modelNotes'),
  mic: $('mic'),
  noise: $('noise'),
  saveAudio: $('saveAudio'),
  error: $('error'),
  transcript: $('transcript'),
  empty: $('empty'),
  file: $('file'),
};

const MAX_BACKLOG = 3000; // 100 ms chunks = 5 minutes of audio kept while the server is unreachable

let ws = null;
let generation = 0; // bumps on every (re)connect; server segment ids restart per connection
let engine = { state: 'loading', message: 'Connecting…', model: null };
let models = [];
let recording = false;
let audio = null; // { ctx, stream, node }
let backlog = [];
let wakeLock = null;
let modelSignature = '';
const files = {};
const lines = new Map(); // generation * 1e6 + segment id -> { el, text, start, final }

const store = {
  get: (key, fallback) => {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set: (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // private mode; settings just won't persist
    }
  },
};

// ---------- server connection ----------

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    generation++;
    send({ type: 'options', saveAudio: els.saveAudio.checked });
    for (const chunk of backlog) ws.send(chunk);
    backlog = [];
  };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => {
    engine = { ...engine, state: 'error', message: recording ? 'Server unreachable; still recording, will catch up…' : 'Disconnected, retrying…' };
    for (const [key, line] of lines) if (!line.final) removeLine(key);
    render();
    setTimeout(connect, 1500);
  };
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function handle(msg) {
  const key = generation * 1e6 + (msg.id ?? 0);
  switch (msg.type) {
    case 'status':
      engine = msg;
      if (msg.language) els.lang.textContent = msg.language.toUpperCase();
      if (msg.state === 'ready') hideError();
      render();
      break;
    case 'models':
      models = msg.models;
      engine.model = msg.active;
      render();
      break;
    case 'progress': {
      const m = models.find((x) => x.id === msg.id);
      if (m) m.progress = msg.progress;
      render();
      break;
    }
    case 'vad':
      els.speaking.textContent = msg.speaking ? 'speech' : 'listening';
      els.speaking.classList.toggle('on', msg.speaking);
      break;
    case 'partial':
      upsertLine(key, msg, false);
      break;
    case 'final':
      if (msg.text) upsertLine(key, msg, true);
      else removeLine(key);
      break;
    case 'file':
      files[msg.kind] = msg.path;
      els.file.textContent = `Saving to ${Object.values(files).join(' + ')}`;
      break;
    case 'error':
      showError(msg.message);
      break;
  }
}

// ---------- microphone ----------

async function openCapture() {
  const deviceId = els.mic.value;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      channelCount: 1,
      // Room setup: no playback to cancel, and the browser's noise filter can eat distant voices.
      echoCancellation: false,
      noiseSuppression: els.noise.checked,
      autoGainControl: true, // lifts quiet or far-away speakers
    },
  });
  // Ask the browser to resample to 16 kHz; Firefox refuses to mix rates, so fall back to the native rate
  // and let the worklet downsample.
  let ctx;
  let source;
  try {
    ctx = new AudioContext({ sampleRate: 16000 });
    source = ctx.createMediaStreamSource(stream);
  } catch {
    await ctx?.close();
    ctx = new AudioContext();
    source = ctx.createMediaStreamSource(stream);
  }
  await ctx.resume();
  await ctx.audioWorklet.addModule('/pcm-worklet.js');
  const node = new AudioWorkletNode(ctx, 'pcm-capture');
  node.port.onmessage = (e) => {
    const chunk = e.data;
    showLevel(chunk);
    if (ws?.readyState === WebSocket.OPEN) ws.send(chunk.buffer);
    else if (backlog.length < MAX_BACKLOG) backlog.push(chunk.buffer);
  };
  source.connect(node);
  node.connect(ctx.destination); // keeps the node pulled by the graph; it outputs silence
  return { ctx, stream, node };
}

function closeCapture() {
  if (!audio) return;
  audio.node.port.onmessage = null;
  audio.stream.getTracks().forEach((t) => t.stop());
  audio.ctx.close();
  audio = null;
}

async function start() {
  hideError();
  try {
    audio = await openCapture();
  } catch (err) {
    showError(err.name === 'NotAllowedError'
      ? 'Microphone access was blocked. Allow it in the browser address bar (and in System Settings → Privacy & Security → Microphone), then try again.'
      : `Could not open the microphone: ${err.message}`);
    return;
  }
  recording = true;
  keepAwake(true);
  listMics(); // device names become available once permission is granted
  render();
}

function stop() {
  recording = false;
  closeCapture();
  send({ type: 'flush' }); // finalise whatever was being said
  keepAwake(false);
  els.meter.style.width = '0';
  els.speaking.textContent = 'listening';
  els.speaking.classList.remove('on');
  render();
}

/** Mic or noise setting changed mid-recording: reopen the capture without ending the session. */
async function restartCapture() {
  if (!recording) return;
  closeCapture();
  try {
    audio = await openCapture();
  } catch (err) {
    showError(`Could not switch microphone: ${err.message}`);
    stop();
  }
}

async function listMics() {
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const inputs = devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default');
  const saved = store.get('mic', '');
  els.mic.length = 1; // keep "System default"
  inputs.forEach((d, i) => els.mic.add(new Option(d.label || `Microphone ${i + 1}`, d.deviceId)));
  els.mic.value = inputs.some((d) => d.deviceId === saved) ? saved : '';
}

async function keepAwake(on) {
  // A laptop left transcribing a meeting must not dim and sleep.
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    // not supported or not allowed; recording still works
  }
}

function showLevel(chunk) {
  let sum = 0;
  for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
  const rms = Math.sqrt(sum / chunk.length);
  // Map roughly -60..0 dBFS onto 0..100 %.
  const pct = Math.max(0, Math.min(100, ((20 * Math.log10(rms + 1e-9) + 60) / 60) * 100));
  els.meter.style.width = `${pct}%`;
}

// ---------- transcript ----------

function fmtTime(sec = 0) {
  const s = Math.floor(sec);
  const hh = Math.floor(s / 3600);
  const mmss = `${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return hh ? `${hh}:${mmss}` : mmss;
}

function nearBottom() {
  const t = els.transcript;
  return t.scrollHeight - t.scrollTop - t.clientHeight < 80;
}

function upsertLine(key, { text, start, model, ms }, final) {
  const stick = nearBottom();
  let line = lines.get(key);
  if (!line) {
    const el = document.createElement('p');
    el.className = 'line';
    el.innerHTML = '<time></time><span class="text"></span>';
    // Keep lines in order even if a live guess for a newer segment arrived first.
    const after = [...lines.keys()].filter((k) => k > key).sort((a, b) => a - b)[0];
    els.transcript.insertBefore(el, after ? lines.get(after).el : null);
    line = { el };
    lines.set(key, line);
  }
  if (line.final && !final) return;
  Object.assign(line, { text, start, final });
  line.el.classList.toggle('partial', !final);
  line.el.querySelector('time').textContent = fmtTime(start);
  line.el.querySelector('.text').textContent = text;
  if (final && model) line.el.title = `${model} · ${ms} ms`;
  els.empty.hidden = true;
  if (stick) els.transcript.scrollTop = els.transcript.scrollHeight;
  render();
}

function removeLine(key) {
  lines.get(key)?.el.remove();
  lines.delete(key);
  els.empty.hidden = lines.size > 0;
  render();
}

function finalLines() {
  return [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([, l]) => l).filter((l) => l.final);
}

async function copyText() {
  await navigator.clipboard.writeText(finalLines().map((l) => l.text).join('\n'));
  flash(els.copy, 'Copied');
}

function downloadText() {
  const text = finalLines().map((l) => `[${fmtTime(l.start)}] ${l.text}`).join('\n') + '\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = `transcript-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function clearTranscript() {
  for (const line of lines.values()) line.el.remove();
  lines.clear();
  els.empty.hidden = false;
  els.file.textContent = '';
  delete files.text;
  delete files.audio;
  send({ type: 'reset' });
  render();
}

// ---------- models ----------

function modelOptionLabel(m) {
  if (m.installed) return `${m.label}`;
  if (m.progress !== null) return `${m.label} (downloading ${Math.floor(m.progress * 100)}%)`;
  return `${m.label} (download ${m.download})`;
}

function chooseModel() {
  const m = models.find((x) => x.id === els.model.value);
  els.model.value = engine.model ?? ''; // the server confirms the switch with a status message
  if (!m) return;
  if (m.installed) send({ type: 'select', id: m.id });
  else if (m.progress === null && confirm(`Download ${m.label} (${m.download})? It will be used as soon as it's ready.`)) {
    send({ type: 'install', id: m.id });
  }
}

// ---------- UI state ----------

function render() {
  const downloading = models.find((m) => m.progress !== null);
  let text = engine.message;
  if (engine.state === 'ready') text = `${models.find((m) => m.id === engine.model)?.label ?? engine.model} · ready`;
  if (downloading && engine.state !== 'loading') text = `Downloading ${downloading.label}… ${Math.floor(downloading.progress * 100)}%`;
  els.status.dataset.state = downloading ? 'loading' : engine.state;
  els.statusText.textContent = text;

  const signature = JSON.stringify([engine.model, models.map(modelOptionLabel)]);
  if (signature !== modelSignature) {
    modelSignature = signature;
    els.model.length = 0;
    if (!engine.model) els.model.add(new Option('Choose a model…', ''));
    for (const m of models) els.model.add(new Option(modelOptionLabel(m), m.id));
    els.model.value = engine.model ?? '';
  }
  const active = models.find((m) => m.id === engine.model);
  els.modelNotes.textContent = active ? `${active.notes} (${active.engine})` : '';

  const usable = engine.state === 'ready' || engine.state === 'loading';
  els.toggle.disabled = !recording && !usable;
  els.toggle.classList.toggle('recording', recording);
  els.toggleText.textContent = recording ? 'Stop' : 'Start';
  const hasText = finalLines().length > 0;
  els.copy.disabled = !hasText;
  els.download.disabled = !hasText;
  els.clear.disabled = lines.size === 0;
}

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = false;
}

function hideError() {
  els.error.hidden = true;
}

function flash(button, label) {
  const old = button.textContent;
  button.textContent = label;
  setTimeout(() => (button.textContent = old), 1200);
}

els.toggle.addEventListener('click', () => (recording ? stop() : start()));
els.copy.addEventListener('click', copyText);
els.download.addEventListener('click', downloadText);
els.clear.addEventListener('click', clearTranscript);
els.model.addEventListener('change', chooseModel);
els.mic.addEventListener('change', () => {
  store.set('mic', els.mic.value);
  restartCapture();
});
els.noise.addEventListener('change', () => {
  store.set('noise', els.noise.checked);
  restartCapture();
});
els.saveAudio.addEventListener('change', () => {
  store.set('saveAudio', els.saveAudio.checked);
  send({ type: 'options', saveAudio: els.saveAudio.checked });
});
navigator.mediaDevices?.addEventListener('devicechange', listMics);
document.addEventListener('visibilitychange', () => {
  if (recording && document.visibilityState === 'visible') keepAwake(true); // the lock drops when the tab is hidden
});

els.noise.checked = store.get('noise', false);
els.saveAudio.checked = store.get('saveAudio', false);
listMics();
connect();
