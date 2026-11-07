import { createStage } from './stage.js';
import { createSettings } from './settings.js';
import { listInputs, openCapture } from './mics.js';
import { canChooseOutput, listOutputs, openSpeaker } from './speaker.js';
import { createBacklog, lostNote } from './backlog.js';
import { spokenOrder } from './order.js';
import type { CaptionMessage, CaptionRow, ClientMessage, ModelInfo, ServerMessage, Spoken, StageSnapshot } from '../types/protocol.ts';
import type { Capture, MicSlot, SettingsPanel, Speaker, Stage } from '../types/page.ts';
import type { TranscriberState } from '../types/engine.ts';

/** A chosen mic, in order (Mic 1, Mic 2, …); id '' is the system default. Remembered without its mute. */
export interface MicPick {
  id: string;
  /** The device's name, to find it again if its id changes (a re-paired Bluetooth device). */
  label: string;
  muted?: boolean;
}

/** The chosen output; id '' is the system default. */
export interface SpeakerPick {
  id: string;
  label: string;
}

/** One line of the transcript as the page keeps it (the `lines` map), live or final. */
export interface Line extends Spoken {
  el: HTMLElement;
  connection: number;
  text: string;
  end?: number;
  mic: number;
  /** Shows its mic's name and colour (several mics). */
  labeled: boolean;
  final: boolean;
  /** The other mics spoken at the same time as this line. */
  with?: Set<number>;
}

/** The page's view of the server's transcriber: the last status message, or the connecting placeholder. */
export interface EngineView {
  state: TranscriberState;
  message: string;
  model: string | null;
  device?: string | null;
  fallback?: string | null;
}

/** The page's wrapper over localStorage: JSON values, a fallback when there is none or storage is blocked. */
export interface Store {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
}

/** a final line knows when it ended */
type FinalLine = Line & { end: number };
/** a mic watched for digital silence */
type Hush = { stream: MediaStream, since: number, heard: boolean, silent: boolean };

/** An element of the page, by id; the markup has every one asked for. */
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const els: {
  status: HTMLElement, statusText: HTMLElement, lang: HTMLElement, toggle: HTMLButtonElement, toggleText: HTMLElement,
  levels: HTMLElement, settingsLevels: HTMLElement, copy: HTMLButtonElement, download: HTMLButtonElement,
  clear: HTMLButtonElement, model: HTMLSelectElement, modelNotes: HTMLElement, mics: HTMLElement,
  speaker: HTMLSelectElement, speakerVolume: HTMLInputElement, speakerVolumeField: HTMLElement, noise: HTMLInputElement,
  saveAudio: HTMLInputElement, steadyLive: HTMLInputElement, error: HTMLElement, behind: HTMLElement,
  transcript: HTMLElement, empty: HTMLElement, file: HTMLElement, projector: HTMLButtonElement,
  openSettings: HTMLButtonElement, privacy: HTMLElement,
} = {
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

let ws: WebSocket | null = null;
let generation = 0; // bumps on every (re)connect; server segment ids restart per connection
let engine: EngineView = { state: 'loading', message: 'Connecting…', model: null };
let models: ModelInfo[] = [];
let recording = false;
let capture: Capture | null = null; // the open mics while recording (mics.ts)
const backlog = createBacklog(MAX_BACKLOG);
let lost = ''; // what an outage longer than the backlog cost, shown until the next Start
// Where the transcript is, so a reconnect (server restarted, network dropped) carries it on (#10): the server's name for
// it, and the audio sent per mic since the page opened (audio an outage dropped is not counted, as in the WAVs). A reload
// starts again, as the page does.
let resumeName: string | null = null;
let sentSamples = 0;
let wakeLock: WakeLockSentinel | null = null;
let modelSignature = '';
let maxMics = 1; // how many mics may be used at once; the server says (MAX_MICS)
let picks: MicPick[] = []; // the chosen mics in order (Mic 1, Mic 2, …); id '' = system default
let inputs: MediaDeviceInfo[] = []; // the audio inputs the browser lists
let defaultId = ''; // the input behind "System default"
let micWarning = '';
let outputs: MediaDeviceInfo[] = []; // the audio outputs the browser lists
let speakerPick: SpeakerPick | null = null; // where the mics are played; id '' = system default; null = nowhere
let speaker: Speaker | null = null; // the mics playing on it (speaker.ts)
let speakerTurn = 0; // bumps on every (re)open, so an older open that finishes late is closed again
let speakerOpening = false;
let speakerMeter: ReturnType<typeof setInterval> | null = null; // moves the meters from the speaker's mics while not recording
const speaking: Set<number> = new Set(); // mics on which someone is talking right now
const hush: (Hush | null | undefined)[] = []; // per mic, to find a mic that is open but sends no sound
let stage: Stage; // set by initMain() or initDisplay(), before anything uses it
let settings: SettingsPanel; // set by initMain()
let channel: BroadcastChannel | null = null;
const captionWindows: Set<string> = new Set(); // the caption windows (/?display) open in this browser, by their id
const files: Record<string, string> = {};
// Every message touches only the newest lines, so its cost stays the same however long the meeting gets.
const lines: Map<number, Line> = new Map(); // generation * 1e6 + segment id -> the line
const order: number[] = []; // the keys of `lines` in speaking order, as in the .txt (order.ts); new lines are almost always last
const live: Set<number> = new Set(); // keys of the lines not final yet (being spoken or transcribed): a few at a time
let spoken: { connection: number, lines: FinalLine[], longest: number } = { connection: 0, lines: [], longest: 0 }; // this connection's final lines with a mic label, by start, for ⇄

const store: Store = {
  get: (key, fallback) => {
    try {
      return JSON.parse(localStorage.getItem(key) as string) ?? fallback; // nothing saved: null, which parses to null
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

/** One chunk: Uint32 number of mics, then each mic's samples. */
function sendAudio(buffer: ArrayBuffer) {
  (ws as WebSocket).send(buffer); // called while connected
  const count = new Uint32Array(buffer, 0, 1)[0];
  sentSamples += (buffer.byteLength - 4) / 4 / count;
}

function send(msg: ClientMessage) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function handle(msg: ServerMessage) {
  const key = generation * 1e6 + ((msg as { id?: number }).id ?? 0); // used for the sentence messages, which carry a number
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

const micName = (mic: number) => `Mic ${mic + 1}`;
/** "Mic 2", "Mic 2 and Mic 3", "Mic 1, Mic 2 and Mic 4" */
const listMics = (mics: Iterable<number>) => {
  const names = [...mics].sort((a, b) => a - b).map(micName);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
};
const used = () => picks.slice(0, maxMics);
const multiMic = () => used().length > 1;

function loadPicks(): MicPick[] {
  const saved = store.get('mics', null as MicPick[] | null);
  if (Array.isArray(saved) && saved.length) return saved;
  return [{ id: store.get('mic', ''), label: '' }]; // the single-mic setting of earlier versions
}

/** The mics are remembered, not their mute: the app always opens with every mic on, so none is left muted by mistake. */
const savePicks = () => store.set('mics', picks.map(({ id, label }) => ({ id, label })));

/** The device a pick means right now: by id, else by name (a re-paired Bluetooth device can get a new id). */
function findDevice(pick: { id: string, label: string }, devices: MediaDeviceInfo[]) {
  if (devices.some((d) => d.deviceId === pick.id)) return pick.id;
  return devices.find((d) => pick.label && d.label === pick.label)?.deviceId ?? pick.id;
}

const resolve = (pick: MicPick) => (pick.id ? findDevice(pick, inputs) : defaultId); // the input a mic pick means

const openId = (pick: MicPick) => (pick.id ? resolve(pick) : ''); // '' lets the browser follow the system default
const connected = (pick: MicPick) => !pick.id || inputs.some((d) => d.deviceId === resolve(pick));

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
      if (!slot.stream && picks[mic] && connected(picks[mic])) (open as Capture | Speaker).reattach(mic, openId(picks[mic]));
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

function chooseMic(mic: number, id: string) {
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
      (el.querySelector('.mute') as HTMLButtonElement).addEventListener('click', () => toggleMute(mic));
      if (multiMic()) {
        el.dataset.mic = String(mic + 1);
        (el.querySelector('.who') as HTMLElement).textContent = micName(mic);
      }
      root.append(el);
    });
  }
  renderLevels();
}

const levelEls = (mic: number) => [els.levels, els.settingsLevels].map((root) => root.children[mic]).filter(Boolean) as HTMLElement[];

function renderLevels() {
  const open = capture ?? speaker;
  used().forEach(({ muted = false }, mic) => {
    const missing = Boolean(open && !open.slots[mic]?.stream);
    const silent = Boolean(open && silentNow(open.slots[mic], mic));
    const name = multiMic() ? micName(mic) : 'the microphone';
    for (const el of levelEls(mic)) {
      const label = el.querySelector('.speaking') as HTMLElement;
      label.textContent = missing ? 'not connected' : muted ? 'muted' : silent ? 'no sound' : speaking.has(mic) ? 'speech' : 'listening';
      label.classList.toggle('on', speaking.has(mic) && !muted);
      label.classList.toggle('off', missing || muted || silent);
      el.classList.toggle('muted', muted);
      const button = el.querySelector('.mute') as HTMLButtonElement;
      button.textContent = muted ? 'Unmute' : 'Mute';
      button.setAttribute('aria-label', `${muted ? 'Unmute' : 'Mute'} ${name}`);
      button.title = muted ? `Unmute ${name}` : `Mute ${name}: silence instead of its sound in the transcript, the saved audio and the speaker`;
      if (missing || !open) (el.querySelector('.meter-fill') as HTMLElement).style.width = '0';
    }
  });
}

/** Mute a mic that misbehaves during a meeting, or unmute it. It stays open, so it is back at once. */
function toggleMute(mic: number) {
  picks[mic].muted = !picks[mic].muted;
  for (const open of [capture, speaker]) open?.mute(mic, picks[mic].muted);
  hush[mic] = null; // silence while muted is not a fault; unmuted, it gets a fresh wait for sound
  devicesChanged();
}

/** Mutes as chosen now, for mics that were still opening when one was muted or unmuted. */
const syncMutes = (open: Capture | Speaker) => open.slots.forEach((_, mic) => open.mute(mic, Boolean(picks[mic]?.muted)));
const mutedMics = () => used().map((pick) => Boolean(pick.muted));

const NO_SIGNAL = 1e-5; // -100 dBFS: digital silence, below any real mic's own noise (lib/crosstalk.ts)
const SILENT_MS = 5000;

/**
 * A mic that is open but has sent only digital silence since it was opened: muted, or on a Mac a second Bluetooth
 * headset, whose mic macOS stops when another Bluetooth headset's mic is in use. Warned about until sound arrives.
 */
function checkSilence(rms: number, mic: number) {
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

const silentNow = (slot: MicSlot | undefined, mic: number) => Boolean(slot?.stream && hush[mic]?.stream === slot.stream && (hush[mic] as Hush).silent);

function showLevel(rms: number, mic: number) {
  checkSilence(rms, mic);
  // Map roughly -60..0 dBFS onto 0..100 %.
  const pct = Math.max(0, Math.min(100, ((20 * Math.log10(rms + 1e-9) + 60) / 60) * 100));
  for (const el of levelEls(mic)) (el.querySelector('.meter-fill') as HTMLElement).style.width = `${pct}%`;
}

function showLevels(buffer: ArrayBuffer) {
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

const isBluetooth = (mic: number) => /bluetooth|airpods/i.test(picks[mic]?.label ?? '');

function silentNote(name: string, mic: number) {
  const note = `${name} sends no sound. Check that it is not muted.`;
  const otherBluetooth = used().some((_, other) => other !== mic && isBluetooth(other));
  if (!isBluetooth(mic) || !otherBluetooth) return note;
  return `${note} A computer often takes sound from only one Bluetooth headset mic at a time (a Mac always does): connect one of them through its USB receiver or a cable instead.`;
}

/** Mics or the speaker missing, or mics recording at a low rate, as a warning; the rest goes on without them. */
function devicesChanged() {
  renderLevels();
  const notes: string[] = [];
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
  } catch (err: any) {
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
  } catch (err: any) {
    showError(`Could not switch microphone: ${err.message}`);
    stop();
  }
}

async function keepAwake(on: boolean) {
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

function setSpeaking(mic: number, on: boolean) {
  if (on) speaking.add(mic);
  else speaking.delete(mic);
  renderLevels();
  publish();
}

// ---------- speaker ----------

// Both only while a speaker is picked.
const speakerId = () => ((speakerPick as SpeakerPick).id ? findDevice(speakerPick as SpeakerPick, outputs) : ''); // the output the pick means
const speakerConnected = () => !(speakerPick as SpeakerPick).id || outputs.some((d) => d.deviceId === speakerId());
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

function chooseSpeaker(id: string) {
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
    } catch (err: any) {
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
  if (speakerPick) speakerPick.label = outputs.find((d) => d.deviceId === (speakerPick as SpeakerPick).id)?.label || speakerPick.label;
  renderSpeakerField();
  // Gone: stop at once, rather than let the sound fall back to the laptop's own speakers.
  if (speaker && (!speakerConnected() || speaker.sinkId !== speakerId())) restartSpeaker();
  else if (speakerPick && !speaker && !speakerOpening && speakerConnected()) restartSpeaker();
}

// ---------- transcript ----------

function fmtTime(sec: number = 0) {
  const s = Math.floor(sec);
  const hh = Math.floor(s / 3600);
  const mmss = `${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return hh ? `${hh}:${mmss}` : mmss;
}

function nearBottom() {
  const t = els.transcript;
  return t.scrollHeight - t.scrollTop - t.clientHeight < 80;
}

function upsertLine(key: number, { text, start, end, mic = 0, model, ms }: { text: string, start?: number, end?: number, mic?: number, model?: string, ms?: number }, final: boolean) {
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
      (el.querySelector('.who') as HTMLElement).textContent = micName(mic);
    }
    // Where the line goes depends on when its sentence started: known from its first message, and it never changes.
    line = { el, connection: Math.floor(key / 1e6), id: key % 1e6, text, start: start as number, mic, labeled, final: false }; // every message that makes a line has a start
    lines.set(key, line);
    live.add(key);
    place(key, line);
  }
  if (line.final && !final) return;
  const finished = final && !line.final;
  Object.assign(line, { text, start, end, final });
  line.el.classList.toggle('partial', !final);
  (line.el.querySelector('time') as HTMLElement).textContent = fmtTime(start);
  (line.el.querySelector('.text') as HTMLElement).textContent = text;
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
 * Put a new line in speaking order (order.ts): a live guess for a newer sentence can arrive before the older one's,
 * and the rest of a sentence cut for being too long starts before a sentence another mic started meanwhile (#50).
 */
function place(key: number, line: Line) {
  const { el } = line;
  let i = order.length;
  while (i > 0 && spokenOrder(line, lines.get(order[i - 1]) as Line) < 0) i--; // the newest lines are last: a step or two
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
function startsAfter(list: Line[], time: number) {
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
function markOverlap(key: number) {
  const line = lines.get(key) as FinalLine; // just made final
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
      (a.el.querySelector('.who') as HTMLElement).title = `Spoken at the same time as ${listMics(a.with)}`;
    }
  }
  list.splice(startsAfter(list, line.start), 0, line);
  spoken.longest = Math.max(spoken.longest, line.end - line.start);
}

function removeLine(key: number) {
  const line = lines.get(key);
  if (!line) return; // the final of a click or cough that never had a live guess
  const block = line.el.parentNode as HTMLElement; // every line sits in a block
  line.el.remove();
  if (!block.firstChild) block.remove();
  lines.delete(key);
  order.splice(order.lastIndexOf(key), 1);
  live.delete(key);
  const indexed = line.final ? spoken.lines.lastIndexOf(line as FinalLine) : -1; // the server never takes a final line back; in case
  if (indexed >= 0) spoken.lines.splice(indexed, 1);
  els.empty.hidden = lines.size > 0;
  render();
}

/** The final lines in order, for Copy and Download (this looks at every line, so not on every message). */
function finalLines() {
  return (order.map((key) => lines.get(key)) as Line[]).filter((l) => l.final);
}

const lineText = (l: Line) => (l.labeled ? `${micName(l.mic)}: ${l.text}` : l.text);

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

/** What the projector view needs: recent final sentences, the ones being spoken, and the mic state. */
function snapshot(): StageSnapshot {
  const row = (key: number): CaptionRow => {
    const l = lines.get(key) as Line; // every key in order and live is a line
    return { key, text: l.text, mic: l.labeled ? l.mic : null };
  };
  // From the end of the transcript back: only the newest lines are looked at.
  const finals: CaptionRow[] = [];
  for (let i = order.length - 1; i >= 0 && finals.length < SHOWN; i--) if ((lines.get(order[i]) as Line).final) finals.unshift(row(order[i]));
  // The sentence being spoken on each mic: two when people talk at the same time.
  const newest: Map<number, number> = new Map(); // mic -> key
  for (const key of live) {
    const { mic } = lines.get(key) as Line;
    if (!((newest.get(mic) as number) > key)) newest.set(mic, key); // no entry yet: undefined compares false, as wanted
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
function modelOptionLabel(m: ModelInfo) {
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
  if (downloading && engine.state !== 'loading') text = `Downloading ${downloading.label}… ${Math.floor((downloading.progress as number) * 100)}%`;
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

function showError(message: string) {
  els.error.textContent = message;
  els.error.hidden = false;
}

/** The model is slower than the talk: lines still come, in order, but late. 0 clears the warning. */
function showBehind(seconds: number) {
  const delay = seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
  els.behind.textContent = `Transcription is ${delay} behind; a faster model would keep up`;
  els.behind.hidden = !seconds;
}

function hideError() {
  els.error.hidden = true;
}

function flash(button: HTMLElement, label: string) {
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
    channel.onmessage = ({ data }: MessageEvent<CaptionMessage>) => {
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
    if (e.key === 'p' && !stage.open && !e.metaKey && !e.ctrlKey && !(e.target as Element).closest('input, select, textarea')) showProjector();
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
  const empty: StageSnapshot = { finals: [], partials: [], recording: false, speaking: false };
  stage = createStage($('stage'));
  stage.show({ fullscreen: false }); // full screen needs a click or key press in this window: F or double-click
  stage.update({ ...empty, waiting: true });
  if (!('BroadcastChannel' in window)) return;
  channel = new BroadcastChannel(CHANNEL);
  const id = Math.random().toString(36).slice(2); // the main window sends captions while any caption window is open
  const hello = () => channel?.postMessage({ type: 'hello', id });
  channel.onmessage = (e: MessageEvent<CaptionMessage>) => {
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
