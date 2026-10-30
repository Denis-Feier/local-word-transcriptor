// Streams a 16 kHz mono WAV file to the running server in real time, exactly like the browser does,
// and prints partial and final transcripts.
//
//   npm start                                   (in another terminal)
//   npm run test:wav -- path/to/file.wav [--speed 2] [--model parakeet-tdt-0.6b-v3] [--expect word]
//
// Two mics, as the page sends them: --mic2 other.wav (or --mic2 silence) streams a second mic alongside.
//   --bleed 15     each mic also hears the other mic's speaker, 15 dB quieter (people sharing a room)
//   --lag 150      mic 2's audio arrives 150 ms late, as a Bluetooth mic's does
//   --gain2 12     mic 2 is 12 dB louder overall (mics differ in volume)
//   --only-mic 1   fail if any sentence is attributed to another mic (e.g. mic 2 only hears bleed)
//
// Make a Romanian test file on macOS:
//   say -v Ioana -o /tmp/ro.aiff "Bună ziua, ce mai faceți?"
//   afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/ro.aiff /tmp/ro.wav
import fs from 'node:fs';
import WebSocket from 'ws';
import { decodeWav } from '../lib/wav.js';

const args = process.argv.slice(2);
const file = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const speedIdx = args.indexOf('--speed');
const speed = speedIdx >= 0 ? Number(args[speedIdx + 1]) : 1;
const modelIdx = args.indexOf('--model');
const model = modelIdx >= 0 ? args[modelIdx + 1] : null;
const expectIdx = args.indexOf('--expect');
const expected = expectIdx >= 0 ? args[expectIdx + 1].toLowerCase() : null; // exit 1 unless the transcript contains it
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const mic2 = option('--mic2', null);
const bleedDb = Number(option('--bleed', Infinity));
const lagMs = Number(option('--lag', 0));
const gain2 = 10 ** (Number(option('--gain2', 0)) / 20);
const onlyMic = option('--only-mic', null);
const url = process.env.WS_URL ?? `ws://localhost:${process.env.PORT ?? 3000}/ws${mic2 ? '?mics' : ''}`;

if (!file) {
  console.error('Usage: npm run test:wav -- <file.wav> [--speed N]');
  process.exit(1);
}

function load(path) {
  const { sampleRate, samples } = decodeWav(fs.readFileSync(path));
  if (sampleRate !== 16000) {
    console.error(`Expected 16 kHz audio, got ${sampleRate} Hz. Convert with: afconvert -f WAVE -d LEI16@16000 -c 1 in.wav out.wav`);
    process.exit(1);
  }
  return samples;
}

const CHUNK = 1600; // 100 ms
const samples = load(file);
const second = mic2 === 'silence' ? new Float32Array(samples.length) : mic2 ? load(mic2) : null;
const lag = Math.round((lagMs / 1000) * 16000);
const length = Math.max(samples.length, second?.length ?? 0) + lag + 16000 * 1.5; // trailing pause so the last sentence ends naturally
// One mic: the file as is. Two: each mic gets its speaker, the other speaker's bleed and a little room noise.
const gain = 10 ** (-bleedDb / 20);
const noise = () => (Math.random() * 2 - 1) * 0.002; // about -60 dBFS
const mics = second
  ? [[samples, second, 0, 1], [second, samples, lag, gain2]].map(([own, other, delay, volume]) => {
    const out = new Float32Array(length);
    for (let i = 0; i < length - delay; i++) out[i + delay] = volume * ((own[i] ?? 0) + gain * (other[i] ?? 0) + noise());
    return out;
  })
  : [Float32Array.from({ length }, (_, i) => samples[i] ?? 0)];

const ws = new WebSocket(url);
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(2).padStart(6)}s`;
let streaming = false;
let outstanding = new Set();
let doneSending = false;
const finals = [];

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'models' && model && msg.active !== model) {
    ws.send(JSON.stringify({ type: 'select', id: model }));
  } else if (msg.type === 'status') {
    console.log(`${elapsed()} status: ${msg.state} – ${msg.message}`);
    if (msg.state === 'ready' && !streaming && (!model || msg.model === model)) stream();
    if (msg.state === 'error') process.exit(1);
  } else if (msg.type === 'vad' && msg.speaking) {
    outstanding.add(msg.id);
  } else if (msg.type === 'partial') {
    console.log(`${elapsed()}   … #${msg.id}${second ? ` mic ${msg.mic + 1}` : ''} ${msg.text}`);
  } else if (msg.type === 'final') {
    outstanding.delete(msg.id);
    if (msg.text) {
      finals.push(msg);
      const who = second ? ` mic ${msg.mic + 1}` : '';
      console.log(`${elapsed()} ✔ #${msg.id}${who} [${msg.start.toFixed(1)}–${msg.end.toFixed(1)}s] (${msg.ms} ms) ${msg.text}`);
    }
    if (doneSending && outstanding.size === 0) finish();
  } else if (msg.type === 'error') {
    console.error(`${elapsed()} error: ${msg.message}`);
  }
});

ws.on('error', (err) => {
  console.error(`Cannot connect to ${url}: ${err.message}. Is "npm start" running?`);
  process.exit(1);
});

function stream() {
  streaming = true;
  console.log(`${elapsed()} streaming ${(length / 16000).toFixed(1)} s of audio${second ? ' from 2 mics' : ''} at ${speed}x`);
  let offset = 0;
  const timer = setInterval(() => {
    if (offset >= length) {
      clearInterval(timer);
      ws.send(JSON.stringify({ type: 'flush' }));
      doneSending = true;
      if (outstanding.size === 0) setTimeout(finish, 3000);
      return;
    }
    if (second) {
      // The page's framing: a Uint32 mic count, then each mic's samples in turn.
      const n = Math.min(CHUNK, length - offset);
      const frame = new Float32Array(1 + 2 * n);
      new Uint32Array(frame.buffer, 0, 1)[0] = 2;
      mics.forEach((m, i) => frame.set(m.subarray(offset, offset + n), 1 + i * n));
      ws.send(frame.buffer);
    } else {
      ws.send(mics[0].slice(offset, offset + CHUNK).buffer);
    }
    offset += CHUNK;
  }, 100 / speed);
}

function finish() {
  const transcript = finals.map((f) => (second ? `Mic ${f.mic + 1}: ${f.text}` : f.text)).join('\n');
  console.log(`\n--- transcript ---\n${transcript}\n`);
  ws.close();
  const strays = onlyMic ? finals.filter((f) => f.mic + 1 !== Number(onlyMic)) : [];
  if (strays.length) {
    console.error(`✖ expected every sentence on mic ${onlyMic}; ${strays.length} came from another mic`);
    process.exit(1);
  }
  if (expected && !transcript.toLowerCase().includes(expected)) {
    console.error(`✖ expected the transcript to contain "${expected}"`);
    process.exit(1);
  }
  process.exit(0);
}
