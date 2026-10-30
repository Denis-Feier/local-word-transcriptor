// Desktop app (Electron): runs the transcription server in the background and shows its page in a window.
// Users install a .dmg / .exe and never see a terminal. From source: npm run app
import { app, BrowserWindow, Menu, dialog, screen, session, shell, systemPreferences, utilityProcess } from 'electron';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = '127.0.0.1';
const TEST = process.env.LT_TEST === '1'; // automated checks: no microphone prompt, window stays hidden

if (!app.requestSingleInstanceLock()) app.quit(); // a second launch just focuses the first window

// Packaged: models and settings in the app's data folder, transcripts in Documents where people find them.
// From source: the repository's folders, shared with `npm start`.
const userData = app.getPath('userData');
const paths = app.isPackaged
  ? {
      models: path.join(userData, 'models'),
      settings: path.join(userData, 'settings.json'),
      transcripts: path.join(app.getPath('documents'), 'Live Transcriber'),
      logs: path.join(userData, 'logs'),
    }
  : {
      models: path.join(ROOT, 'models'),
      settings: path.join(ROOT, '.settings.json'),
      transcripts: path.join(ROOT, 'transcripts'),
      logs: path.join(userData, 'logs'),
    };

let server = null;
let mainWindow = null;
let quitting = false;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, HOST, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startServer() {
  const port = await freePort();
  fs.mkdirSync(paths.logs, { recursive: true });
  const log = fs.createWriteStream(path.join(paths.logs, 'server.log'), { flags: 'a' });
  log.write(`\n--- ${new Date().toISOString()} Live Transcriber ${app.getVersion()} ---\n`);

  server = utilityProcess.fork(path.join(ROOT, 'server.js'), [], {
    stdio: 'pipe',
    serviceName: 'Live Transcriber server',
    env: {
      ...process.env,
      HOST,
      PORT: String(port),
      MODELS_DIR: process.env.MODELS_DIR ?? paths.models,
      SETTINGS_FILE: process.env.SETTINGS_FILE ?? paths.settings,
      TRANSCRIPTS_DIR: process.env.TRANSCRIPTS_DIR ?? paths.transcripts,
      AUTO_INSTALL: '1', // first run downloads the default model with a progress bar in the page
    },
  });
  server.stdout.pipe(log);
  server.stderr.pipe(log);
  server.on('exit', (code) => {
    server = null;
    if (!quitting) {
      dialog.showErrorBox('Live Transcriber stopped', `The transcription engine stopped unexpectedly (code ${code}).\nDetails: ${path.join(paths.logs, 'server.log')}`);
      app.quit();
    }
  });

  const url = `http://${HOST}:${port}`;
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(url)).ok) return url;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('The transcription engine did not start. See the log in ' + paths.logs);
}

/** The caption-only window goes to the projector (any display other than the main window's), full screen. */
function openCaptionWindow(url) {
  const here = screen.getDisplayMatching(mainWindow.getBounds());
  const target = screen.getAllDisplays().find((d) => d.id !== here.id);
  const area = (target ?? here).workArea;
  const win = new BrowserWindow({
    x: area.x + 40,
    y: area.y + 40,
    width: Math.min(1280, area.width - 80),
    height: Math.min(720, area.height - 80),
    title: 'Captions',
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.loadURL(url);
  if (target) win.once('ready-to-show', () => win.setFullScreen(true));
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 840,
    minWidth: 720,
    minHeight: 560,
    title: 'Live Transcriber',
    backgroundColor: '#141412',
    show: false,
    // Keep capturing at full speed when the window is minimised or behind the caption window.
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith(url) && target.includes('display')) openCaptionWindow(target);
    else if (/^https?:/.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  mainWindow.once('ready-to-show', () => !TEST && mainWindow.show());
  mainWindow.on('closed', () => (mainWindow = null));
  mainWindow.loadURL(url);
}

function buildMenu() {
  const openFolder = (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
  };
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open transcripts folder', click: () => openFolder(paths.transcripts) },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }],
    },
    { role: 'windowMenu' },
    {
      label: 'Help',
      submenu: [
        { label: 'Open logs folder', click: () => openFolder(paths.logs) },
        { label: 'Open models folder', click: () => openFolder(process.env.MODELS_DIR ?? paths.models) },
        { type: 'separator' },
        { label: 'Developer tools', role: 'toggleDevTools' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  // Only our own local page may use the microphone; macOS asks the user once.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) =>
    callback(['media', 'fullscreen', 'clipboard-sanitized-write'].includes(permission)));
  session.defaultSession.setPermissionCheckHandler((wc, permission) => ['media', 'fullscreen'].includes(permission));
  if (process.platform === 'darwin' && !TEST) await systemPreferences.askForMediaAccess('microphone').catch(() => false);

  buildMenu();
  try {
    createWindow(await startServer());
  } catch (err) {
    dialog.showErrorBox('Live Transcriber could not start', err.message);
    app.quit();
  }
});

app.on('window-all-closed', () => app.quit());

// Ask the server to finish the sentence being spoken and stop its model, then quit.
app.on('before-quit', (event) => {
  if (!server || quitting) return;
  quitting = true;
  event.preventDefault();
  const done = () => app.exit(0);
  server.once('exit', done);
  server.postMessage('shutdown');
  setTimeout(() => {
    server?.kill();
    done();
  }, 10000);
});
