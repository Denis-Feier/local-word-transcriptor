// Downloads models into models/, where they stay for offline use.
//   npm run setup                  voice detector + the default model (Canary 1B v2)
//   npm run setup -- <model-id>    another model (or several, space separated)
//   npm run setup -- --all         every model (~10 GB, plus ~1.4 GB of Python for Jackrabbit)
//   npm run setup -- --list        show all models and which are downloaded
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { config, MODELS_DIR, ROOT } from '../lib/config.js';
import { MODELS, SILERO_VAD, findModel, isInstalled, installModel, modelPath, download } from '../lib/models.js';
import fs from 'node:fs';

const args = process.argv.slice(2);

if (args.includes('--list')) {
  console.log('');
  for (const m of MODELS) {
    console.log(`  ${isInstalled(m) ? '✔' : ' '} ${m.id.padEnd(30)} ${m.size.padEnd(8)} ${m.notes}`);
  }
  console.log('\n  Download one with: npm run setup -- <id>\n');
  process.exit(0);
}

const progressBar = (label) => {
  let last = -1;
  return (fraction) => {
    const pct = Math.floor(fraction * 100);
    if (pct !== last) {
      last = pct;
      process.stdout.write(`\r  ↓ ${label}  ${pct}%`);
    }
  };
};

// 1. whisper.cpp (only needed for the Whisper models)
const probe = spawnSync('which', [config.whisper.bin], { encoding: 'utf8' });
if (probe.status === 0) console.log(`✔ whisper-server found: ${probe.stdout.trim()}`);
else console.log('! whisper-server not found; only needed for the Whisper models. Install: brew install whisper-cpp');
const uv = spawnSync('which', [process.env.UV_BIN ?? 'uv'], { encoding: 'utf8' });
if (uv.status === 0) console.log(`✔ uv found (sets up Python for Jackrabbit): ${uv.stdout.trim()}`);
else console.log('! uv not found; only needed for Jackrabbit (Python). Install: brew install uv');

// 2. voice activity detector
const vadPath = path.join(MODELS_DIR, SILERO_VAD.file);
if (!fs.existsSync(vadPath)) {
  await download(SILERO_VAD.url, vadPath, progressBar(SILERO_VAD.label));
  console.log('');
}
console.log(`✔ ${SILERO_VAD.label}`);

// 3. speech models
const named = args.filter((a) => !a.startsWith('--'));
const ids = args.includes('--all') ? MODELS.map((m) => m.id) : named.length ? named : [config.defaultModel];
for (const id of ids) {
  const model = findModel(id);
  if (!model) {
    console.error(`✖ Unknown model "${id}". See: npm run setup -- --list`);
    process.exitCode = 1;
    continue;
  }
  if (!isInstalled(model)) {
    if (model.python) console.log(`  ${model.label} also installs Python 3.12 + PyTorch + NeMo into python/.venv (~1.4 GB, a few minutes).`);
    try {
      await installModel(model, progressBar(`${model.label} (${model.size})`));
      console.log('');
    } catch (err) {
      console.error(`\n✖ ${model.label}: ${err.message}`);
      process.exitCode = 1;
      continue;
    }
  }
  console.log(`✔ ${model.label}: ${path.relative(ROOT, modelPath(model))}`);
}

if (!process.exitCode) console.log(`\nReady. Run: npm start   and open http://localhost:${config.port}\n`);
