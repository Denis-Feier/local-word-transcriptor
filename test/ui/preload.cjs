// Loaded into the page by test/ui/run.mjs: fake microphones that play the test speakers instead of a real mic, and
// fake audio outputs. The test changes window.__fake to plug devices in and out, re-pair one under a new id, or make
// a mic record at 8 kHz. Clipboard writes and downloads are captured instead of performed. Nothing is played out
// loud: an output the page picks is silent, and window.__speakerLevel() measures what it would have played.
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => {
  const dir = process.argv.find((a) => a.startsWith('--ui-speakers=')).slice('--ui-speakers='.length);
  const buf = fs.readFileSync(path.join(dir, file));
  const pcm = new Int16Array(buf.buffer.slice(buf.byteOffset + 44, buf.byteOffset + buf.byteLength));
  return Float32Array.from(pcm, (s) => s / 32768);
};
const AUDIO = { a: read('a.wav'), b: read('b.wav'), c: read('c.wav') };
const LOOP = process.argv.includes('--ui-loop'); // the stress tier's soak: each mic plays its meeting over and over
const saved = (() => { try { return JSON.parse(sessionStorage.getItem('__fake')); } catch { return null; } })();
window.__fake = saved ?? {
  devices: [
    { deviceId: 'mic-a', label: 'Built-in Microphone', groupId: 'g-a', audio: 'a' },
    { deviceId: 'mic-b', label: 'AirPods', groupId: 'g-b', audio: 'b' },
    { deviceId: 'mic-c', label: 'USB Microphone', groupId: 'g-c', audio: 'c' },
    { deviceId: 'out-laptop', kind: 'audiooutput', label: 'MacBook Pro Speakers', groupId: 'g-ol' },
    { deviceId: 'out-bt', kind: 'audiooutput', label: 'Party Speaker', groupId: 'g-ob' },
  ],
  present: ['mic-a', 'mic-b', 'mic-c', 'out-laptop', 'out-bt'],
  rates: {},
};
window.__fake.tracks = {};
window.__fake.persist = () => sessionStorage.setItem('__fake', JSON.stringify({ ...window.__fake, tracks: undefined }));
window.__clipboard = null;
window.__download = null;
window.__mics = []; // every mic the page opened: { id, autoGainControl }
window.__sink = null; // the output the page picked last: { id, ctx }

const kind = (d) => d.kind ?? 'audioinput';

const md = navigator.mediaDevices;
md.enumerateDevices = async () => {
  const f = window.__fake;
  const list = f.devices.filter((d) => f.present.includes(d.deviceId));
  const defaults = ['audioinput', 'audiooutput'].map((k) => list.find((d) => kind(d) === k)).filter(Boolean)
    .map((d) => ({ ...d, deviceId: 'default', label: `Default - ${d.label}` }));
  return [...defaults, ...list].map((d) => ({ deviceId: d.deviceId, kind: kind(d), label: d.label, groupId: d.groupId }));
};
md.getUserMedia = async ({ audio }) => {
  const f = window.__fake;
  const id = audio.deviceId?.exact ?? f.present.find((x) => kind(f.devices.find((d) => d.deviceId === x)) === 'audioinput');
  const dev = f.devices.find((d) => d.deviceId === id);
  if (!dev || kind(dev) !== 'audioinput' || !f.present.includes(id)) throw Object.assign(new Error('Requested device not found'), { name: 'NotFoundError' });
  window.__mics.push({ id, autoGainControl: audio.autoGainControl });
  const ctx = new AudioContext({ sampleRate: 16000 });
  const buffer = ctx.createBuffer(1, AUDIO[dev.audio].length, 16000);
  buffer.copyToChannel(AUDIO[dev.audio], 0);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = LOOP;
  const dest = ctx.createMediaStreamDestination();
  src.connect(dest);
  src.start();
  const [track] = dest.stream.getAudioTracks();
  const settings = track.getSettings.bind(track);
  track.getSettings = () => ({ ...settings(), sampleRate: f.rates[id] ?? 48000 });
  f.tracks[id] = track;
  return dest.stream;
};

// Outputs: the page's choice is recorded and the sound goes nowhere ({ type: 'none' } still runs the audio graph).
// A tap on everything connected to that context's output lets the test measure the level.
const setSinkId = AudioContext.prototype.setSinkId;
AudioContext.prototype.setSinkId = async function (id) {
  const f = window.__fake;
  const dev = f.devices.find((d) => d.deviceId === id);
  if (id && (!dev || kind(dev) !== 'audiooutput' || !f.present.includes(id))) throw Object.assign(new Error('Requested device not found'), { name: 'NotFoundError' });
  await setSinkId.call(this, { type: 'none' });
  this.__tap = this.createAnalyser();
  window.__sink = { id, ctx: this };
};
const connect = AudioNode.prototype.connect;
AudioNode.prototype.connect = function (target, ...rest) {
  if (target instanceof AudioDestinationNode && target.context.__tap) connect.call(this, target.context.__tap);
  return connect.call(this, target, ...rest);
};
/** dBFS of what the picked output plays right now; null when nothing is playing there. */
window.__speakerLevel = () => {
  const sink = window.__sink;
  if (!sink || sink.ctx.state !== 'running') return null;
  const samples = new Float32Array(sink.ctx.__tap.fftSize);
  sink.ctx.__tap.getFloatTimeDomainData(samples);
  return 10 * Math.log10(samples.reduce((sum, x) => sum + x * x, 0) / samples.length + 1e-12);
};

navigator.clipboard.writeText = async (text) => (window.__clipboard = text);
const createObjectURL = URL.createObjectURL;
URL.createObjectURL = (blob) => {
  blob.text().then((t) => (window.__download = t));
  return createObjectURL(blob);
};
HTMLAnchorElement.prototype.click = function () {}; // don't actually save files
