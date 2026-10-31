// Loaded into the page by test/ui/run.mjs: fake microphones that play the test speakers instead of a real mic.
// The test changes window.__fake to plug mics in and out, re-pair one under a new id, or make one record at
// 8 kHz. Clipboard writes and downloads are captured instead of performed.
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => {
  const dir = process.argv.find((a) => a.startsWith('--ui-speakers=')).slice('--ui-speakers='.length);
  const buf = fs.readFileSync(path.join(dir, file));
  const pcm = new Int16Array(buf.buffer.slice(buf.byteOffset + 44, buf.byteOffset + buf.byteLength));
  return Float32Array.from(pcm, (s) => s / 32768);
};
const AUDIO = { a: read('a.wav'), b: read('b.wav'), c: read('c.wav') };
const saved = (() => { try { return JSON.parse(sessionStorage.getItem('__fake')); } catch { return null; } })();
window.__fake = saved ?? {
  devices: [
    { deviceId: 'mic-a', label: 'Built-in Microphone', groupId: 'g-a', audio: 'a' },
    { deviceId: 'mic-b', label: 'AirPods', groupId: 'g-b', audio: 'b' },
    { deviceId: 'mic-c', label: 'USB Microphone', groupId: 'g-c', audio: 'c' },
  ],
  present: ['mic-a', 'mic-b', 'mic-c'],
  rates: {},
};
window.__fake.tracks = {};
window.__fake.persist = () => sessionStorage.setItem('__fake', JSON.stringify({ ...window.__fake, tracks: undefined }));
window.__clipboard = null;
window.__download = null;

const md = navigator.mediaDevices;
md.enumerateDevices = async () => {
  const f = window.__fake;
  const list = f.devices.filter((d) => f.present.includes(d.deviceId));
  const def = list[0] && { deviceId: 'default', kind: 'audioinput', label: `Default - ${list[0].label}`, groupId: list[0].groupId };
  return [def, ...list].filter(Boolean).map((d) => ({ deviceId: d.deviceId, kind: 'audioinput', label: d.label, groupId: d.groupId }));
};
md.getUserMedia = async ({ audio }) => {
  const f = window.__fake;
  const id = audio.deviceId?.exact ?? f.present[0];
  const dev = f.devices.find((d) => d.deviceId === id);
  if (!dev || !f.present.includes(id)) throw Object.assign(new Error('Requested device not found'), { name: 'NotFoundError' });
  const ctx = new AudioContext({ sampleRate: 16000 });
  const buffer = ctx.createBuffer(1, AUDIO[dev.audio].length, 16000);
  buffer.copyToChannel(AUDIO[dev.audio], 0);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const dest = ctx.createMediaStreamDestination();
  src.connect(dest);
  src.start();
  const [track] = dest.stream.getAudioTracks();
  const settings = track.getSettings.bind(track);
  track.getSettings = () => ({ ...settings(), sampleRate: f.rates[id] ?? 48000 });
  f.tracks[id] = track;
  return dest.stream;
};
navigator.clipboard.writeText = async (text) => (window.__clipboard = text);
const createObjectURL = URL.createObjectURL;
URL.createObjectURL = (blob) => {
  blob.text().then((t) => (window.__download = t));
  return createObjectURL(blob);
};
HTMLAnchorElement.prototype.click = function () {}; // don't actually save files
