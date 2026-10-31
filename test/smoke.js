// End-to-end check that runs on any OS (CI runs it before building the installers): starts the server with
// a fresh models folder, lets it download the small Romanian model by itself, streams test/fixtures/ro.wav
// and requires the expected words in the transcript. Then streams it again as two mics, where the second mic only
// hears the speaker from across the room, and requires every sentence on mic 1.
//
//   node test/smoke.js                          (SMOKE_MODEL=canary-1b-v2 to test another model)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-smoke-'));
const port = await freePort();
const env = {
  ...process.env,
  PORT: String(port),
  MODEL: process.env.SMOKE_MODEL ?? 'parakeet-ro-110m', // 135 MB, so CI downloads stay small
  AUTO_INSTALL: '1',
  MODELS_DIR: process.env.SMOKE_MODELS_DIR ?? path.join(tmp, 'models'),
  SETTINGS_FILE: path.join(tmp, 'settings.json'),
  TRANSCRIPTS_DIR: path.join(tmp, 'transcripts'),
};

const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'inherit', 'inherit'] });
let code = 1;
try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break;
    } catch {
      if (i > 120) throw new Error('server did not start');
      await sleep(250);
    }
  }
  const stream = (args, minutes) => {
    const test = spawn(process.execPath, [path.join(ROOT, 'test', 'stream-wav.js'), path.join(ROOT, 'test', 'fixtures', 'ro.wav'), ...args], { env, stdio: 'inherit' });
    const timer = setTimeout(() => test.kill(), minutes * 60 * 1000);
    return new Promise((resolve) => test.on('exit', (c) => resolve(c ?? 1))).finally(() => clearTimeout(timer));
  };
  code = await stream(['--speed', '3', '--expect', 'munții'], 10); // includes the model download
  // Two mics: the second only hears the speaker from across the room (quieter, late like Bluetooth),
  // so every sentence must stay on mic 1.
  if (code === 0) code = await stream(['--mic2', 'silence', '--bleed', '12', '--lag', '150', '--only-mic', '1', '--speed', '3', '--expect', 'munții'], 2);
} catch (err) {
  console.error(`✖ ${err.message}`);
} finally {
  server.kill();
  await sleep(500);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Windows may still hold the model file for a moment; the OS cleans its temp folder
  }
}
console.log(code === 0 ? '✔ smoke test passed' : '✖ smoke test failed');
process.exit(code);
