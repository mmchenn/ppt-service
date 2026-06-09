// electron.mjs — PPT Service Electron 外壳
//
// 功能:
//   - 系统托盘（右下角图标）
//   - 窗口管理（最小化到托盘）
//   - 自动崩溃恢复（服务器挂了自动重启）
//   - 开机自启支持
//   - 包装 server.mjs 作为子进程

import { app, BrowserWindow, Tray, Menu, Notification, ipcMain, dialog, shell, nativeImage } from 'electron';
import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { fileURLToPath } from 'url';
import net from 'net';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = __dirname;
const SERVER_SCRIPT = path.join(ROOT_DIR, 'server.mjs');
const ICON_PATH = path.join(ROOT_DIR, 'assets/icon.png');
const SETTINGS_FILE = path.join(ROOT_DIR, 'settings.json');

// ===== 状态 =====
let mainWindow = null;
let tray = null;
let serverProcess = null;
let isQuitting = false;
let serverPort = 3456;
let crashCount = 0;
let restartTimer = null;

function getSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE))
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
  } catch (e) { /* ignore */ }
  return {};
}

// ===== 查找可用端口 =====
function findFreePort(start) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(start, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', () => resolve(findFreePort(start + 1)));
  });
}

// ===== 启动后端服务器 =====
async function startServer() {
  if (serverProcess) return;

  const settings = getSettings();
  const port = settings.port || 3456;
  serverPort = await findFreePort(port);

  sendToWindow('log', { type: 'info', msg: `启动后端服务 (端口 ${serverPort})...` });

  serverProcess = spawn('node', [SERVER_SCRIPT, `--port=${serverPort}`, '--silent'], {
    cwd: ROOT_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
    windowsHide: true,  // 隐藏控制台窗口！
  });

  serverProcess.stdout.on('data', (data) => {
    const text = data.toString().trim();
    if (text) sendToWindow('log', { type: 'server', msg: text });
  });

  serverProcess.stderr.on('data', (data) => {
    const text = data.toString().trim();
    if (text) sendToWindow('log', { type: 'error', msg: text });
  });

  serverProcess.on('close', (code) => {
    sendToWindow('log', { type: 'warn', msg: `后端已退出 (code=${code})` });
    serverProcess = null;
    updateTrayMenu();

    // ===== 崩溃自愈：自动重启 =====
    if (!isQuitting && code !== 0) {
      crashCount++;
      const delay = Math.min(crashCount * 2000, 30000); // 递增等待: 2s, 4s, 6s... 最大30s
      sendToWindow('log', { type: 'warn', msg: `⏳ ${delay/1000}秒后自动重启 (崩溃 #${crashCount})` });
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        sendToWindow('log', { type: 'info', msg: '🔄 正在自动重启...' });
        startServer();
      }, delay);
    } else {
      crashCount = 0;
    }
  });

  serverProcess.on('error', (err) => {
    sendToWindow('log', { type: 'error', msg: `后端启动失败: ${err.message}` });
    serverProcess = null;
  });

  // 等待就绪
  await waitForServer(serverPort, 15000);
  crashCount = 0;
  updateTrayMenu();
}

function waitForServer(port, timeout) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => { resolve(true); });
      });
      req.on('error', () => {
        if (Date.now() - start < timeout) setTimeout(check, 500);
        else resolve(false);
      });
      req.end();
    };
    check();
  });
}

function stopServer() {
  if (!serverProcess) return;
  clearTimeout(restartTimer);
  try {
    if (process.platform === 'win32')
      execSync(`taskkill /PID ${serverProcess.pid} /T /F`, { stdio: 'ignore' });
    else
      serverProcess.kill('SIGTERM');
  } catch (e) { serverProcess.kill(); }
  serverProcess = null;
  updateTrayMenu();
}

// ===== IPC 发送 =====
function sendToWindow(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send(channel, data);
}

// ===== 系统托盘 =====
function createTray() {
  let img;
  if (fs.existsSync(ICON_PATH)) {
    img = nativeImage.createFromPath(ICON_PATH);
  } else {
    const buf = Buffer.alloc(32 * 32 * 4, 0);
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 32; x++) {
        const i = (y * 32 + x) * 4;
        const cx = x - 16, cy = y - 16;
        if (Math.sqrt(cx*cx + cy*cy) < 14) { buf[i] = 34; buf[i+1] = 197; buf[i+2] = 94; buf[i+3] = 255; }
      }
    img = nativeImage.createFromBuffer(buf, { width: 32, height: 32 });
  }
  tray = new Tray(img);
  tray.setToolTip('PPT 智能生成服务');
  tray.on('double-click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  const running = serverProcess !== null;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `🟢 ${running ? `运行中 :${serverPort}` : '已停止'}`, enabled: false },
    { type: 'separator' },
    { label: '📊 打开控制台', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { label: `🌐 浏览器打开 (http://localhost:${serverPort})`, click: () => { shell.openExternal(`http://localhost:${serverPort}`); } },
    { type: 'separator' },
    { label: '❌ 退出', click: () => { isQuitting = true; stopServer(); app.quit(); } },
  ]));
}

// ===== 主窗口 =====
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100, height: 800, minWidth: 800, minHeight: 600,
    title: 'PPT 智能生成 · 桌面版',
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'dashboard.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // 自动启动后端
    startServer();
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      if (Notification.isSupported())
        new Notification({ title: 'PPT Service 仍在运行', body: '双击托盘图标打开控制台 | 右键托盘可退出' });
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ===== IPC =====
function setupIpc() {
  ipcMain.handle('get-settings', () => getSettings());

  ipcMain.handle('save-settings', (e, s) => {
    const existing = getSettings();
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...existing, ...s }, null, 2));
    return true;
  });

  ipcMain.handle('open-folder', (e, p) => { if (p && fs.existsSync(p)) shell.openPath(p); });

  ipcMain.handle('select-directory', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
}

// ===== 启动 =====
app.whenReady().then(() => {
  setupIpc();
  createTray();
  createWindow();

  app.on('activate', () => { if (mainWindow) mainWindow.show(); else createWindow(); });
});

app.on('before-quit', () => { isQuitting = true; stopServer(); });
app.on('window-all-closed', () => {});
