// The page in Chromium (Electron, the same engine as the desktop app), driven like a person would, with fake
// microphones that play the test speakers (preload.cjs). Starts its own servers. Screenshots go to UI_OUT
// (default: a temp folder, printed at the end) for a person or an AI to look at.
//
//   npm run test:ui          (or: npx electron test/ui/run.mjs; needs ELECTRON_RUN_AS_NODE unset)
import { app, BrowserWindow, session, nativeTheme } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, SR, FIXTURE, startServer, speakers, loadWav, saveWav, scratch, sleep, suite } from '../helpers.js';

const OUT = process.env.UI_OUT ?? scratch('ui');
fs.mkdirSync(OUT, { recursive: true });
const SPEAKERS = scratch('ui-speakers');
const { A, B } = speakers();
saveWav(path.join(SPEAKERS, 'a.wav'), A);
saveWav(path.join(SPEAKERS, 'b.wav'), B);
saveWav(path.join(SPEAKERS, 'c.wav'), loadWav(FIXTURE).subarray(Math.round(13.4 * SR))); // a third voice: the last sentence
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const t = suite('ui');

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((wc, p, cb) => cb(true));
  session.defaultSession.setPermissionCheckHandler(() => true);
  const servers = [];
  const serve = async (opts) => {
    const s = await startServer(opts);
    servers.push(s);
    return s;
  };
  let server = await serve();
  const scratchDirs = [];
  const pageErrors = [];
  const newWindow = (width = 1100, height = 900) => {
    const w = new BrowserWindow({
      width,
      height,
      show: false,
      // contextIsolation off so the preload can replace the page's microphone APIs. The desktop app runs the same
      // page isolated and sandboxed; the page itself needs neither Node nor the preload.
      webPreferences: { preload: path.join(ROOT, 'test', 'ui', 'preload.cjs'), contextIsolation: false, sandbox: false, additionalArguments: [`--ui-speakers=${SPEAKERS}`] },
    });
    w.webContents.on('console-message', (e) => e.level === 'error' && pageErrors.push(e.message));
    return w;
  };
  const win = newWindow();
  const js = (code, w = win) => w.webContents.executeJavaScript(code);
  const shot = async (name, w = win) => fs.writeFileSync(path.join(OUT, `${name}.png`), (await w.webContents.capturePage()).toPNG());
  const state = (w = win) => js(`(() => ({
    fields: [...document.querySelectorAll('#mics .field')].map((f) => ({ name: f.querySelector('span').textContent, value: f.querySelector('select').value, text: f.querySelector('select').selectedOptions[0]?.text, options: [...f.querySelector('select').options].map((o) => o.value + (o.disabled ? ':off' : '')), dot: f.dataset.mic ?? null })),
    levels: [...document.querySelectorAll('#levels .level')].map((l) => ({ who: l.querySelector('.who').textContent, state: l.querySelector('.speaking').textContent, width: parseFloat(l.querySelector('.meter-fill').style.width) || 0 })),
    lines: [...document.querySelectorAll('#transcript .line')].map((l) => ({ mic: l.dataset.mic ?? null, who: l.querySelector('.who').textContent, text: l.querySelector('.text').textContent, partial: l.classList.contains('partial'), overlap: l.classList.contains('overlap'), color: getComputedStyle(l.querySelector('.text')).color })),
    error: document.getElementById('error').hidden ? '' : document.getElementById('error').textContent,
    recording: document.getElementById('toggleText').textContent === 'Stop',
    status: document.getElementById('status').dataset.state,
    models: [...document.getElementById('model').options].map((o) => o.text),
    copyDisabled: document.getElementById('copy').disabled,
    separation: document.getElementById('tune-crosstalkDb')?.disabled,
    file: document.getElementById('file').textContent,
    maxMics: document.querySelectorAll('#mics select').length,
  }))()`, w);
  const waitFor = async (cond, ms = 15000, w = win) => {
    const t0 = Date.now();
    for (;;) {
      const s = await state(w);
      if (cond(s) || Date.now() - t0 > ms) return s;
      await sleep(200);
    }
  };
  const pick = (slot, value) => js(`(() => { const s = document.querySelectorAll('#mics select')[${slot}]; s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); })()`);
  const unplug = (id) => js(`(() => { const f = window.__fake; f.present = f.present.filter((x) => x !== '${id}'); const t = f.tracks['${id}']; if (t && t.readyState === 'live') { t.stop(); t.dispatchEvent(new Event('ended')); } navigator.mediaDevices.dispatchEvent(new Event('devicechange')); })()`);
  const plug = (id) => js(`(() => { const f = window.__fake; if (!f.present.includes('${id}')) f.present.push('${id}'); navigator.mediaDevices.dispatchEvent(new Event('devicechange')); })()`);
  const click = (id) => js(`document.getElementById('${id}').click()`);
  const key = (k) => js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)} }))`);
  const open = async (s = server, w = win) => {
    await w.loadURL(`http://127.0.0.1:${s.port}/`);
    await js('localStorage.clear(); sessionStorage.clear()', w);
    await w.loadURL(`http://127.0.0.1:${s.port}/`);
    // Ready, and the mic menus built from the server's mic limit (sent right after the status).
    return waitFor((x) => x.status === 'ready' && x.maxMics >= 1, 10000, w).then(() => sleep(300)).then(() => state(w));
  };
  const finals = (s) => s.lines.filter((l) => !l.partial);

  try {
    // ---------- one mic: the page as before ----------
    let s = await open();
    t.check('UI-LOAD-01', 'the page loads ready, with the model menu filled', s.status === 'ready' && s.models.length >= 1, `${s.models.length} models`);
    t.check('UI-MIC-01', 'Mic 1 and Mic 2 menus; Mic 2 starts as None; one unlabeled meter',
      s.fields.length === 2 && s.fields[0].name === 'Mic 1' && s.fields[1].value === 'none' && s.levels.length === 1 && !s.levels[0].who, s.fields.map((f) => `${f.name}=${f.text}`).join(', '));
    t.check('UI-MIC-02', 'the mic behind "System default" (Mic 1) is greyed out in Mic 2', s.fields[1].options.includes('mic-a:off') && s.fields[1].options.includes('mic-b'), s.fields[1].options.join(' '));
    await click('toggle');
    s = await waitFor((x) => finals(x).length >= 1);
    t.check('UI-1MIC-01', 'one mic: text appears without mic labels or colours', finals(s).length >= 1 && finals(s).every((l) => !l.mic && !l.who), finals(s).map((l) => l.text.slice(0, 30)).join(' | '));
    await click('toggle');
    await sleep(800);
    await click('copy');
    await sleep(200);
    t.check('UI-1MIC-02', 'one mic: Copy gives plain lines', !/^Mic \d: /m.test(await js('window.__clipboard ?? ""')) && (await js('window.__clipboard ?? ""')).length > 10);
    await click('clear');
    s = await state();
    t.check('UI-TX-01', 'Clear empties the transcript and disables Copy', s.lines.length === 0 && s.copyDisabled && !s.file);

    // ---------- two mics ----------
    await pick(1, 'mic-b');
    s = await state();
    t.check('UI-MIC-03', 'choosing Mic 2: coloured dots, two labelled meters, the separation slider is enabled',
      s.fields[0].dot === '1' && s.fields[1].dot === '2' && s.levels.map((l) => l.who).join() === 'Mic 1,Mic 2' && s.separation === false);
    await click('toggle');
    s = await waitFor((x) => x.levels.every((l) => l.width > 0), 5000);
    t.check('UI-MIC-04', 'both meters move while recording', s.levels.every((l) => l.width > 0), s.levels.map((l) => `${l.who} ${l.width.toFixed(0)}%`).join(', '));
    s = await waitFor((x) => x.lines.some((l) => l.partial && l.mic === '1') && x.lines.some((l) => l.partial && l.mic === '2'), 6000);
    t.check('UI-TX-02', 'live text from both mics at once, each in its mic colour',
      s.lines.some((l) => l.partial && l.mic === '1') && s.lines.some((l) => l.partial && l.mic === '2') && new Set(s.lines.filter((l) => l.partial).map((l) => l.color)).size === 2);
    await shot('two-mics-live');
    s = await waitFor((x) => finals(x).length >= 3 && !x.lines.some((l) => l.partial), 20000);
    t.check('UI-TX-03', 'final lines say which mic heard them and are coloured per mic',
      finals(s).every((l) => l.who === `Mic ${l.mic}`) && new Set(finals(s).map((l) => l.mic)).size === 2, finals(s).map((l) => `${l.who}: ${l.text.slice(0, 20)}`).join(' | '));
    t.check('UI-TX-04', 'lines spoken at the same time are marked ⇄', finals(s).filter((l) => l.overlap).length >= 2);
    await shot('two-mics-final');
    await click('toggle');
    await sleep(800);
    await click('copy');
    await click('download');
    await sleep(300);
    const clip = await js('window.__clipboard ?? ""');
    const down = await js('window.__download ?? ""');
    t.check('UI-TX-05', 'Copy has "Mic N:" lines; Download has "[mm:ss] Mic N:" lines',
      clip.split('\n').every((l) => /^Mic [12]: /.test(l)) && down.trim().split('\n').every((l) => /^\[\d\d:\d\d\] Mic [12]: /.test(l)), JSON.stringify(down.slice(0, 70)));

    // ---------- projector and caption window ----------
    const captions = newWindow(1000, 600);
    await captions.loadURL(`http://127.0.0.1:${server.port}/?display`);
    await sleep(600);
    const cap = await js(`[...document.querySelectorAll('.stage-line')].map((l) => (l.dataset.mic ?? '-') + ':' + l.textContent.slice(0, 12))`, captions);
    t.check('UI-PROJ-01', 'the caption window shows the lines in their mic colours', cap.some((c) => c.startsWith('1:')) && cap.some((c) => c.startsWith('2:')), cap.join(' | '));
    await shot('caption-window', captions);
    captions.destroy();
    await click('projector');
    await sleep(500);
    const stage = () => js(`({ hidden: document.getElementById('stage').hidden, theme: document.getElementById('stage').dataset.theme, size: getComputedStyle(document.getElementById('stage')).getPropertyValue('--stage-size').trim(), lines: document.querySelector('[data-action="lines"]').textContent, mics: [...document.querySelectorAll('.stage-line')].map((l) => l.dataset.mic ?? '-') })`);
    const p0 = await stage();
    await key('t');
    await key('+');
    await key('l');
    const p1 = await stage();
    t.check('UI-PROJ-02', 'projector: coloured lines; T changes colours, + text size, L number of sentences',
      !p0.hidden && p0.mics.includes('1') && p0.mics.includes('2') && p1.theme !== p0.theme && p1.size !== p0.size && p1.lines !== p0.lines, `${p0.theme}→${p1.theme}, ${p0.size}→${p1.size}, ${p0.lines}→${p1.lines}`);
    await shot('projector');
    await key('Escape');
    await sleep(300);
    t.check('UI-PROJ-03', 'Esc leaves the projector view', (await stage()).hidden);
    await js(`localStorage.removeItem('stage')`);

    // ---------- settings drawer ----------
    await click('openSettings');
    await sleep(300);
    await js(`(() => { const i = document.getElementById('tune-silenceMs'); i.value = 1500; i.dispatchEvent(new Event('change')); })()`);
    await sleep(400);
    const changed = await js(`({ value: document.getElementById('tune-silenceMs').value, marked: document.getElementById('tune-silenceMs').closest('.setting').classList.contains('changed'), meters: document.querySelectorAll('#settingsLevels .level').length })`);
    await shot('settings');
    await click('tuningReset');
    await sleep(400);
    const reset = await js(`({ value: document.getElementById('tune-silenceMs').value, marked: document.getElementById('tune-silenceMs').closest('.setting').classList.contains('changed') })`);
    t.check('UI-SET-01', 'a slider change is applied and marked; Reset restores it; a meter per mic in Settings',
      changed.value === '1500' && changed.marked && reset.value === '700' && !reset.marked && changed.meters === 2, JSON.stringify({ changed, reset }));
    await click('settingsClose');

    // ---------- mics coming and going ----------
    s = await open();
    await pick(1, 'mic-b');
    await unplug('mic-b');
    await sleep(300);
    s = await state();
    t.check('UI-DEV-01', 'a chosen mic that is off shows "(not connected)"', s.fields[1].text === 'AirPods (not connected)', s.fields[1].text);
    await click('toggle');
    s = await waitFor((x) => x.recording);
    t.check('UI-DEV-02', 'Start works with Mic 2 off: Mic 2 "not connected" plus a warning',
      s.recording && s.levels[1].state === 'not connected' && s.error.includes('Mic 2 (AirPods) is not connected'), s.error);
    await plug('mic-b');
    s = await waitFor((x) => x.levels[1].state !== 'not connected' && !x.error);
    t.check('UI-DEV-03', 'switching it on: it joins the recording and the warning goes', s.levels[1].state !== 'not connected' && !s.error);
    s = await waitFor((x) => finals(x).some((l) => l.mic === '2'), 20000);
    t.check('UI-DEV-04', 'the late mic is transcribed under Mic 2', finals(s).some((l) => l.mic === '2'));
    await unplug('mic-b');
    s = await waitFor((x) => x.levels[1].state === 'not connected');
    t.check('UI-DEV-05', 'unplugged while recording: "not connected", a warning, Mic 1 keeps recording', s.recording && s.levels[1].state === 'not connected' && s.error.includes('not connected'));
    await shot('mic-disconnected');
    await click('toggle');
    await plug('mic-b');

    s = await open();
    await pick(0, 'mic-c');
    await unplug('mic-c');
    await click('toggle');
    s = await waitFor((x) => x.error);
    t.check('UI-DEV-06', 'the only mic missing: a clear message and no recording', !s.recording && s.error.includes('not connected'), s.error);
    await plug('mic-c');

    s = await open();
    await pick(0, 'mic-a');
    await pick(1, 'mic-b');
    await click('toggle');
    await waitFor((x) => x.recording);
    await sleep(1500);
    await pick(1, 'mic-c');
    await sleep(1200);
    s = await state();
    t.check('UI-DEV-07', 'changing Mic 2 while recording keeps recording', s.recording && !s.error && s.levels.length === 2);
    await pick(1, 'none');
    await sleep(1200);
    s = await state();
    t.check('UI-DEV-08', 'Mic 2 set to None while recording: one unlabeled meter, new lines unlabeled', s.recording && s.levels.length === 1 && !s.levels[0].who);
    await click('toggle');

    s = await open();
    await js(`window.__fake.rates['mic-b'] = 8000`);
    await pick(1, 'mic-b');
    await click('toggle');
    s = await waitFor((x) => x.error);
    t.check('UI-DEV-09', 'a mic recording at 8 kHz gets a "less accurate" warning', s.error.includes('8 kHz'), s.error);
    await click('toggle');

    // ---------- remembered choices ----------
    s = await open();
    await pick(0, 'mic-a');
    await pick(1, 'mic-b');
    await win.loadURL(`http://127.0.0.1:${server.port}/`);
    s = await waitFor((x) => x.fields[1]?.value === 'mic-b', 5000);
    t.check('UI-DEV-10', 'mic choices are remembered after a reload', s.fields[0].value === 'mic-a' && s.fields[1].value === 'mic-b');
    await js(`(() => { const d = window.__fake.devices.find((x) => x.deviceId === 'mic-b'); d.deviceId = 'mic-b2'; window.__fake.present = window.__fake.present.map((x) => (x === 'mic-b' ? 'mic-b2' : x)); window.__fake.persist(); })()`);
    await win.loadURL(`http://127.0.0.1:${server.port}/`);
    s = await waitFor((x) => x.fields[1]?.value === 'mic-b2', 5000);
    t.check('UI-DEV-11', 'a re-paired mic (new id, same name) is found again', s.fields[1].value === 'mic-b2' && s.fields[1].text === 'AirPods');
    await js('sessionStorage.clear()');

    // ---------- speaker in the room ----------
    // Each (re)open of the speaker starts the fake mics' clips again (A 6.8 s, B 8.7 s), so levels are read soon after.
    const speakerState = () => js(`(() => {
      const s = document.getElementById('speaker');
      return { value: s.value, text: s.selectedOptions[0]?.text, options: [...s.options].map((o) => o.value), volumeShown: !document.getElementById('speakerVolumeField').hidden,
        volume: document.getElementById('speakerVolume').value, sink: window.__sink && window.__sink.ctx.state !== 'closed' ? window.__sink.id : null,
        mics: window.__mics.filter((m) => m.autoGainControl === false).map((m) => m.id) };
    })()`);
    const pickSpeaker = (value) => js(`(() => { const s = document.getElementById('speaker'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); })()`);
    const setVolume = (value) => js(`(() => { const v = document.getElementById('speakerVolume'); v.value = ${value}; v.dispatchEvent(new Event('input')); v.dispatchEvent(new Event('change')); })()`);
    const loudest = async (ms = 2500) => { // dBFS; -Infinity when nothing plays on the picked output
      let max = -Infinity;
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        max = Math.max(max, (await js('window.__speakerLevel()')) ?? -Infinity);
        await sleep(50);
      }
      return max;
    };
    s = await open();
    let sp = await speakerState();
    t.check('UI-SPK-01', 'Speaker menu: None, System default and each output; it starts at None, without a volume slider, playing nothing',
      sp.value === 'none' && sp.options.join() === 'none,,out-laptop,out-bt' && !sp.volumeShown && !sp.sink, sp.options.join(' '));
    await pickSpeaker('out-bt');
    let level = await loudest();
    sp = await speakerState();
    s = await state();
    t.check('UI-SPK-02', 'choosing a speaker plays the mic on it at once, before Start, asking for no auto gain; the volume slider appears',
      sp.sink === 'out-bt' && level > -50 && !s.recording && sp.volumeShown && sp.mics.join() === 'mic-a', `${level.toFixed(1)} dBFS on ${sp.sink}; speaker mics ${sp.mics.join(' ')}`);
    s = await waitFor((x) => x.levels[0]?.width > 0, 3000);
    t.check('UI-SPK-10', 'the meter moves while only the speaker plays, for a sound check before Start', !s.recording && s.levels[0].width > 0, `${s.levels[0].width.toFixed(0)}%`);
    await shot('speaker');
    await pick(1, 'mic-b');
    await sleep(800);
    sp = await speakerState();
    t.check('UI-SPK-03', 'choosing Mic 2 adds it to the speaker', sp.sink === 'out-bt' && sp.mics.slice(-2).join() === 'mic-a,mic-b', sp.mics.join(' '));
    await click('toggle');
    await waitFor((x) => x.recording);
    await sleep(1000);
    const during = await speakerState();
    await click('toggle');
    await sleep(800);
    level = await loudest();
    sp = await speakerState();
    t.check('UI-SPK-04', 'Start and Stop leave the speaker playing', during.sink === 'out-bt' && sp.sink === 'out-bt' && level > -50, `${level.toFixed(1)} dBFS after Stop`);
    await pickSpeaker('out-laptop');
    await sleep(500);
    const loud = await loudest(1000);
    await setVolume(0);
    await sleep(300);
    const quiet = await loudest(1000);
    sp = await speakerState();
    t.check('UI-SPK-05', 'another output takes over the sound; volume 0 silences it', sp.sink === 'out-laptop' && loud > -50 && quiet < -90, `${loud.toFixed(1)} → ${quiet.toFixed(1)} dBFS`);
    await setVolume(40);
    await win.loadURL(`http://127.0.0.1:${server.port}/`);
    await waitFor((x) => x.status === 'ready', 5000);
    sp = await speakerState();
    t.check('UI-SPK-06', 'after a reload the speaker is back at None and the volume is remembered', sp.value === 'none' && !sp.sink && sp.volume === '40', JSON.stringify({ value: sp.value, volume: sp.volume }));
    await pickSpeaker('out-bt');
    await sleep(500);
    await unplug('out-bt');
    s = await waitFor((x) => x.error.includes('Party Speaker'), 3000);
    await sleep(200);
    sp = await speakerState();
    t.check('UI-SPK-07', 'the speaker switched off: it stops playing (no fallback to the laptop), shows "(not connected)" and a warning',
      !sp.sink && sp.text === 'Party Speaker (not connected)' && s.error.includes('The speaker (Party Speaker) is not connected'), `${sp.text}; ${s.error}`);
    await shot('speaker-disconnected');
    await js(`window.__fake.devices.find((d) => d.deviceId === 'out-bt').deviceId = 'out-bt2'`); // re-paired: a new id
    await plug('out-bt2');
    s = await waitFor((x) => !x.error, 3000);
    level = await loudest();
    sp = await speakerState();
    t.check('UI-SPK-08', 'the speaker back, even under a new id: it plays again and the warning goes', sp.sink === 'out-bt2' && sp.value === 'out-bt2' && level > -50 && !s.error,
      `${level.toFixed(1)} dBFS on ${sp.sink}; ${s.error}`);
    s = await state();
    const moving = s.levels.map((l) => l.width);
    await pickSpeaker('none');
    await sleep(300);
    sp = await speakerState();
    s = await state();
    t.check('UI-SPK-09', 'None stops the speaker, hides the volume and sets the meters back to zero',
      !sp.sink && !sp.volumeShown && sp.value === 'none' && moving.some((w) => w > 0) && s.levels.every((l) => l.width === 0), `meters ${moving.map((w) => w.toFixed(0)).join('/')} → ${s.levels.map((l) => l.width).join('/')} %`);

    // ---------- server restart mid-recording ----------
    s = await open();
    await pick(1, 'mic-b');
    await click('toggle');
    await sleep(4000);
    const port = server.port;
    await server.stop();
    await sleep(2500);
    server = await serve({ env: { PORT: String(port) } });
    s = await waitFor((x) => x.status === 'ready' && finals(x).length >= 2, 30000);
    t.check('UI-NET-01', 'server restarted mid-recording: the page reconnects and transcribes what it recorded meanwhile, on the right mics',
      s.recording && finals(s).length >= 2 && finals(s).every((l) => l.mic), finals(s).map((l) => `${l.who}: ${l.text.slice(0, 20)}`).join(' | '));
    await click('toggle');

    // ---------- look: light mode, phone width ----------
    nativeTheme.themeSource = 'light';
    await sleep(400);
    await shot('light');
    nativeTheme.themeSource = 'system';
    const phone = newWindow(390, 844);
    await open(server, phone);
    await js(`(() => { const s = document.querySelectorAll('#mics select')[1]; s.value = 'mic-b'; s.dispatchEvent(new Event('change')); })()`, phone);
    const width = await js('[document.documentElement.scrollWidth, window.innerWidth]', phone);
    t.check('UI-LOOK-01', 'phone width: nothing scrolls sideways', width[0] <= width[1], `${width[0]} px page in ${width[1]} px`);
    await shot('phone', phone);
    phone.destroy();

    // ---------- other server setups ----------
    const one = await serve({ env: { MAX_MICS: '1' } });
    s = await open(one);
    t.check('UI-CFG-01', 'MAX_MICS=1: a single "Microphone" menu, as before two mics existed', s.fields.length === 1 && s.fields[0].name === 'Microphone');
    const three = await serve({ env: { MAX_MICS: '3' } });
    s = await open(three);
    await pick(1, 'mic-b');
    await pick(2, 'mic-c');
    await click('toggle');
    s = await waitFor((x) => finals(x).some((l) => l.mic === '3'), 20000);
    t.check('UI-CFG-02', 'MAX_MICS=3: a third menu, three mics record, Mic 3 has its own lines', s.levels.length === 3 && finals(s).some((l) => l.mic === '3'));
    await click('toggle');
    const energy = await serve({ env: { VAD: 'energy' } });
    s = await open(energy);
    t.check('UI-CFG-03', 'with the loudness detector the Silero threshold slider is greyed out', await js(`document.getElementById('tune-vadThreshold').disabled`));
    // A models folder with only Parakeet 110M: the other models show their download size and ask first.
    const few = scratch('few-models');
    scratchDirs.push(few);
    for (const f of ['silero_vad.onnx', 'Sped_ParakeetRomanian_110M_TDT-CTC-Q8_0.gguf']) fs.symlinkSync(path.join(ROOT, 'models', f), path.join(few, f));
    const fewServer = await serve({ env: { MODELS_DIR: few } });
    s = await open(fewServer);
    await js(`window.__confirmed = []; window.confirm = (q) => (window.__confirmed.push(q), false); true`);
    await js(`(() => { const m = document.getElementById('model'); m.value = 'orukeet'; m.dispatchEvent(new Event('change')); })()`);
    await sleep(500);
    const asked = await js('window.__confirmed');
    s = await state();
    t.check('UI-MODEL-01', 'a model not downloaded shows its size and asks before downloading; No changes nothing',
      s.models.some((m) => /\(download .+\)/.test(m)) && asked.length === 1 && /Download Orukeet/.test(asked[0]) && s.status === 'ready', asked[0]);

    t.check('UI-LOAD-02', 'no errors in the page console', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  } catch (err) {
    t.check('UI-RUN', 'the UI run finished', false, err.stack);
  } finally {
    for (const s of servers) await s.stop().catch(() => {});
    for (const dir of [SPEAKERS, ...scratchDirs]) fs.rmSync(dir, { recursive: true, force: true });
    console.log(`\nscreenshots: ${OUT}`);
    t.finish();
    app.exit(process.exitCode ?? 0);
  }
});
