import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from './config.js';

const VENV = path.join(ROOT, 'python', '.venv');
export const PYTHON_BIN = path.join(VENV, 'bin', 'python');
const REQUIREMENTS = path.join(ROOT, 'python', 'requirements.txt');

export const pythonReady = () => fs.existsSync(PYTHON_BIN);

function uv(args, log) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.UV_BIN ?? 'uv', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => log(d.toString()));
    child.stderr.on('data', (d) => log(d.toString()));
    child.on('error', (err) => reject(err.code === 'ENOENT' ? new Error('uv is not installed. Install it with: brew install uv') : err));
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`uv ${args[0]} failed (exit ${code})`))));
  });
}

/** Create python/.venv (Python 3.12 + PyTorch + NeMo) the first time a Python model is installed. */
export async function ensurePythonEnv(log = () => {}) {
  if (pythonReady()) return;
  await uv(['venv', VENV, '--python', '3.12'], log);
  await uv(['pip', 'install', '--python', PYTHON_BIN, '-r', REQUIREMENTS], log);
}
