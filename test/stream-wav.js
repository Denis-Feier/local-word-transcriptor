// Streams a 16 kHz mono WAV file to the running server in real time, exactly like the browser does,
// and prints partial and final transcripts.
//
//   npm start                                   (in another terminal)
//   npm run test:wav -- path/to/file.wav [--speed 2] [--model parakeet-tdt-0.6b-v3]
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
const url = process.env.WS_URL ?? `ws://localhost:${process.env.PORT ?? 3000}/ws`;

if (!file) {
  console.error('Usage: npm run test:wav -- <file.wav> [--speed N]');
  process.exit(1);
}

const { sampleRate, samples } = decodeWav(fs.readFileSync(file));
if (sampleRate !== 16000) {
  console.error(`Expected 16 kHz audio, got ${sampleRate} Hz. Convert with: afconvert -f WAVE -d LEI16@16000 -c 1 in.wav out.wav`);
  process.exit(1);
}

const CHUNK = 1600; // 100 ms
const silence = new Float32Array(16000 * 1.5); // trailing pause so the last sentence ends naturally
const audio = new Float32Array(samples.length + silence.length);
audio.set(samples);

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
    console.log(`${elapsed()}   … #${msg.id} ${msg.text}`);
  } else if (msg.type === 'final') {
    outstanding.delete(msg.id);
    if (msg.text) {
      finals.push(msg.text);
      console.log(`${elapsed()} ✔ #${msg.id} [${msg.start.toFixed(1)}–${msg.end.toFixed(1)}s] (${msg.ms} ms) ${msg.text}`);
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
  console.log(`${elapsed()} streaming ${(samples.length / 16000).toFixed(1)} s of audio at ${speed}x`);
  let offset = 0;
  const timer = setInterval(() => {
    if (offset >= audio.length) {
      clearInterval(timer);
      ws.send(JSON.stringify({ type: 'flush' }));
      doneSending = true;
      if (outstanding.size === 0) setTimeout(finish, 3000);
      return;
    }
    ws.send(audio.slice(offset, offset + CHUNK).buffer);
    offset += CHUNK;
  }, 100 / speed);
}

function finish() {
  console.log(`\n--- transcript ---\n${finals.join('\n')}\n`);
  ws.close();
  process.exit(0);
}
