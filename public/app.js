import { createStage } from './stage.js';
import { createSettings } from './settings.js';
import { listInputs, openCapture } from './mics.js';
import { canChooseOutput, listOutputs, openSpeaker } from './speaker.js';
import { createBacklog, lostNote } from './backlog.js';
import { spokenOrder } from './order.js';
/** @import { CaptionRow, ClientMessage, ModelInfo, ServerMessage, StageSnapshot } from '../types/protocol.ts' */
/** @import { Capture, EngineView, Line, MicPick, MicSlot, SettingsPanel, Speaker, SpeakerPick, Stage, Store } from '../types/page.ts' */

/** @typedef {Line & { end: number }} FinalLine  a final line knows when it ended */
/** @typedef {{ stream: MediaStream, since: number, heard: boolean, silent: boolean }} Hush  a mic watched for digital silence */

/**
 * An element of the page, by id; the markup has every one asked for.
 * @template {HTMLElement} [T=HTMLElement]
 * @param {string} id
 * @returns {T}
 */
const $ = (id) => /** @type {T} */ (document.getElementById(id));
/**
 * @type {{
 *   status: HTMLElement, statusText: HTMLElement, lang: HTMLElement, toggle: HTMLButtonElement, toggleText: HTMLElement,
 *   levels: HTMLElement, settingsLevels: HTMLElement, copy: HTMLButtonElement, download: HTMLButtonElement,
 *   clear: HTMLButtonElement, model: HTMLSelectElement, modelNotes: HTMLElement, mics: HTMLElement,
 *   speaker: HTMLSelectElement, speakerVolume: HTMLInputElement, speakerVolumeField: HTMLElement, noise: HTMLInputElement,
 *   saveAudio: HTMLInputElement, steadyLive: HTMLInputElement, error: HTMLElement, behind: HTMLElement,
 *   transcript: HTMLElement, empty: HTMLElement, file: HTMLElement, projector: HTMLButtonElement,
 *   openSettings: HTMLButtonElement, privacy: HTMLElement,
 * }}
 */
const els = {
  status: $('status'),
  statusText: $('statusText'),
  lang: $('lang'),
  toggle: $('toggle'),
  toggleText: $('toggleText'),
  levels: $('levels'),
  settingsLevels: $('settingsLevels'),
  copy: $('copy'),
  download: $('download'),
  clear: $('clear'),
  model: $('model'),
  modelNotes: $('modelNotes'),
  mics: $('mics'),
  speaker: $('speaker'),
  speakerVolume: $('speakerVolume'),
  speakerVolumeField: $('speakerVolumeField'),
  noise: $('noise'),
  saveAudio: $('saveAudio'),
  steadyLive: $('steadyLive'),
  error: $('error'),
  behind: $('behind'),
  transcript: $('transcript'),
  empty: $('empty'),
  file: $('file'),
  projector: $('projector'),
  openSettings: $('openSettings'),
  privacy: $('privacy'),
};

const MAX_BACKLOG = 3000; // 100 ms chunks = the newest 5 minutes of audio kept while the server is unreachable
const CHANNEL = 'transcriber-captions'; // main window -> caption windows (/?display), same browser
const DISPLAY_ONLY = new URLSearchParams(location.search).has('display');
const NONE = 'none'; // "no second mic" in the mic menus, "no speaker" in the speaker menu
const OVERLAP_SEC = 0.5; // lines from two mics overlapping at least this long were spoken at the same time
const BLOCK = 100; // lines per block of the transcript: a new word lays out one block, not the whole meeting
const SHOWN = 5; // finished lines the projector gets (its Lines setting goes up to 5)
const LOCAL_NOTE = els.privacy.textContent;

/** @type {WebSocket | null} */
let ws = null;
let generation = 0; // bumps on every (re)connect; server segment ids restart per connection
/** @type {EngineView} */
let engine = { state: 'loading', message: 'Connecting…', model: null };
/** @type {ModelInfo[]} */
let models = [];
let recording = false;
/** @type {Capture | null} */
let capture = null; // the open mics while recording (mics.js)
const backlog = createBacklog(MAX_BACKLOG);
let lost = ''; // what an outage longer than the backlog cost, shown until the next Start
// Where the transcript is, so a reconnect (server restarted, network dropped) carries it on (#10): the server's name for
// it, and the audio sent per mic since the page opened (audio an outage dropped is not counted, as in the WAVs). A reload
// starts again, as the page does.
/** @type {string | null} */
let resumeName = null;
let sentSamples = 0;
/** @type {WakeLockSentinel | null} */
let wakeLock = null;
let modelSignature = '';
let maxMics = 1; // how many mics may be used at once; the server says (MAX_MICS)
/** @type {MicPick[]} */
let picks = []; // the chosen mics in order (Mic 1, Mic 2, …); id '' = system default
/** @type {MediaDeviceInfo[]} */
let inputs = []; // the audio inputs the browser lists
let defaultId = ''; // the input behind "System default"
let micWarning = '';
/** @type {MediaDeviceInfo[]} */
let outputs = []; // the audio outputs the browser lists
/** @type {SpeakerPick | null} */
let speakerPick = null; // where the mics are played; id '' = system default; null = nowhere
/** @type {Speaker | null} */
let speaker = null; // the mics playing on it (speaker.js)
let speakerTurn = 0; // bumps on every (re)open, so an older open that finishes late is closed again
let speakerOpening = false;
/** @type {ReturnType<typeof setInterval> | null} */
let speakerMeter = null; // moves the meters from the speaker's mics while not recording
/** @type {Set<number>} */
const speaking = new Set(); // mics on which someone is talking right now
/** @type {(Hush | null | undefined)[]} */
const hush = []; // per mic, to find a mic that is open but sends no sound
/** @type {Stage} */
let stage; // set by initMain() or initDisplay(), before anything uses it
/** @type {SettingsPanel} */
let settings; // set by initMain()
/** @type {BroadcastChannel | null} */
let channel = null;
/** @type {Set<string>} */
const captionWindows = new Set(); // the caption windows (/?display) open in this browser, by their id
/** @type {Record<string, string>} */
const files = {};
// Every message touches only the newest lines, so its cost stays the same however long the meeting gets.
/** @type {Map<number, Line>} */
const lines = new Map(); // generation * 1e6 + segment id -> the line
/** @type {number[]} */
const order = []; // the keys of `lines` in speaking order, as in the .txt (order.js); new lines are almost always last
/** @type {Set<number>} */
const live = new Set(); // keys of the lines not final yet (being spoken or transcribed): a few at a time
/** @type {{ connection: number, lines: FinalLine[], longest: number }} */
let spoken = { connection: 0, lines: [], longest: 0 }; // this connection's final lines with a mic label, by start, for ⇄

/** @type {Store} */
const store = {
  get: (key, fallback) => {
    try {
      return JSON.parse(/** @type {string} */ (localStorage.getItem(key))) ?? fallback; // nothing saved: null, which parses to null
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
  ws = new WebSocket(`ws://${location.host}/ws?mics`); // ?mics: audio frames start with the number of mics
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    generation++;
    send({ type: 'options', saveAudio: els.saveAudio.checked, steadyLive: els.steadyLive.checked });
    if (resumeName || sentSamples) send({ type: 'resume', name: resumeName, samples: sentSamples });
    const kept = backlog.take();
    for (const chunk of kept.chunks) sendAudio(chunk);
    lost = lostNote(kept) || lost;
    if (lost) showError(lost);
  };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => {
    engine = { ...engine, state: 'error', message: recording ? 'Server unreachable; still recording, will catch up…' : 'Disconnected, retrying…' };
    for (const key of [...live]) removeLine(key);
    showBehind(0); // a new connection is a new session, which reports its own delay
    render();
    setTimeout(connect, 1500);
  };
}

/**
 * One chunk: Uint32 number of mics, then each mic's samples.
 * @param {ArrayBuffer} buffer
 */
function sendAudio(buffer) {
  /** @type {WebSocket} */ (ws).send(buffer); // called while connected
  const count = new Uint32Array(buffer, 0, 1)[0];
  sentSamples += (buffer.byteLength - 4) / 4 / count;
}

/** @param {ClientMessage} msg */
function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/** @param {ServerMessage} msg */
function handle(msg) {
  const key = generation * 1e6 + (/** @type {{ id?: number }} */ (msg).id ?? 0); // used for the sentence messages, which carry a number
  switch (msg.type) {
    case 'status':
      engine = msg;
      if (msg.language) els.lang.textContent = msg.language.toUpperCase();
      if (msg.detector) settings.setDetector(msg.detector);
      if (msg.state === 'ready') lost ? showError(lost) : hideError();
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
    case 'mics':
      maxMics = msg.max;
      micsUpdated();
      break;
    case 'vad':
      setSpeaking(msg.mic ?? 0, msg.speaking);
      break;
    case 'tuning':
      settings.setTuning(msg);
      break;
    case 'partial':
      upsertLine(key, msg, false);
      break;
    case 'final':
      if (msg.text) upsertLine(key, msg, true);
      else removeLine(key);
      break;
    case 'file':
      files[`${msg.kind}${msg.mic ?? ''}`] = msg.path;
      if (msg.name) resumeName = msg.name;
      els.file.textContent = `Saving to ${Object.values(files).join(' + ')}`;
      break;
    case 'error':
      showError(msg.message);
      break;
    case 'behind':
      showBehind(msg.seconds);
      break;
    case 'options':
      // The server stopped saving audio (a full disk): untick the box. The saved choice stays, so the next session
      // tries again.
      if (msg.saveAudio !== undefined) els.saveAudio.checked = msg.saveAudio;
      break;
  }
}

// ---------- microphones ----------

/** @param {number} mic */
const micName = (mic) => `Mic ${mic + 1}`;
/** "Mic 2", "Mic 2 and Mic 3", "Mic 1, Mic 2 and Mic 4" */
/** @param {Iterable<number>} mics */
const listMics = (mics) => {
  const names = [...mics].sort((a, b) => a - b).map(micName);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
};
const used = () => picks.slice(0, maxMics);
const multiMic = () => used().length > 1;

/** @returns {MicPick[]} */
function loadPicks() {
  const saved = store.get('mics', /** @type {MicPick[] | null} */ (null));
  if (Array.isArray(saved) && saved.length) return saved;
  return [{ id: store.get('mic', ''), label: '' }]; // the single-mic setting of earlier versions
}

/** The mics are remembered, not their mute: the app always opens with every mic on, so none is left muted by mistake. */
const savePicks = () => store.set('mics', picks.map(({ id, label }) => ({ id, label })));

/** The device a pick means right now: by id, else by name (a re-paired Bluetooth device can get a new id). */
/**
 * @param {{ id: string, label: string }} pick
 * @param {MediaDeviceInfo[]} devices
 */
function findDevice(pick, devices) {
  if (devices.some((d) => d.deviceId === pick.id)) return pick.id;
  return devices.find((d) => pick.label && d.label === pick.label)?.deviceId ?? pick.id;
}

/** @param {MicPick} pick */
const resolve = (pick) => (pick.id ? findDevice(pick, inputs) : defaultId); // the input a mic pick means

/** @param {MicPick} pick */
const openId = (pick) => (pick.id ? resolve(pick) : ''); // '' lets the browser follow the system default
/** @param {MicPick} pick */
const connected = (pick) => !pick.id || inputs.some((d) => d.deviceId === resolve(pick));

async function refreshDevices() {
  ({ inputs, defaultId } = await listInputs());
  outputs = await listOutputs();
  // Names appear once the mic is allowed; remember them, to find a mic again if its id changes.
  const named = picks.map((p) => ({ ...p, label: inputs.find((d) => d.deviceId === p.id)?.label || p.label }));
  const renamed = named.some((p, i) => p.label !== picks[i].label);
  picks = named;
  if (renamed) savePicks();
  renderMicFields();
  // A mic that was switched off or out of range is back: let it join the recording, and the speaker, again.
  for (const open of [capture, speaker]) {
    open?.slots.forEach((slot, mic) => {
      if (!slot.stream && picks[mic] && connected(picks[mic])) /** @type {Capture | Speaker} */ (open).reattach(mic, openId(picks[mic]));
    });
  }
  speakerDevicesChanged();
}

/** One menu per mic. Mic 1 is always used; the next one offers "None", up to the server's limit. */
function renderMicFields() {
  const count = Math.min(maxMics, picks.length + 1);
  els.mics.replaceChildren();
  for (let mic = 0; mic < count; mic++) {
    const pick = picks[mic];
    const taken = new Set(picks.filter((_, other) => other !== mic && other < maxMics).map(resolve));
    const field = document.createElement('label');
    field.className = 'field';
    const name = document.createElement('span');
    name.textContent = maxMics > 1 ? micName(mic) : 'Microphone';
    const select = document.createElement('select');
    const first = new Option(mic === 0 ? 'System default' : 'None', mic === 0 ? '' : NONE);
    first.disabled = mic === 0 && taken.has(defaultId);
    select.add(first);
    inputs.forEach((d, i) => {
      const option = new Option(d.label || `Microphone ${i + 1}`, d.deviceId);
      option.disabled = taken.has(d.deviceId);
      select.add(option);
    });
    if (pick?.id && !inputs.some((d) => d.deviceId === resolve(pick))) {
      select.add(new Option(`${pick.label || 'Microphone'} (not connected)`, pick.id));
    }
    select.value = pick ? (pick.id ? resolve(pick) : '') : NONE;
    select.addEventListener('change', () => chooseMic(mic, select.value));
    if (multiMic() && pick) field.dataset.mic = String(mic + 1);
    field.append(name, select);
    els.mics.append(field);
  }
}

/**
 * @param {number} mic
 * @param {string} id
 */
function chooseMic(mic, id) {
  if (id === NONE) picks.splice(mic, 1);
  else picks[mic] = { id, label: inputs.find((d) => d.deviceId === id)?.label ?? '' }; // another mic starts unmuted
  savePicks();
  micsUpdated();
  restartCapture();
  if (speakerPick) restartSpeaker();
}

/** The number of mics or their order changed. */
function micsUpdated() {
  renderMicFields();
  settings.setMics(used().length);
  // A level meter and speech indicator per mic, in the controls bar and in Settings.
  for (const root of [els.levels, els.settingsLevels]) {
    root.replaceChildren();
    used().forEach((_, mic) => {
      const el = document.createElement('div');
      el.className = 'level';
      el.innerHTML = '<span class="who"></span><div class="meter" title="Microphone level"><div class="meter-fill"></div></div><span class="speaking"></span><button class="ghost mute" type="button"></button>';
      /** @type {HTMLButtonElement} */ (el.querySelector('.mute')).addEventListener('click', () => toggleMute(mic));
      if (multiMic()) {
        el.dataset.mic = String(mic + 1);
        /** @type {HTMLElement} */ (el.querySelector('.who')).textContent = micName(mic);
      }
      root.append(el);
    });
  }
  renderLevels();
}

/** @param {number} mic */
const levelEls = (mic) => /** @type {HTMLElement[]} */ ([els.levels, els.settingsLevels].map((root) => root.children[mic]).filter(Boolean));

function renderLevels() {
  const open = capture ?? speaker;
  used().forEach(({ muted = false }, mic) => {
    const missing = Boolean(open && !open.slots[mic]?.stream);
    const silent = Boolean(open && silentNow(open.slots[mic], mic));
    const name = multiMic() ? micName(mic) : 'the microphone';
    for (const el of levelEls(mic)) {
      const label = /** @type {HTMLElement} */ (el.querySelector('.speaking'));
      label.textContent = missing ? 'not connected' : muted ? 'muted' : silent ? 'no sound' : speaking.has(mic) ? 'speech' : 'listening';
      label.classList.toggle('on', speaking.has(mic) && !muted);
      label.classList.toggle('off', missing || muted || silent);
      el.classList.toggle('muted', muted);
      const button = /** @type {HTMLButtonElement} */ (el.querySelector('.mute'));
      button.textContent = muted ? 'Unmute' : 'Mute';
      button.setAttribute('aria-label', `${muted ? 'Unmute' : 'Mute'} ${name}`);
      button.title = muted ? `Unmute ${name}` : `Mute ${name}: silence instead of its sound in the transcript, the saved audio and the speaker`;
      if (missing || !open) /** @type {HTMLElement} */ (el.querySelector('.meter-fill')).style.width = '0';
    }
  });
}

/** Mute a mic that misbehaves during a meeting, or unmute it. It stays open, so it is back at once. */
/** @param {number} mic */
function toggleMute(mic) {
  picks[mic].muted = !picks[mic].muted;
  for (const open of [capture, speaker]) open?.mute(mic, picks[mic].muted);
  hush[mic] = null; // silence while muted is not a fault; unmuted, it gets a fresh wait for sound
  devicesChanged();
}

/** Mutes as chosen now, for mics that were still opening when one was muted or unmuted. */
/** @param {Capture | Speaker} open */
const syncMutes = (open) => open.slots.forEach((_, mic) => open.mute(mic, Boolean(picks[mic]?.muted)));
const mutedMics = () => used().map((pick) => Boolean(pick.muted));

const NO_SIGNAL = 1e-5; // -100 dBFS: digital silence, below any real mic's own noise (lib/crosstalk.js)
const SILENT_MS = 5000;

/**
 * A mic that is open but has sent only digital silence since it was opened: muted, or on a Mac a second Bluetooth
 * headset, whose mic macOS stops when another Bluetooth headset's mic is in use. Warned about until sound arrives.
 */
/**
 * @param {number} rms
 * @param {number} mic
 */
function checkSilence(rms, mic) {
  const stream = (capture ?? speaker)?.slots[mic]?.stream;
  if (!stream || picks[mic]?.muted) return;
  let h = hush[mic];
  if (h?.stream !== stream) h = hush[mic] = { stream, since: performance.now(), heard: false, silent: false };
  if (h.heard) return;
  if (rms >= NO_SIGNAL) {
    h.heard = true;
    if (h.silent) {
      h.silent = false;
      devicesChanged();
    }
  } else if (!h.silent && performance.now() - h.since > SILENT_MS) {
    h.silent = true;
    devicesChanged();
  }
}

/**
 * @param {MicSlot | undefined} slot
 * @param {number} mic
 */
const silentNow = (slot, mic) => Boolean(slot?.stream && hush[mic]?.stream === slot.stream && /** @type {Hush} */ (hush[mic]).silent);

/**
 * @param {number} rms
 * @param {number} mic
 */
function showLevel(rms, mic) {
  checkSilence(rms, mic);
  // Map roughly -60..0 dBFS onto 0..100 %.
  const pct = Math.max(0, Math.min(100, ((20 * Math.log10(rms + 1e-9) + 60) / 60) * 100));
  for (const el of levelEls(mic)) /** @type {HTMLElement} */ (el.querySelector('.meter-fill')).style.width = `${pct}%`;
}

/** @param {ArrayBuffer} buffer */
function showLevels(buffer) {
  const count = new Uint32Array(buffer, 0, 1)[0];
  const samples = new Float32Array(buffer, 4);
  const length = samples.length / count;
  for (let mic = 0; mic < count; mic++) {
    let sum = 0;
    for (let i = mic * length; i < (mic + 1) * length; i++) sum += samples[i] * samples[i];
    showLevel(Math.sqrt(sum / length), mic);
  }
}

async function openMics() {
  const opened = await openCapture(used().map(openId), {
    noiseSuppression: els.noise.checked,
    muted: mutedMics(),
    onChunk: (buffer) => {
      showLevels(buffer);
      if (ws?.readyState === WebSocket.OPEN) sendAudio(buffer);
      else {
        backlog.push(buffer);
        if (backlog.dropped === 1) {
          engine = { ...engine, message: 'Server unreachable; still recording, keeping the last 5 minutes…' };
          render();
        }
      }
    },
    onChange: devicesChanged,
  });
  syncMutes(opened);
  return opened;
}

/** @param {number} mic */
const isBluetooth = (mic) => /bluetooth|airpods/i.test(picks[mic]?.label ?? '');

/**
 * @param {string} name
 * @param {number} mic
 */
function silentNote(name, mic) {
  const note = `${name} sends no sound. Check that it is not muted.`;
  const otherBluetooth = used().some((_, other) => other !== mic && isBluetooth(other));
  if (!isBluetooth(mic) || !otherBluetooth) return note;
  return `${note} A computer often takes sound from only one Bluetooth headset mic at a time (a Mac always does): connect one of them through its USB receiver or a cable instead.`;
}

/** Mics or the speaker missing, or mics recording at a low rate, as a warning; the rest goes on without them. */
function devicesChanged() {
  renderLevels();
  /** @type {string[]} */
  const notes = [];
  // The mics as the recording has them, or else as the speaker has them.
  (capture ?? speaker)?.slots.forEach((slot, mic) => {
    const name = multiMic() ? `${micName(mic)} (${picks[mic].label || 'microphone'})` : picks[mic].label || 'The microphone';
    if (!slot.stream) notes.push(`${name} is not connected; it joins again as soon as it is back.`);
    else if (picks[mic].muted) return; // muted on purpose: its silence and its quality are no news
    else if (silentNow(slot, mic)) notes.push(silentNote(name, mic));
    else if (slot.rate && slot.rate < 16000) notes.push(`${name} records at ${slot.rate / 1000} kHz (older Bluetooth headsets do), so its text will be less accurate.`);
  });
  if (speakerPick && !speakerConnected()) notes.push(`The speaker (${speakerPick.label || 'speaker'}) is not connected; it plays again as soon as it is back.`);
  if (notes.length) {
    micWarning = notes.join('\n');
    showError(micWarning);
  } else if (micWarning && els.error.textContent === micWarning) {
    hideError();
  }
}

function closeCapture() {
  capture?.close();
  capture = null;
}

async function start() {
  lost = '';
  hideError();
  try {
    capture = await openMics();
  } catch (/** @type {any} */ err) {
    const missing = err.name === 'NotFoundError' || err.name === 'OverconstrainedError';
    showError(err.name === 'NotAllowedError'
      ? 'Microphone access was blocked. Allow it in the browser address bar (and in System Settings → Privacy & Security → Microphone), then try again.'
      : missing ? 'The microphone is not connected. Connect it, or pick another one.' : `Could not open the microphone: ${err.message}`);
    return;
  }
  recording = true;
  keepAwake(true);
  refreshDevices(); // device names become available once permission is granted
  devicesChanged();
  render();
}

function stop() {
  recording = false;
  closeCapture();
  send({ type: 'flush' }); // finalise whatever was being said
  keepAwake(Boolean(speaker)); // the speaker plays on
  speaking.clear();
  renderLevels();
  render();
}

/** Mics or noise setting changed mid-recording: reopen the capture without ending the session. */
async function restartCapture() {
  if (!recording) return;
  closeCapture();
  try {
    capture = await openMics();
    devicesChanged();
  } catch (/** @type {any} */ err) {
    showError(`Could not switch microphone: ${err.message}`);
    stop();
  }
}

/** @param {boolean} on */
async function keepAwake(on) {
  // A laptop left transcribing a meeting, or playing it on a speaker, must not dim and sleep.
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

/**
 * @param {number} mic
 * @param {boolean} on
 */
function setSpeaking(mic, on) {
  if (on) speaking.add(mic);
  else speaking.delete(mic);
  renderLevels();
  publish();
}

// ---------- speaker ----------

// Both only while a speaker is picked.
const speakerId = () => (/** @type {SpeakerPick} */ (speakerPick).id ? findDevice(/** @type {SpeakerPick} */ (speakerPick), outputs) : ''); // the output the pick means
const speakerConnected = () => !(/** @type {SpeakerPick} */ (speakerPick)).id || outputs.some((d) => d.deviceId === speakerId());
const volume = () => Number(els.speakerVolume.value) / 100;

/** None, System default, then every output; a chosen one that is gone stays listed as "not connected". */
function renderSpeakerField() {
  const select = els.speaker;
  select.replaceChildren(new Option('None', NONE), new Option('System default', ''));
  if (canChooseOutput) outputs.forEach((d, i) => select.add(new Option(d.label || `Speaker ${i + 1}`, d.deviceId)));
  if (speakerPick && !speakerConnected()) select.add(new Option(`${speakerPick.label || 'Speaker'} (not connected)`, speakerPick.id));
  select.value = speakerPick ? speakerId() : NONE;
  els.speakerVolumeField.hidden = !speakerPick;
}

/** @param {string} id */
function chooseSpeaker(id) {
  speakerPick = id === NONE ? null : { id, label: outputs.find((d) => d.deviceId === id)?.label ?? '' };
  restartSpeaker();
}

/** Play the mics on the chosen speaker, again after a change; nothing while it is missing. */
async function restartSpeaker() {
  const turn = ++speakerTurn;
  speaker?.close();
  speaker = null;
  if (speakerPick && speakerConnected()) {
    speakerOpening = true;
    try {
      const opened = await openSpeaker(used().map(openId), { sinkId: speakerId(), volume: volume(), muted: mutedMics(), onChange: devicesChanged });
      if (turn !== speakerTurn) return opened.close(); // chosen again meanwhile
      syncMutes(opened);
      speaker = opened;
      refreshDevices(); // speaker names become available once the mics are allowed
    } catch (/** @type {any} */ err) {
      if (turn !== speakerTurn) return;
      speakerPick = null;
      showError(`Could not play on the speaker: ${err.message}`);
    } finally {
      if (turn === speakerTurn) speakerOpening = false;
    }
  }
  renderSpeakerField();
  keepAwake(recording || Boolean(speaker));
  // A sound check before Start: the meters follow the speaker's mics; while recording, the recording moves them.
  clearInterval(speakerMeter ?? undefined);
  speakerMeter = speaker && setInterval(() => !recording && speaker?.levels().forEach(showLevel), 100);
  devicesChanged();
}

/** The outputs changed: follow the chosen speaker as it goes, comes back, or comes back under a new id. */
function speakerDevicesChanged() {
  if (speakerPick) speakerPick.label = outputs.find((d) => d.deviceId === /** @type {SpeakerPick} */ (speakerPick).id)?.label || speakerPick.label;
  renderSpeakerField();
  // Gone: stop at once, rather than let the sound fall back to the laptop's own speakers.
  if (speaker && (!speakerConnected() || speaker.sinkId !== speakerId())) restartSpeaker();
  else if (speakerPick && !speaker && !speakerOpening && speakerConnected()) restartSpeaker();
}

// ---------- transcript ----------

/** @param {number} [sec] */
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

/**
 * @param {number} key
 * @param {{ text: string, start?: number, end?: number, mic?: number, model?: string, ms?: number }} msg  a partial or final message
 * @param {boolean} final
 */
function upsertLine(key, { text, start, end, mic = 0, model, ms }, final) {
  const stick = nearBottom();
  let line = lines.get(key);
  if (!line) {
    const el = document.createElement('p');
    el.className = 'line';
    el.innerHTML = '<span class="meta"><time></time><span class="who"></span></span><span class="text"></span>';
    // With several mics, each line says which mic heard it, by name and colour.
    const labeled = multiMic();
    if (labeled) {
      el.dataset.mic = String(mic + 1);
      /** @type {HTMLElement} */ (el.querySelector('.who')).textContent = micName(mic);
    }
    // Where the line goes depends on when its sentence started: known from its first message, and it never changes.
    line = { el, connection: Math.floor(key / 1e6), id: key % 1e6, text, start: /** @type {number} */ (start), mic, labeled, final: false }; // every message that makes a line has a start
    lines.set(key, line);
    live.add(key);
    place(key, line);
  }
  if (line.final && !final) return;
  const finished = final && !line.final;
  Object.assign(line, { text, start, end, final });
  line.el.classList.toggle('partial', !final);
  /** @type {HTMLElement} */ (line.el.querySelector('time')).textContent = fmtTime(start);
  /** @type {HTMLElement} */ (line.el.querySelector('.text')).textContent = text;
  if (final && model) line.el.title = `${model} · ${ms} ms`;
  if (finished) {
    live.delete(key);
    markOverlap(key);
  }
  els.empty.hidden = true;
  if (stick) els.transcript.scrollTop = els.transcript.scrollHeight;
  render();
}

/**
 * Put a new line in speaking order (order.js): a live guess for a newer sentence can arrive before the older one's,
 * and the rest of a sentence cut for being too long starts before a sentence another mic started meanwhile (#50).
 */
/**
 * @param {number} key
 * @param {Line} line
 */
function place(key, line) {
  const { el } = line;
  let i = order.length;
  while (i > 0 && spokenOrder(line, /** @type {Line} */ (lines.get(order[i - 1]))) < 0) i--; // the newest lines are last: a step or two
  order.splice(i, 0, key);
  const next = lines.get(order[i + 1]);
  if (next) {
    next.el.before(el);
    return;
  }
  // Lines go in blocks: a change lays out its own block and steps over the others, instead of every line.
  let block = els.transcript.lastElementChild;
  if (!block?.classList.contains('block') || block.childElementCount >= BLOCK) {
    block = document.createElement('div');
    block.className = 'block';
    els.transcript.append(block);
  }
  block.append(el);
}

/** The index of the first line in `list` (sorted by start time) that starts after `time`. */
/**
 * @param {Line[]} list
 * @param {number} time
 */
function startsAfter(list, time) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].start <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Mark a final line and the lines from other mics that were spoken at the same time. */
/** @param {number} key */
function markOverlap(key) {
  const line = /** @type {FinalLine} */ (lines.get(key)); // just made final
  if (!line.labeled || !Number.isFinite(line.start) || !Number.isFinite(line.end)) return;
  const connection = Math.floor(key / 1e6); // ids restart per connection (and times, when it could not carry on)
  if (spoken.connection !== connection) spoken = { connection, lines: [], longest: 0 };
  // A line that overlaps this one starts at most `longest` seconds before it: look at those lines alone.
  const list = spoken.lines;
  for (let i = startsAfter(list, line.start - spoken.longest - 1); i < list.length && list[i].start < line.end; i++) {
    const other = list[i];
    if (other.mic === line.mic) continue;
    if (Math.min(line.end, other.end) - Math.max(line.start, other.start) < OVERLAP_SEC) continue;
    for (const [a, b] of [[line, other], [other, line]]) {
      a.el.classList.add('overlap');
      a.with ??= new Set(); // with three or four mics, a line can overlap lines of two others
      a.with.add(b.mic);
      /** @type {HTMLElement} */ (a.el.querySelector('.who')).title = `Spoken at the same time as ${listMics(a.with)}`;
    }
  }
  list.splice(startsAfter(list, line.start), 0, line);
  spoken.longest = Math.max(spoken.longest, line.end - line.start);
}

/** @param {number} key */
function removeLine(key) {
  const line = lines.get(key);
  if (!line) return; // the final of a click or cough that never had a live guess
  const block = /** @type {HTMLElement} */ (line.el.parentNode); // every line sits in a block
  line.el.remove();
  if (!block.firstChild) block.remove();
  lines.delete(key);
  order.splice(order.lastIndexOf(key), 1);
  live.delete(key);
  const indexed = line.final ? spoken.lines.lastIndexOf(/** @type {FinalLine} */ (line)) : -1; // the server never takes a final line back; in case
  if (indexed >= 0) spoken.lines.splice(indexed, 1);
  els.empty.hidden = lines.size > 0;
  render();
}

/** The final lines in order, for Copy and Download (this looks at every line, so not on every message). */
function finalLines() {
  return /** @type {Line[]} */ (order.map((key) => lines.get(key))).filter((l) => l.final);
}

/** @param {Line} l */
const lineText = (l) => (l.labeled ? `${micName(l.mic)}: ${l.text}` : l.text);

async function copyText() {
  await navigator.clipboard.writeText(finalLines().map(lineText).join('\n'));
  flash(els.copy, 'Copied');
}

function downloadText() {
  const text = finalLines().map((l) => `[${fmtTime(l.start)}] ${lineText(l)}`).join('\n') + '\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = `transcript-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function clearTranscript() {
  els.transcript.replaceChildren(els.empty);
  lines.clear();
  order.length = 0;
  live.clear();
  spoken = { connection: generation, lines: [], longest: 0 };
  els.empty.hidden = false;
  els.file.textContent = '';
  for (const kind of Object.keys(files)) delete files[kind];
  resumeName = null; // the server starts a new file; the clock goes on, as it does there
  send({ type: 'reset' });
  render();
}

// ---------- projector ----------

/**
 * What the projector view needs: recent final sentences, the ones being spoken, and the mic state.
 * @returns {StageSnapshot}
 */
function snapshot() {
  /**
   * @param {number} key
   * @returns {CaptionRow}
   */
  const row = (key) => {
    const l = /** @type {Line} */ (lines.get(key)); // every key in order and live is a line
    return { key, text: l.text, mic: l.labeled ? l.mic : null };
  };
  // From the end of the transcript back: only the newest lines are looked at.
  /** @type {CaptionRow[]} */
  const finals = [];
  for (let i = order.length - 1; i >= 0 && finals.length < SHOWN; i--) if (/** @type {Line} */ (lines.get(order[i])).final) finals.unshift(row(order[i]));
  // The sentence being spoken on each mic: two when people talk at the same time.
  /** @type {Map<number, number>} */
  const newest = new Map(); // mic -> key
  for (const key of live) {
    const { mic } = /** @type {Line} */ (lines.get(key));
    if (!(/** @type {number} */ (newest.get(mic)) > key)) newest.set(mic, key); // no entry yet: undefined compares false, as wanted
  }
  const partials = [...newest.values()].sort((a, b) => a - b).map(row);
  return { finals, partials, recording, speaking: speaking.size > 0 };
}

/** Update the projector view and the caption windows; nothing to do while neither is open. */
function publish() {
  if (!stage || (!stage.open && !captionWindows.size)) return;
  const snap = snapshot();
  stage.update(snap);
  if (captionWindows.size) channel?.postMessage({ type: 'snapshot', ...snap });
}

function showProjector() {
  stage.update(snapshot()); // it was not kept up to date while closed
  stage.show();
}

function openCaptionWindow() {
  window.open('/?display', 'captions', 'popup,width=1280,height=720');
}

// ---------- models ----------

/** The menu entry: the model, its one-line reason for its place in the ranking (#28), and its download state. */
/** @param {ModelInfo} m */
function modelOptionLabel(m) {
  const name = m.reason ? `${m.label} — ${m.reason}` : m.label;
  if (m.installed) return name;
  if (m.progress !== null) return `${name} (downloading ${Math.floor(m.progress * 100)}%)`;
  return `${name} (download ${m.download})`;
}

const GROUPS = [['recommended', 'Recommended'], ['other', 'Other models']];

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
  if (engine.state === 'ready') {
    // Where it runs: the GPU first, the CPU only when the GPU failed (hover for the device and the reason).
    const where = /^GPU/.test(engine.device ?? '') ? 'GPU' : engine.device === 'CPU' ? 'CPU' : '';
    text = `${models.find((m) => m.id === engine.model)?.label ?? engine.model} · ready${where ? ` on ${where}` : ''}`;
  }
  els.status.title = engine.state === 'ready' && engine.device
    ? `Runs on ${engine.device}${engine.fallback ? `. The GPU could not run it: ${engine.fallback.split('\n')[0]}` : ''}`
    : '';
  if (downloading && engine.state !== 'loading') text = `Downloading ${downloading.label}… ${Math.floor(/** @type {number} */ (downloading.progress) * 100)}%`;
  els.status.dataset.state = downloading ? 'loading' : engine.state;
  els.statusText.textContent = text;

  const signature = JSON.stringify([engine.model, models.map(modelOptionLabel)]);
  if (signature !== modelSignature) {
    modelSignature = signature;
    els.model.length = 0;
    if (!engine.model) els.model.add(new Option('Choose a model…', ''));
    // Recommended models first, then the rest, each group in ranking order (the server's order).
    for (const [tier, label] of GROUPS) {
      const group = models.filter((m) => (m.tier ?? 'other') === tier);
      if (!group.length) continue;
      const optgroup = document.createElement('optgroup');
      optgroup.label = label;
      for (const m of group) optgroup.append(new Option(modelOptionLabel(m), m.id));
      els.model.append(optgroup);
    }
    els.model.value = engine.model ?? '';
  }
  const active = models.find((m) => m.id === engine.model);
  els.modelNotes.textContent = active ? `${active.notes} (${active.engine})` : '';
  els.privacy.textContent = active?.cloud
    ? `${active.label} sends the speech to the internet for transcription. The other models run on this computer.`
    : LOCAL_NOTE;
  els.privacy.classList.toggle('cloud', Boolean(active?.cloud));

  const usable = engine.state === 'ready' || engine.state === 'loading';
  els.toggle.disabled = !recording && !usable;
  els.toggle.classList.toggle('recording', recording);
  els.toggleText.textContent = recording ? 'Stop' : 'Start';
  const hasText = lines.size > live.size; // some line is final
  els.copy.disabled = !hasText;
  els.download.disabled = !hasText;
  els.clear.disabled = lines.size === 0;
  publish();
}

/** @param {string} message */
function showError(message) {
  els.error.textContent = message;
  els.error.hidden = false;
}

/** The model is slower than the talk: lines still come, in order, but late. 0 clears the warning. */
/** @param {number} seconds */
function showBehind(seconds) {
  const delay = seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
  els.behind.textContent = `Transcription is ${delay} behind; a faster model would keep up`;
  els.behind.hidden = !seconds;
}

function hideError() {
  els.error.hidden = true;
}

/**
 * @param {HTMLElement} button
 * @param {string} label
 */
function flash(button, label) {
  const old = button.textContent;
  button.textContent = label;
  setTimeout(() => (button.textContent = old), 1200);
}

// ---------- startup ----------

function initMain() {
  settings = createSettings($('settings'), {
    send,
    onDisplayPrefs: (patch) => stage.setPrefs(patch),
    onOpenDisplay: openCaptionWindow,
  });
  stage = createStage($('stage'), {
    onToggle: () => (recording ? stop() : start()),
    onSettings: () => settings.toggle(),
    onClose: () => stage.hide(),
  });
  if ('BroadcastChannel' in window) {
    // Captions go out only while a caption window listens: each one says hello when it opens and goodbye when it closes.
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = ({ data }) => {
      if (data?.type === 'hello') {
        captionWindows.add(data.id);
        publish();
      } else if (data?.type === 'gone') captionWindows.delete(data.id);
    };
    const here = () => channel?.postMessage({ type: 'here' }); // caption windows already open say hello again
    here(); // e.g. this page was reloaded
    window.addEventListener('pagehide', () => channel?.postMessage({ type: 'bye' }));
    window.addEventListener('pageshow', (e) => e.persisted && here()); // back from the browser's page cache
  }

  els.toggle.addEventListener('click', () => (recording ? stop() : start()));
  els.projector.addEventListener('click', showProjector);
  els.openSettings.addEventListener('click', () => settings.toggle());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'p' && !stage.open && !e.metaKey && !e.ctrlKey && !(/** @type {Element} */ (e.target)).closest('input, select, textarea')) showProjector();
  });
  els.copy.addEventListener('click', copyText);
  els.download.addEventListener('click', downloadText);
  els.clear.addEventListener('click', clearTranscript);
  els.model.addEventListener('change', chooseModel);
  els.noise.addEventListener('change', () => {
    store.set('noise', els.noise.checked);
    restartCapture();
  });
  els.saveAudio.addEventListener('change', () => {
    store.set('saveAudio', els.saveAudio.checked);
    send({ type: 'options', saveAudio: els.saveAudio.checked });
  });
  els.steadyLive.addEventListener('change', () => {
    store.set('steadyLive', els.steadyLive.checked);
    send({ type: 'options', steadyLive: els.steadyLive.checked });
  });
  els.speaker.addEventListener('change', () => chooseSpeaker(els.speaker.value));
  els.speakerVolume.addEventListener('input', () => speaker?.setVolume(volume()));
  els.speakerVolume.addEventListener('change', () => store.set('speakerVolume', Number(els.speakerVolume.value)));
  navigator.mediaDevices?.addEventListener('devicechange', refreshDevices);
  document.addEventListener('visibilitychange', () => {
    // The lock drops when the tab is hidden.
    if ((recording || speaker) && document.visibilityState === 'visible') keepAwake(true);
  });

  els.noise.checked = store.get('noise', false);
  els.saveAudio.checked = store.get('saveAudio', false);
  els.steadyLive.checked = store.get('steadyLive', true);
  // The volume is remembered; the speaker itself starts at None, so the app never opens with a howl.
  els.speakerVolume.value = String(store.get('speakerVolume', 80));
  picks = loadPicks();
  micsUpdated();
  renderSpeakerField();
  refreshDevices();
  connect();
}

/** /?display: captions only, fed by the main window through a BroadcastChannel. Drag it to the projector. */
function initDisplay() {
  document.body.classList.add('display-only');
  document.title = 'Captions';
  /** @type {StageSnapshot} */
  const empty = { finals: [], partials: [], recording: false, speaking: false };
  stage = createStage($('stage'));
  stage.show({ fullscreen: false }); // full screen needs a click or key press in this window: F or double-click
  stage.update({ ...empty, waiting: true });
  if (!('BroadcastChannel' in window)) return;
  channel = new BroadcastChannel(CHANNEL);
  const id = Math.random().toString(36).slice(2); // the main window sends captions while any caption window is open
  const hello = () => channel?.postMessage({ type: 'hello', id });
  channel.onmessage = (e) => {
    if (e.data?.type === 'snapshot') stage.update(e.data);
    else if (e.data?.type === 'bye') stage.update({ ...empty, waiting: true });
    else if (e.data?.type === 'here') hello(); // the main window was reloaded
  };
  hello();
  window.addEventListener('pagehide', () => channel?.postMessage({ type: 'gone', id }));
  window.addEventListener('pageshow', (e) => e.persisted && hello()); // back from the browser's page cache
}

if (DISPLAY_ONLY) initDisplay();
else initMain();
