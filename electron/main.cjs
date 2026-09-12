const { app, BrowserWindow, Menu, screen } = require('electron');
const path = require('node:path');

function createWindow() {
  const area = screen.getPrimaryDisplay().workAreaSize;
  const window = new BrowserWindow({
    width: Math.min(1280, area.width),
    height: Math.min(860, area.height),
    minWidth: 940,
    minHeight: 580,
    backgroundColor: '#0d1221',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  Menu.setApplicationMenu(null);
  window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  const window = BrowserWindow.getAllWindows()[0];
  if (window) { if (window.isMinimized()) window.restore(); window.focus(); }
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

