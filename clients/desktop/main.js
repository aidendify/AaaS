// Window onto a hosted AgentSphere. The address is stored on this PC and can be changed.
const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

function configFile() { return path.join(app.getPath('userData'), 'server.json'); }
function readUrl() {
  try {
    const u = JSON.parse(fs.readFileSync(configFile(), 'utf8')).url;
    if (/^https?:\/\//i.test(u)) return String(u).replace(/\/+$/, '');
  } catch { /* first run */ }
  return '';
}
function writeUrl(url) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify({ url }));
}

let mainWin = null;

function openApp(url) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.close();
  mainWin = new BrowserWindow({
    width: 1280,
    height: 840,
    title: 'AgentSphere',
    autoHideMenuBar: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  mainWin.loadURL(url);
}

function askAddress(current) {
  const win = new BrowserWindow({
    width: 520,
    height: 320,
    resizable: false,
    title: 'AgentSphere server',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>AgentSphere</title></head>
<body style="font-family:Segoe UI,sans-serif;margin:28px;color:#111">
<h1 style="font-size:18px;margin:0 0 8px">Where is AgentSphere running?</h1>
<p style="margin:0 0 12px;color:#444">This app is a window onto the hosted site. Use a VPS address, or http://localhost:3000 while you test.</p>
<input id="u" style="width:100%;box-sizing:border-box;padding:10px;font-size:15px" value="" placeholder="https://your-server.example">
<p id="err" style="color:#b00020;min-height:1.2em"></p>
<button id="go" style="padding:8px 16px;font-size:15px">Continue</button>
<script>
  document.getElementById('u').value = ${JSON.stringify(current || '')};
  document.getElementById('go').onclick = () => {
    const v = document.getElementById('u').value.trim().replace(/\\/+$/, '');
    if (!/^https?:\\/\\//i.test(v)) { document.getElementById('err').textContent = 'Start with http:// or https://'; return; }
    window.desk.save(v);
  };
  document.getElementById('u').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('go').click(); });
</script></body></html>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  return new Promise((resolve) => {
    const onSave = (_e, url) => { resolve(String(url || '')); if (!win.isDestroyed()) win.close(); };
    ipcMain.once('save-url', onSave);
    win.on('closed', () => { ipcMain.removeListener('save-url', onSave); resolve(''); });
  });
}

function menu() {
  const template = [
    {
      label: 'Server',
      submenu: [
        { label: 'Change server address', click: () => askAddress(readUrl()).then((u) => { if (u) { writeUrl(u); openApp(u); } }) },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'quit' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  menu();
  let url = readUrl();
  if (!url) {
    url = await askAddress('');
    if (!url) { app.quit(); return; }
    writeUrl(url);
  }
  openApp(url);
});

app.on('window-all-closed', () => app.quit());
