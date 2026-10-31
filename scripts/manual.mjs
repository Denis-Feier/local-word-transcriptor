// Builds the user manual in docs/manual/: screenshots of the page, then one PDF per language from
// manual.<lang>.html. The page runs against its own server with the UI test's fake microphones
// (test/ui/preload.cjs) and the synthetic test voices, so it never touches a real microphone, the saved settings
// or the transcripts. Kept up to date by the user-manual skill (.claude/skills/user-manual/SKILL.md).
//
//   npm run manual                  screenshots, then the PDFs
//   npm run manual -- --pdf-only    only the PDFs, from the screenshots already there (e.g. a new version number)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron'; // in Node this is the path to the Electron binary
import { ROOT, FIXTURE, startServer, speakers, loadWav, saveWav, scratch, silence, concat, sleep } from '../test/helpers.js';

const DIR = path.join(ROOT, 'docs', 'manual');
const IMG = path.join(DIR, 'img');
const LANGS = ['en', 'ro'];
const MODEL = 'canary-1b-v2'; // the desktop app's default, so the screenshots show what users see
const pdfName = (lang) => `Live-Transcriber-Manual-${lang.toUpperCase()}.pdf`;
const log = (line, fd = 1) => fs.writeSync(fd, `${line}\n`); // console output still buffered is lost at app.exit()

// Device names as a user might see them; ids and voices are the preload's (mic-a is behind "System default").
const DEVICES = {
  devices: [
    { deviceId: 'mic-a', label: 'Built-in Microphone', groupId: 'g-a', audio: 'a' },
    { deviceId: 'mic-b', label: 'Wireless Mic', groupId: 'g-b', audio: 'b' },
    { deviceId: 'mic-c', label: 'USB Microphone', groupId: 'g-c', audio: 'c' },
    { deviceId: 'out-laptop', kind: 'audiooutput', label: 'Built-in Speakers', groupId: 'g-ol' },
    { deviceId: 'out-bt', kind: 'audiooutput', label: 'Room Speaker', groupId: 'g-ob' },
  ],
  present: ['mic-a', 'mic-b', 'mic-c', 'out-laptop', 'out-bt'],
  rates: {},
};

if (typeof electron === 'string') {
  const env = { ...process.env, NODE_BIN: process.execPath };
  delete env.ELECTRON_RUN_AS_NODE; // set inside VS Code's terminal; it would turn Electron into plain Node
  spawn(electron, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit', env }).on('exit', (code) => process.exit(code ?? 1));
} else {
  const { app } = electron;
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.commandLine.appendSwitch('force-device-scale-factor', '2'); // sharp in print
  app.on('window-all-closed', () => {}); // keep running between the screenshots and the PDFs
  app.whenReady().then(async () => {
    try {
      if (!process.argv.includes('--pdf-only')) await screenshots();
      await pdfs();
    } catch (err) {
      log(err.stack, 2);
      process.exitCode = 1;
    }
    app.exit(process.exitCode ?? 0);
  });
}

async function screenshots() {
  const { BrowserWindow, session, nativeTheme } = electron;
  if (!fs.existsSync(path.join(ROOT, 'models', 'canary-1b-v2-Q8_0.gguf'))) throw new Error(`the screenshots need ${MODEL}: npm run setup`);
  session.defaultSession.setPermissionRequestHandler((wc, p, cb) => cb(true));
  session.defaultSession.setPermissionCheckHandler(() => true);
  nativeTheme.themeSource = 'light'; // prints better than the dark theme
  fs.mkdirSync(IMG, { recursive: true });

  // The fake mics read their voices (all three must exist) from here on every page load, so a shot can change them
  // before opening.
  const voices = scratch('manual-voices');
  const { A, B } = speakers();
  const voice = (file, samples) => saveWav(path.join(voices, `${file}.wav`), samples);
  voice('a', loadWav(FIXTURE));
  voice('b', B);
  voice('c', A);
  const server = await startServer({ model: MODEL });
  const width = 1200; // the desktop window's size
  const win = new BrowserWindow({
    width,
    height: 540, // short, so the transcript has little empty space
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'test', 'ui', 'preload.cjs'),
      contextIsolation: false,
      sandbox: false,
      backgroundThrottling: false,
      additionalArguments: [`--ui-speakers=${voices}`],
    },
  });
  const js = (code) => win.webContents.executeJavaScript(code);
  const until = async (code, ms = 40000) => {
    const t0 = Date.now();
    while (!(await js(code))) {
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${code}`);
      await sleep(150);
    }
  };
  const open = async () => {
    await win.loadURL(server.url);
    await js(`localStorage.clear(); sessionStorage.clear(); sessionStorage.setItem('__fake', ${JSON.stringify(JSON.stringify(DEVICES))})`);
    await win.loadURL(server.url);
    await until(`document.getElementById('status').dataset.state === 'ready' && document.querySelectorAll('#mics select').length > 1`);
    // The projector view asks for real full screen, which would take over this computer's display.
    await js(`document.documentElement.requestFullscreen = () => Promise.reject(new Error('not in the manual')); true`);
    await sleep(300);
  };
  const choose = (sel, value) => js(`(() => { const s = document.querySelector(${JSON.stringify(sel)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); })()`);
  const click = (id) => js(`document.getElementById('${id}').click()`);
  const finals = (mic) => `document.querySelectorAll('#transcript .line:not(.partial)${mic ? `[data-mic="${mic}"]` : ''}').length`;
  const live = `document.querySelector('#transcript .line.partial')`;
  // Numbered markers on the controls the manual's list explains: [selector, number, dx, dy from the top-left corner].
  const badges = (marks) => js(`(() => {
    for (const [sel, n, dx = -11, dy = -11] of ${JSON.stringify(marks)}) {
      const r = document.querySelector(sel).getBoundingClientRect();
      const b = document.createElement('span');
      b.textContent = n;
      b.style.cssText = 'position:fixed;z-index:9999;width:22px;height:22px;border-radius:50%;background:#7c3aed;color:#fff;'
        + 'font:700 13px/22px system-ui,sans-serif;text-align:center;box-shadow:0 0 0 2px #fff;'
        + 'top:' + (r.top + dy) + 'px;left:' + (r.left + dx) + 'px';
      document.body.append(b);
    }
  })()`);
  /** Saves a PNG of the window, or of the area around the elements matching sel (pad px of margin). */
  const shot = async (name, sel, pad = 14) => {
    // A page change shows in a capture only after the next paint.
    await js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    await sleep(150);
    const rect = sel
      ? await js(`(() => {
          const rs = [...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.getBoundingClientRect());
          const x = Math.max(0, Math.min(...rs.map((r) => r.left)) - ${pad}), y = Math.max(0, Math.min(...rs.map((r) => r.top)) - ${pad});
          const right = Math.min(innerWidth, Math.max(...rs.map((r) => r.right)) + ${pad}), bottom = Math.min(innerHeight, Math.max(...rs.map((r) => r.bottom)) + ${pad});
          return { x: Math.floor(x), y: Math.floor(y), width: Math.ceil(right - x), height: Math.ceil(bottom - y) };
        })()`)
      : undefined;
    const image = await win.webContents.capturePage(rect);
    fs.writeFileSync(path.join(IMG, `${name}.png`), image.toPNG());
    log(`  img/${name}.png`);
  };
  const page = '.bar, .controls, .settings, .transcript'; // everything but the footer with the transcript's path

  try {
    // One mic, a recording as people see it: final lines, a live line, every control numbered.
    await open();
    await click('toggle');
    await until(`${finals()} >= 2 && ${live}`);
    await badges([['#toggle', 1], ['#levels', 2, -4, -24], ['#projector', 3], ['#openSettings', 4], ['#copy', 5], ['#model', 6], ['#mics', 7],
      ['#speaker', 8], ['label:has(#noise)', 9, -14, -19], ['label:has(#saveAudio)', 10, -14, -19], ['#status', 11, -30, -2]]);
    await shot('main', page);
    await click('toggle');

    // Two people taking turns, one mic each.
    voice('a', A);
    voice('b', concat(silence(7.5), B));
    await open();
    await choose('#mics .field:last-child select', 'mic-b');
    await click('toggle');
    await until(`${finals(1)} >= 1 && ${finals(2)} >= 2 && !${live}`);
    await shot('two-mics', page);

    // The same lines as captions.
    await js(`document.documentElement.style.overflow = 'hidden'`); // no page scrollbar behind the captions
    win.setContentSize(width, 675); // 16:9, like a projector
    await click('projector');
    await sleep(500);
    await js(`document.getElementById('stage').dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))`);
    await shot('projector');
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); document.documentElement.style.overflow = ''`);
    win.setContentSize(width, 540);
    await click('toggle');

    // Settings with two mics, so Mic separation is active: the window grows to show the whole drawer.
    await click('openSettings');
    await js('document.activeElement.blur()');
    const tall = await js(`document.getElementById('settings').scrollHeight`);
    win.setContentSize(width, tall);
    await sleep(500);
    await shot('settings', '#settings .drawer-head, #settings section:first-of-type');
    await click('settingsClose');
    win.setContentSize(width, 540);

    // A speaker chosen before Start: the volume slider appears and the meter moves for a sound check.
    voice('a', loadWav(FIXTURE));
    await open();
    await choose('#speaker', 'out-bt');
    await until(`parseFloat(document.querySelector('#levels .meter-fill').style.width) > 5`, 8000);
    await shot('speaker', '.controls, .settings');
  } finally {
    win.destroy();
    await server.stop();
    fs.rmSync(voices, { recursive: true, force: true });
  }
}

async function pdfs() {
  const { BrowserWindow } = electron;
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const date = new Date().toISOString().slice(0, 10);
  const win = new BrowserWindow({ show: false });
  for (const lang of LANGS) {
    await win.loadFile(path.join(DIR, `manual.${lang}.html`));
    await win.webContents.executeJavaScript(`(() => {
      document.querySelectorAll('[data-version]').forEach((e) => (e.textContent = ${JSON.stringify(version)}));
      document.querySelectorAll('[data-date]').forEach((e) => (e.textContent = ${JSON.stringify(date)}));
    })()`);
    const pdf = await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { top: 0.6, bottom: 0.7, left: 0.7, right: 0.7 },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `<div style="width:100%;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:8px;color:#888;text-align:center">Live Transcriber ${version} · <span class="pageNumber"></span> / <span class="totalPages"></span></div>`,
      generateDocumentOutline: true,
      generateTaggedPDF: true,
    });
    fs.writeFileSync(path.join(DIR, pdfName(lang)), pdf);
    log(`  ${pdfName(lang)} (${Math.round(pdf.length / 1024)} KB)`);
  }
  win.destroy();
  // STATIC-05 compares this with package.json, so a new version cannot ship with an old manual.
  fs.writeFileSync(path.join(DIR, 'manual.json'), `${JSON.stringify({ version, date }, null, 2)}\n`);
}
