// Runs the test plan (TESTING.md) and writes a report to test-results/<date>_<commit>/.
//
//   npm test                       standard tier (~5 min): static, unit, protocol, smoke, scenarios, ui
//   npm run test:quick             quick tier (~1 min): static, unit, protocol
//   npm run test:full              full tier (~15 min): standard + every engine + 10-minute conversation
//   node test/run-all.js --only ui            one suite: static, unit, protocol, smoke, scenarios, ui, engines, long
//   node test/run-all.js full --recordings transcripts/a.wav,transcripts/b.wav   also real voices (stay local)
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT } from './helpers.js';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const tier = ['quick', 'standard', 'full'].find((x) => args.includes(x)) ?? 'standard';
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const recordings = args.includes('--recordings') ? args[args.indexOf('--recordings') + 1] : null;
const git = (cmd) => {
  try {
    return execSync(`git ${cmd}`, { cwd: ROOT }).toString().trim();
  } catch {
    return '?';
  }
};
const sha = git('rev-parse --short HEAD');
const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
const OUT = path.join(ROOT, 'test-results', `${stamp}_${sha}`);
fs.mkdirSync(OUT, { recursive: true });
const results = []; // { suite, cases: [{ id, title, status, detail }] , seconds, code }

// One engine per runtime, for the full tier.
const ENGINES = ['canary-1b-v2', 'whisper-large-v3-turbo', 'parakeet-tdt-0.6b-v3', 'jackrabbit-110m-ro'];

function run(name, cmd, cmdArgs, { minutes, env = {} } = {}) {
  return new Promise((resolve) => {
    const resultFile = path.join(OUT, `${name}.json`);
    const log = fs.createWriteStream(path.join(OUT, `${name}.log`));
    const childEnv = { ...process.env, TEST_RESULT: resultFile, ...env };
    delete childEnv.ELECTRON_RUN_AS_NODE; // set inside VS Code's terminal; it would turn Electron into plain Node
    const t0 = Date.now();
    const child = spawn(cmd, cmdArgs, { cwd: ROOT, env: childEnv });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    let pending = ''; // output arrives in chunks that can split a line
    child.stdout.on('data', (d) => {
      const lines = (pending + d).split('\n');
      pending = lines.pop();
      for (const l of lines) if (/^[✔✖◌–]/.test(l)) process.stdout.write(`  ${l}\n`);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), minutes * 60000);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      const seconds = Math.round((Date.now() - t0) / 1000);
      let cases = [];
      try {
        cases = JSON.parse(fs.readFileSync(resultFile, 'utf8')).cases;
      } catch {
        // smoke.js reports by exit code only; a crashed suite reports nothing
      }
      if (!cases.length || (code !== 0 && !cases.some((c) => c.status === 'fail'))) {
        const ok = code === 0;
        cases.push({ id: `${name.toUpperCase()}-RUN`, title: `${name} ran to the end`, status: ok ? 'pass' : 'fail', detail: ok ? '' : `exit ${code ?? signal}${signal === 'SIGKILL' ? ` (timed out after ${minutes} min)` : ''}; see ${name}.log` });
        console.log(`  ${ok ? '✔' : '✖'} ${name} ${ok ? 'passed' : `failed (exit ${code ?? signal})`}`);
      }
      results.push({ suite: name, cases, seconds, code });
      resolve();
    });
  });
}

// ---------- static checks: no server, no model ----------
function staticChecks() {
  const cases = [];
  const check = (id, title, ok, detail = '') => {
    cases.push({ id, title, status: ok ? 'pass' : 'fail', detail });
    console.log(`  ${ok ? '✔' : '✖'} ${id} ${title}${detail ? ` — ${detail}` : ''}`);
  };
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk(rel);
      else if (/\.(c|m)?js$/.test(e.name)) files.push(rel);
    }
  };
  for (const dir of ['lib', 'public', 'scripts', 'desktop', 'test']) walk(dir);
  files.push('server.js');
  const broken = files.filter((f) => {
    try {
      execSync(`"${process.execPath}" --check "${path.join(ROOT, f)}"`, { stdio: 'pipe' });
      return false;
    } catch {
      return true;
    }
  });
  check('STATIC-01', 'every JavaScript file parses', broken.length === 0, broken.join(', ') || `${files.length} files`);

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const packaged = pkg.build.files;
  check('STATIC-02', 'the installers include server.js, lib/ and public/', ['server.js', 'lib/**', 'public/**', 'desktop/main.mjs'].every((p) => packaged.includes(p)), packaged.join(' '));

  // The server serves only the page files it lists; a new one left out breaks the page without an error.
  const served = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const unserved = fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f !== 'index.html' && !served.includes(`'/${f}': ['${f}'`));
  check('STATIC-04', 'the server serves every file in public/', unserved.length === 0, unserved.join(', ') || 'all listed in server.js');

  // The plan and the tests must agree: every test id in the code is described in TESTING.md, and every
  // automated id in TESTING.md exists in the code.
  const plan = fs.readFileSync(path.join(ROOT, 'TESTING.md'), 'utf8');
  const ID = /\b(?:STATIC|UNIT|PROT|SMOKE|SCN|KNOWN|UI)-[A-Z0-9]+(?:-[0-9]+)?\b/g;
  const inCode = new Set(files.filter((f) => f.startsWith('test')).flatMap((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').match(ID) ?? []));
  for (const c of cases) inCode.add(c.id);
  const planRows = plan.split('\n').filter((l) => /^\| `?[A-Z]+-[A-Z0-9-]+`? \|/.test(l));
  const automated = new Set(planRows.filter((l) => /\| auto \|/.test(l)).map((l) => l.match(ID)?.[0]).filter(Boolean));
  const described = new Set(planRows.map((l) => l.match(ID)?.[0]).filter(Boolean));
  const undocumented = [...inCode].filter((id) => !described.has(id) && !id.endsWith('-RUN'));
  const missing = [...automated].filter((id) => !inCode.has(id) && !/^SMOKE-/.test(id));
  check('STATIC-03', 'TESTING.md lists every test in the code, and every automated test in it exists', !undocumented.length && !missing.length,
    [undocumented.length && `not in TESTING.md: ${undocumented.join(', ')}`, missing.length && `in TESTING.md but not in the code: ${missing.join(', ')}`].filter(Boolean).join('; '));
  results.push({ suite: 'static', cases, seconds: 0, code: cases.some((c) => c.status === 'fail') ? 1 : 0 });
}

// ---------- the tiers ----------
const node = process.execPath;
const electron = require('electron'); // in Node this is the path to the Electron binary
const plan = [
  ['static', 'quick', () => staticChecks()],
  ['unit', 'quick', () => run('unit', node, ['test/unit.js'], { minutes: 3 })],
  ['protocol', 'quick', () => run('protocol', node, ['test/protocol.js'], { minutes: 8 })],
  ['smoke', 'standard', () => run('smoke', node, ['test/smoke.js'], { minutes: 15, env: { SMOKE_MODELS_DIR: process.env.SMOKE_MODELS_DIR ?? path.join(ROOT, 'models') } })],
  ['scenarios', 'standard', () => run('scenarios', node, ['test/scenarios.js'], { minutes: 15 })],
  ['ui', 'standard', () => run('ui', electron, ['test/ui/run.mjs'], { minutes: 10, env: { NODE_BIN: node, UI_OUT: path.join(OUT, 'screenshots') } })],
  ['engines', 'full', async () => {
    const { MODELS, isInstalled, isAvailable } = await import('../lib/models.js');
    for (const id of ENGINES) {
      const m = MODELS.find((x) => x.id === id);
      if (!m || !isAvailable(m) || !isInstalled(m)) {
        results.push({ suite: `scenarios-${id}`, cases: [{ id: 'SCN-ENGINE', title: `two-mic scenarios on ${id}`, status: 'skip', detail: 'not installed or not runnable here' }], seconds: 0, code: 0 });
        console.log(`  – scenarios on ${id} — skipped: not installed or not runnable here`);
        continue;
      }
      await run(`scenarios-${id}`, node, ['test/scenarios.js', '--model', id], { minutes: 30 });
    }
  }],
  ['long', 'full', () => run('long', node, ['test/scenarios.js', '--long', '--only', 'SCN-07'], { minutes: 20 })],
  ['recordings', 'full', () => (recordings ? run('recordings', node, ['test/scenarios.js', '--recordings', recordings], { minutes: 20 }) : null)],
];
const rank = { quick: 0, standard: 1, full: 2 };
const t0 = Date.now();
for (const [name, level, step] of plan) {
  if (only ? name !== only : rank[level] > rank[tier]) continue;
  console.log(`\n▸ ${name}`);
  await step();
}

// ---------- report ----------
const all = results.flatMap((r) => r.cases.map((c) => ({ ...c, suite: r.suite })));
const count = (s) => all.filter((c) => c.status === s).length;
const dirty = git('status --porcelain') ? ' (uncommitted changes)' : '';
const lines = [
  `# Test run ${stamp}`,
  '',
  `- Commit: \`${sha}\` on \`${git('rev-parse --abbrev-ref HEAD')}\`${dirty}`,
  `- Tier: ${only ? `only ${only}` : tier}${recordings ? ' + real recordings' : ''}`,
  `- Machine: ${os.type()} ${os.release()} ${os.arch()}, Node ${process.version}, ${os.cpus()[0]?.model ?? ''}`,
  `- Time: ${Math.round((Date.now() - t0) / 60000)} min`,
  `- Result: **${count('fail') ? 'FAIL' : 'PASS'}** — ${count('pass')} passed, ${count('fail')} failed, ${count('known')} known limits, ${count('skip')} skipped`,
  '',
  '| Suite | Id | Test | Result | Detail |',
  '|---|---|---|---|---|',
  ...all.map((c) => `| ${c.suite} | ${c.id} | ${c.title} | ${{ pass: '✔', fail: '✖ FAIL', known: '◌ known', skip: '– skip' }[c.status]} | ${String(c.detail ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 200)} |`),
  '',
  `Logs and screenshots: \`${path.relative(ROOT, OUT)}/\``,
];
fs.writeFileSync(path.join(OUT, 'summary.md'), `${lines.join('\n')}\n`);
console.log(`\n${count('fail') ? '✖ FAIL' : '✔ PASS'}: ${count('pass')} passed, ${count('fail')} failed, ${count('known')} known limits, ${count('skip')} skipped`);
console.log(`report: ${path.relative(ROOT, path.join(OUT, 'summary.md'))}`);
process.exit(count('fail') ? 1 : 0);
