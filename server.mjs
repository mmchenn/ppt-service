// server.mjs — PPT Service 全能后端
// v2.0 — 新增: 订单管理、队列、Edge 正确启动、通知

import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { fileURLToPath } from 'url';
import net from 'net';

// ===== 路径 =====
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = __dirname;
const DASHBOARD_HTML = path.join(ROOT_DIR, 'dashboard.html');
const CDP_SCRIPT = path.join(ROOT_DIR, 'kimi-cdp.mjs');
const ENV_FILE = path.join(ROOT_DIR, '.env');
const SETTINGS_FILE = path.join(ROOT_DIR, 'settings.json');
const ORDERS_FILE = path.join(ROOT_DIR, 'orders.json');
const INDEX_HTML = path.join(ROOT_DIR, 'index.html');

// ===== 配置 =====
const PORT = parseInt(process.argv.find(a => a.startsWith('--port='))?.split('=')[1])
  || parseInt(process.env.PORT) || 3456;
const SILENT = process.argv.includes('--silent');
const TEMP_DIR = process.env.TEMP_DIR
  || path.join(process.env.USERPROFILE || 'C:/Users/Administrator', 'AppData/Local/Temp/ppt-service');

// ===== 日志系统 =====
const MAX_LOGS = 500;
const logBuffer = [];
let sseClients = [];

function log(type, msg) {
  const ts = new Date().toISOString().replace(/T/, ' ').slice(0, 19);
  const entry = { ts, type, msg };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOGS) logBuffer.splice(0, logBuffer.length - MAX_LOGS);
  if (!SILENT) {
    const icons = { info: '📌', success: '✅', error: '❌', warn: '⚠️', cdp: '🤖', server: '🔵', upload: '📤', dl: '💾', mail: '📧', step: '▶️' };
    const icon = icons[type] || '·';
    console.log(`${ts} ${icon} ${msg}`);
  }
  const payload = JSON.stringify(entry);
  sseClients = sseClients.filter(client => {
    try { client.write(`data: ${payload}\n\n`); return true; }
    catch (e) { return false; }
  });
}

// ===== SSE 广播 =====
function broadcastSSE(type, data) {
  const payload = JSON.stringify({ type, ...data });
  sseClients = sseClients.filter(client => {
    try { client.write(`data: ${payload}\n\n`); return true; }
    catch (e) { return false; }
  });
}

// ===== 设置持久化 =====
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE))
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
  } catch (e) { /* ignore */ }
  return {
    port: PORT,
    downloadDir: process.env.DOWNLOAD_DIR || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Desktop/PPT输出') : 'M:/资料'),
    smtpHost: process.env.SMTP_HOST || 'smtp.qq.com',
    smtpPort: parseInt(process.env.SMTP_PORT || '465'),
    smtpUser: process.env.SMTP_USER || '',
    smtpPass: process.env.SMTP_PASS || '',
    resendApiKey: process.env.RESEND_API_KEY || '',
    adminEmail: process.env.ADMIN_EMAIL || '',
  };
}

let settings = loadSettings();

function saveSettings(s) {
  settings = { ...settings, ...s };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  const lines = [
    `RESEND_API_KEY=${settings.resendApiKey || ''}`,
    `DOWNLOAD_DIR=${settings.downloadDir || ''}`,
    `SMTP_HOST=${settings.smtpHost || 'smtp.qq.com'}`,
    `SMTP_PORT=${settings.smtpPort || 465}`,
    `SMTP_USER=${settings.smtpUser || ''}`,
    `SMTP_PASS=${settings.smtpPass || ''}`,
    `ADMIN_EMAIL=${settings.adminEmail || ''}`,
  ];
  try { fs.writeFileSync(ENV_FILE, lines.join('\n')); } catch (e) { /* ignore */ }
}

// ===== Cloudflare D1 远程轮询 =====
// 服务器启动后轮询 Cloudflare D1 数据库拉取订单
const POLL_INTERVAL = 10000; // 每 10 秒轮询一次
const POLL_TOKEN = process.env.POLL_TOKEN || ''; // 在 settings.json 中配置
const POLL_URL = 'https://ppt-service.pages.dev/api/poll';
const UPDATE_URL = 'https://ppt-service.pages.dev/api/orders';

async function fetchD1Orders() {
  if (!POLL_TOKEN) return [];
  try {
    const res = await fetch(POLL_URL, {
      headers: { 'X-Auth-Token': POLL_TOKEN, 'Accept': 'application/json' },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.orders || [];
  } catch (e) {
    return [];
  }
}

async function updateD1Order(orderId, updates) {
  if (!POLL_TOKEN) return;
  try {
    await fetch(`${UPDATE_URL}/${orderId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': POLL_TOKEN },
      body: JSON.stringify(updates),
    });
  } catch (e) { /* ignore */ }
}

// 将 D1 订单转为本地订单格式并加入队列
async function pollAndQueueD1Orders() {
  try {
    const remoteOrders = await fetchD1Orders();
    if (!remoteOrders.length) return;

    for (const r of remoteOrders) {
      // 跳过已经在本地队列中的订单
      if (orderQueue.some(o => o === r.id) || r.id === processingOrderId) continue;
      // 检查本地 orders.json 是否已存在
      const localOrders = loadOrders();
      if (localOrders.some(o => o.id === r.id)) continue;

      log('info', `📥 从 Pages 拉取新订单 #${r.id}: ${r.topic}`);
      const order = {
        id: r.id,
        customerName: r.customer_name || '',
        email: r.email || '',
        topic: r.topic || '',
        pages: r.pages || 15,
        deadline: r.deadline || '',
        notes: r.notes || '',
        attachments: JSON.parse(r.attachments || '[]'),
        filePaths: JSON.parse(r.file_paths || '[]'),
        status: 'queued',
        progress: '排队中...',
        createdAt: r.created_at || new Date().toISOString().replace(/T/, ' ').slice(0, 19),
        completedAt: null,
        resultPath: null,
        error: null,
      };
      localOrders.push(order);
      saveOrders(localOrders);
      orderQueue.push(r.id);
      broadcastOrderUpdate(order);
      log('success', `📋 已加入本地队列: ${r.topic}`);
    }

    // 有新的远程订单则触发队列处理
    if (processingOrderId === null && orderQueue.length > 0) {
      processQueue();
    }
  } catch (e) {
    log('warn', `轮询 D1 出错: ${e.message}`);
  }
}

// 更新 D1 订单状态的钩子（在本地订单状态变化时同步到远程）
function syncStatusToD1(order) {
  const updates = {};
  if (order.status === 'running') updates.status = 'running';
  else if (order.status === 'completed') {
    updates.status = 'completed';
    updates.progress = '✅ 已完成';
    updates.completed_at = order.completedAt;
    updates.result_path = order.resultPath || '';
  } else if (order.status === 'failed') {
    updates.status = 'failed';
    updates.progress = order.progress || '❌ 失败';
    updates.error = order.error || '';
  }
  if (Object.keys(updates).length > 0) {
    updateD1Order(order.id, updates);
  }
}

// ===== 订单管理 =====
function loadOrders() {
  try {
    if (fs.existsSync(ORDERS_FILE))
      return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf-8'));
  } catch (e) { /* ignore */ }
  return [];
}

function saveOrders(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

function generateOrderId() {
  return Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 6);
}

let orderQueue = [];
let processingOrderId = null;
let cdpProcess = null;
let cdpState = { running: false, stage: 'idle' };
let currentCdpOrderId = null;

function updateCdpState(running, stage) {
  cdpState = { running, stage };
  log('info', `[CDP状态] ${stage}`);
}

function broadcastNotification(notif) {
  broadcastSSE('notification', notif);
}

function broadcastOrderUpdate(order) {
  broadcastSSE('order_update', { order });
}

// ===== 队列处理 =====
async function processQueue() {
  if (processingOrderId || orderQueue.length === 0) return;

  const orderId = orderQueue.shift();
  processingOrderId = orderId;
  currentCdpOrderId = orderId;

  const orders = loadOrders();
  const order = orders.find(o => o.id === orderId);
  if (!order) { processingOrderId = null; processQueue(); return; }

  order.status = 'running';
  order.progress = '启动中...';
  saveOrders(orders);
  broadcastOrderUpdate(order);
  syncStatusToD1(order); // 同步到 D1
  log('cdp', `📋 开始处理订单 #${orderId}: ${order.topic}`);

  const result = await runCdpForOrder(order);

  const orders2 = loadOrders();
  const saved = orders2.find(o => o.id === orderId);
  if (saved) {
    saved.status = result.success ? 'completed' : 'failed';
    saved.progress = result.success
      ? '✅ 已完成'
      : `❌ ${result.error ? '失败: ' + result.error.slice(0, 60) : '失败'}`;
    saved.completedAt = new Date().toISOString().replace(/T/, ' ').slice(0, 19);
    saved.resultPath = result.filePath || null;
    saveOrders(orders2);
    syncStatusToD1(saved); // 同步完成/失败状态到 D1
  }

  const notif = {
    orderId,
    topic: order.topic,
    customerName: order.customerName,
    status: result.success ? 'completed' : 'failed',
    message: result.success
      ? `✅ PPT「${order.topic}」已生成完成！`
      : `❌ PPT「${order.topic}」生成失败`,
  };

  broadcastNotification(notif);
  broadcastOrderUpdate(notif);

  if (result.success) {
    log('success', `🎯 订单完成: ${order.topic}`);
  } else {
    log('error', `❌ 订单失败: ${order.topic}${result.error ? ' - ' + result.error : ''}`);
  }

  currentCdpOrderId = null;
  processingOrderId = null;
  processQueue();
}

function addOrderToQueue(orderData) {
  const orders = loadOrders();
  const order = {
    id: generateOrderId(),
    customerName: orderData.customerName || orderData.name || '',
    email: orderData.email || '',
    topic: orderData.topic || '',
    pages: orderData.pages || 15,
    deadline: orderData.deadline || '',
    notes: orderData.notes || '',
    attachments: orderData.attachments || [],
    filePaths: orderData.filePaths || [],
    status: 'queued',
    progress: '排队中...',
    createdAt: new Date().toISOString().replace(/T/, ' ').slice(0, 19),
    completedAt: null,
    resultPath: null,
    error: null,
  };
  orders.push(order);
  saveOrders(orders);
  orderQueue.push(order.id);
  broadcastOrderUpdate(order);
  log('info', `📥 新订单 #${order.id}: ${order.topic} (${order.customerName})`);
  processQueue();
  return order;
}

// ===== 运行 CDP（带订单跟踪）=====
function runCdpForOrder(order) {
  return new Promise((resolve) => {
    const prompt = buildPrompt(order);
    const opts = {
      prompt,
      mode: '智能布局',
      filePaths: order.filePaths || [],
      pageCount: order.pages,
      email: order.email,
      customer: order.customerName,
      topic: order.topic,
    };

    const args = ['--prompt', opts.prompt];
    if (opts.mode) args.push('--mode', opts.mode);
    if (opts.email) args.push('--email', opts.email);
    if (opts.customer) args.push('--customer', opts.customer);
    if (opts.topic) args.push('--topic', opts.topic);
    if (opts.pageCount) args.push('--pages', String(opts.pageCount));
    if (opts.filePaths && opts.filePaths.length > 0)
      args.push('--files-json', JSON.stringify(opts.filePaths));

    updateCdpState(true, '启动中...');
    log('cdp', `🤖 CDP 启动 (${opts.topic || 'PPT生成'})`);

    // 更新订单状态
    const orders = loadOrders();
    const saved = orders.find(o => o.id === order.id);
    if (saved) { saved.progress = '🤖 CDP 自动化中...'; saveOrders(orders); }

    cdpProcess = spawn('node', [CDP_SCRIPT, ...args], {
      cwd: ROOT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        RESEND_API_KEY: settings.resendApiKey || '',
        SMTP_HOST: settings.smtpHost || '',
        SMTP_USER: settings.smtpUser || '',
        SMTP_PASS: settings.smtpPass || '',
        SMTP_PORT: String(settings.smtpPort || ''),
        DOWNLOAD_DIR: settings.downloadDir || '',
      },
    });

    cdpProcess.stdout.on('data', (data) => {
      const lines = data.toString().trim().split('\n');
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        let progress = '';
        if (t.includes('输入提示词')) { updateCdpState(true, '输入提示词'); progress = '📝 输入提示词'; }
        else if (t.includes('上传')) { updateCdpState(true, '上传附件'); progress = '📤 上传附件'; }
        else if (t.includes('选择模式')) { updateCdpState(true, '选择模式'); progress = '🎨 选择模式'; }
        else if (t.includes('点击发送')) { updateCdpState(true, '正在发送...'); progress = '🚀 正在发送...'; }
        else if (t.includes('等待生成')) { updateCdpState(true, '⏳ Kimi 生成中'); progress = '⏳ Kimi 生成中...'; }
        else if (t.includes('生成完成') || t.includes('已完成')) { updateCdpState(true, '✅ 生成完成'); progress = '✅ 生成完成'; }
        else if (t.includes('下载') || t.includes('保存')) { updateCdpState(true, '💾 下载中'); progress = '💾 下载中...'; }
        else if (t.includes('发送邮件')) { updateCdpState(true, '📧 发送邮件'); progress = '📧 发送邮件...'; }
        else if (t.includes('全流程完成')) { updateCdpState(false, '✅ 全流程完成'); progress = '✅ 全流程完成'; }
        log('cdp', t);

        if (progress && currentCdpOrderId) {
          const oo = loadOrders();
          const oo2 = oo.find(o => o.id === currentCdpOrderId);
          if (oo2) { oo2.progress = progress; saveOrders(oo); }
        }
      }
    });

    cdpProcess.stderr.on('data', (data) => {
      const text = data.toString().trim();
      if (text) log('error', `[CDP] ${text}`);
    });

    cdpProcess.on('close', (code) => {
      const stage = code === 0 ? '完成' : `失败(code=${code})`;
      updateCdpState(false, stage);
      log(code === 0 ? 'success' : 'error', `CDP 退出 (code=${code})`);
      cdpProcess = null;
      resolve({ success: code === 0 });
    });

    cdpProcess.on('error', (err) => {
      updateCdpState(false, `错误: ${err.message}`);
      log('error', `CDP 失败: ${err.message}`);
      cdpProcess = null;
      resolve({ success: false, error: err.message });
    });
  });
}

// ===== 检查 CDP/Edge 连接 =====
function checkEdge() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:9222/json/version', (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const info = JSON.parse(data);
          resolve({ connected: true, browser: info.Browser || 'Edge/Chrome' });
        } catch (e) {
          resolve({ connected: true });
        }
      });
    });
    req.on('error', () => resolve({ connected: false }));
    req.setTimeout(3000, () => { req.destroy(); resolve({ connected: false }); });
    req.end();
  });
}

// ===== 解析 multipart =====
function parseMultipart(buf, boundary) {
  const parts = [];
  const delimiter = `--${boundary}`;
  let pos = 0;
  while (pos < buf.length) {
    const start = buf.indexOf(delimiter, pos);
    if (start === -1) break;
    const end = buf.indexOf('\r\n', start + delimiter.length);
    if (end === -1) break;
    const partStart = start + delimiter.length;
    if (buf.slice(partStart, partStart + 2).toString() === '--') break;
    const headersStart = partStart + 2;
    const headersEnd = buf.indexOf('\r\n\r\n', headersStart);
    if (headersEnd === -1) break;
    const headerStr = buf.slice(headersStart, headersEnd).toString().toLowerCase();
    const dataStart = headersEnd + 4;
    const dataEnd = buf.indexOf(`\r\n${delimiter}`, dataStart);
    if (dataEnd === -1) break;
    const data = buf.slice(dataStart, dataEnd);
    pos = dataEnd;
    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);
    const contentTypeMatch = headerStr.match(/content-type:\s*(\S+)/i);
    const name = nameMatch ? nameMatch[1] : 'unknown';
    if (filenameMatch) {
      parts.push({ name, filename: filenameMatch[1], contentType: contentTypeMatch ? contentTypeMatch[1] : 'application/octet-stream', data, isFile: true });
    } else {
      parts.push({ name, value: data.toString('utf-8').trim(), isFile: false });
    }
  }
  return parts;
}

function buildPrompt(item) {
  const parts = [];
  parts.push(`${item.pages} 页`);
  if (item.notes && item.notes.trim()) parts.push(item.notes.trim());
  if (item.attachments && item.attachments.length > 0) {
    parts.push(`附件：\n${item.attachments.map((f, i) => `${i + 1}. ${f.name}`).join('\n')}`);
  }
  return parts.join('\n\n');
}

// ===== 工具 =====
function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// ===== 启动 Edge（正确方式）=====
function launchEdge() {
  return new Promise((resolve) => {
    // 1. 结束所有已存在的 Edge 进程
    try {
      execSync('taskkill /F /IM msedge.exe 2>nul', { stdio: 'ignore' });
      log('info', '已终止现有 Edge 进程');
    } catch (e) { /* 没有运行中的 Edge 也正常 */ }

    // 2. 找 Edge 路径
    const edgePaths = [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    ];
    const edgePath = edgePaths.find(p => fs.existsSync(p));
    if (!edgePath) {
      resolve({ success: false, error: '未找到 Edge 浏览器' });
      return;
    }

    // 3. 确保用户数据目录存在（用新目录避免旧配置被锁）
    const userDataDir = path.join(process.env.USERPROFILE || 'C:/Users/Administrator', '.ppt-edge-debug');
    fs.mkdirSync(userDataDir, { recursive: true });

    // 4. 启动 Edge（远程调试模式，打开 Kimi Slides）
    try {
      const proc = spawn(edgePath, [
        `--remote-debugging-port=9222`,
        `--user-data-dir=${userDataDir}`,
        'https://www.kimi.com/slides',
      ], { detached: true, stdio: 'ignore' });
      proc.unref();
      log('info', '🚀 Edge 已启动 (远程调试端口 9222, 目标: Kimi Slides)');
      resolve({ success: true });
    } catch (e) {
      resolve({ success: false, error: e.message });
    }
  });
}

// ===== 主请求处理 =====
async function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    // ===== SSE 日志流 =====
    if (pathname === '/api/logs/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(`data: ${JSON.stringify({ type: 'connected', msg: '日志流已连接' })}\n\n`);
      for (const entry of logBuffer) {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
      }
      sseClients.push(res);
      req.on('close', () => {
        sseClients = sseClients.filter(c => c !== res);
      });
      return;
    }

    // ===== GET /api/status =====
    if (pathname === '/api/status') {
      const edge = await checkEdge();
      const orders = loadOrders();
      const queuedCount = orders.filter(o => o.status === 'queued' || o.status === 'running').length;
      const totalCount = orders.length;
      json(res, 200, {
        server: { running: true, port: PORT, uptime: process.uptime() },
        cdp: { ...edge },
        cdpProcess: { ...cdpState },
        processingOrderId,
        queueLength: orderQueue.length,
        stats: { total: totalCount, queued: queuedCount, running: processingOrderId ? 1 : 0, completed: orders.filter(o => o.status === 'completed').length },
        downloadDir: settings.downloadDir,
      });
      return;
    }

    // ===== GET /api/orders =====
    if (pathname === '/api/orders' && req.method === 'GET') {
      const orders = loadOrders();
      json(res, 200, orders.reverse());
      return;
    }

    // ===== GET /api/orders/:id =====
    if (pathname.startsWith('/api/orders/') && req.method === 'GET') {
      const id = pathname.split('/')[3];
      const orders = loadOrders();
      const order = orders.find(o => o.id === id);
      if (order) json(res, 200, order);
      else json(res, 404, { error: '未找到订单' });
      return;
    }

    // ===== POST /api/orders（新建订单）=====
    if (pathname === '/api/orders' && req.method === 'POST') {
      const body = await readBody(req);
      const data = JSON.parse(body.toString());
      // 支持文件路径传入
      if (data.files && Array.isArray(data.files)) {
        data.filePaths = data.files;
      }
      const order = addOrderToQueue(data);
      json(res, 200, { success: true, order });
      return;
    }

    // ===== POST /api/orders/:id/cancel =====
    if (pathname.match(/^\/api\/orders\/[^/]+\/cancel$/) && req.method === 'POST') {
      const id = pathname.split('/')[3];
      const orders = loadOrders();
      const order = orders.find(o => o.id === id);
      if (!order) { json(res, 404, { error: '未找到订单' }); return; }

      if (order.status === 'running' && cdpProcess) {
        try {
          if (process.platform === 'win32')
            execSync(`taskkill /PID ${cdpProcess.pid} /T /F`, { stdio: 'ignore' });
          else
            cdpProcess.kill('SIGTERM');
        } catch (e) { cdpProcess.kill(); }
        cdpProcess = null;
        updateCdpState(false, '已取消');
      }

      // 从队列移除
      orderQueue = orderQueue.filter(qid => qid !== id);
      if (processingOrderId === id) processingOrderId = null;
      if (currentCdpOrderId === id) currentCdpOrderId = null;

      order.status = 'cancelled';
      order.progress = '⏹️ 已取消';
      saveOrders(orders);
      broadcastOrderUpdate(order);
      json(res, 200, { success: true });
      return;
    }

    // ===== DELETE /api/orders/:id =====
    if (pathname.match(/^\/api\/orders\/[^/]+$/) && req.method === 'DELETE') {
      const id = pathname.split('/')[3];
      let orders = loadOrders();
      const order = orders.find(o => o.id === id);
      if (!order) { json(res, 404, { error: '未找到订单' }); return; }
      if (order.status === 'running' || order.status === 'queued') {
        json(res, 400, { error: '运行中的订单不能删除，请先取消' });
        return;
      }
      orders = orders.filter(o => o.id !== id);
      saveOrders(orders);
      json(res, 200, { success: true });
      return;
    }

    // ===== POST /api/cdp/run (兼容，现在创建订单)=====
    if (pathname === '/api/cdp/run' && req.method === 'POST') {
      const body = await readBody(req);
      const opts = JSON.parse(body.toString());
      const order = addOrderToQueue({
        customerName: opts.customer || '客户',
        email: opts.email || '',
        topic: opts.topic || 'PPT 生成',
        pages: opts.pageCount || 15,
        notes: opts.prompt || '',
        filePaths: opts.filePaths || [],
      });
      json(res, 200, { success: true, message: '已加入队列', order });
      return;
    }

    // ===== POST /api/cdp/stop =====
    if (pathname === '/api/cdp/stop' && req.method === 'POST') {
      if (cdpProcess) {
        try {
          if (process.platform === 'win32')
            execSync(`taskkill /PID ${cdpProcess.pid} /T /F`, { stdio: 'ignore' });
          else
            cdpProcess.kill('SIGTERM');
        } catch (e) { cdpProcess.kill(); }
        cdpProcess = null;
        updateCdpState(false, '已手动停止');
        json(res, 200, { success: true });
      } else {
        json(res, 200, { success: true, message: 'CDP 未运行' });
      }
      return;
    }

    // ===== GET/POST /api/settings =====
    if (pathname === '/api/settings' && req.method === 'GET') {
      json(res, 200, settings);
      return;
    }
    if (pathname === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req);
      saveSettings(JSON.parse(body.toString()));
      json(res, 200, { success: true, message: '已保存' });
      return;
    }

    // ===== POST /api/edge/launch（正确版本）=====
    if (pathname === '/api/edge/launch' && req.method === 'POST') {
      const result = await launchEdge();
      if (result.success) {
        json(res, 200, { success: true, message: 'Edge 已启动（远程调试端口 9222，目标 Kimi Slides）' });
      } else {
        json(res, 404, { success: false, error: result.error });
      }
      return;
    }

    // ===== POST /api/submit（原有功能，现在跟踪订单）=====
    if (pathname === '/api/submit' && req.method === 'POST') {
      const contentType = req.headers['content-type'] || '';
      log('info', '📥 收到新提交');

      if (!contentType.includes('multipart/form-data')) {
        json(res, 400, { success: false, error: '需要 multipart/form-data' });
        return;
      }

      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const buf = Buffer.concat(chunks);

      const boundary = contentType.split('boundary=')[1];
      if (!boundary) throw new Error('缺少 boundary');
      const parts = parseMultipart(buf, boundary);

      const fields = {};
      const attachments = [];
      for (const p of parts) {
        if (p.isFile) attachments.push(p);
        else fields[p.name] = p.value;
      }

      if (!fields.name || !fields.email || !fields.topic || !fields.pages || !fields.deadline) {
        json(res, 400, { success: false, error: '请填写所有必填项' });
        return;
      }

      const submissionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const dir = path.join(TEMP_DIR, submissionId);
      fs.mkdirSync(dir, { recursive: true });

      const savedFiles = [];
      const filePaths = [];
      for (const att of attachments) {
        const safeName = att.filename.replace(/[^a-zA-Z0-9一-龥._-]/g, '_');
        const filePath = path.join(dir, safeName);
        fs.writeFileSync(filePath, att.data);
        filePaths.push(filePath);
        savedFiles.push({ name: att.filename, size: att.data.length });
      }

      // 创建订单并加入队列
      const order = addOrderToQueue({
        customerName: fields.name,
        email: fields.email,
        topic: fields.topic,
        pages: fields.pages,
        deadline: fields.deadline,
        notes: fields.notes || '',
        attachments: savedFiles,
        filePaths,
      });

      json(res, 200, {
        success: true,
        message: '提交成功！已加入生成队列',
        order_id: order.id,
        order,
        files: savedFiles,
      });
      return;
    }

    // ===== GET /api/logs =====
    if (pathname === '/api/logs' && req.method === 'GET') {
      json(res, 200, logBuffer.slice(-200));
      return;
    }

    // ===== POST /api/logs/clear =====
    if (pathname === '/api/logs/clear' && req.method === 'POST') {
      logBuffer.length = 0;
      json(res, 200, { success: true });
      return;
    }

    // ===== 静态文件 =====
    if (pathname === '/') {
      if (fs.existsSync(DASHBOARD_HTML)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        res.end(fs.readFileSync(DASHBOARD_HTML));
      } else {
        const fallback = path.join(ROOT_DIR, 'index.html');
        if (fs.existsSync(fallback)) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(fs.readFileSync(fallback));
        } else {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('PPT Service v2.0 运行中 - 未找到 dashboard.html');
        }
      }
      return;
    }

    const staticPath = path.join(ROOT_DIR, pathname);
    if (fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
      const ext = path.extname(staticPath);
      const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
      res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
      res.end(fs.readFileSync(staticPath));
      return;
    }

    res.writeHead(404);
    res.end('Not Found');

  } catch (e) {
    log('error', `请求处理失败: ${e.message}`);
    if (!res.headersSent) json(res, 500, { success: false, error: e.message });
  }
}

// ===== 启动 =====
fs.mkdirSync(TEMP_DIR, { recursive: true });

process.title = 'ppt-service';

log('success', '='.repeat(50));
log('success', '⚡ PPT 智能生成服务 v2.0');
log('success', '='.repeat(50));
log('success', `📡 监听端口: ${PORT}`);
log('success', `🌐 Web UI:   http://0.0.0.0:${PORT}（局域网其他设备用本机 IP 访问）`);
log('success', `📥 提交接口: http://0.0.0.0:${PORT}/api/submit`);
log('success', `📂 下载目录: ${settings.downloadDir || '未设置'}`);
log('info', '');
log('info', '📌 使用说明:');
log('info', '  1. 点击仪表盘「🚀 启动 Edge」→ 自动打开 Kimi Slides');
log('info', '  2. 在 Kimi 页面登录账号');
log('info', '  3. 回到仪表盘填写订单 → 提交 → 自动排队处理');
log('success', '='.repeat(50));

const server = http.createServer(handleRequest);
server.listen(PORT, '0.0.0.0', () => {
  log('success', `✅ 服务已就绪: http://127.0.0.1:${PORT}`);
  log('info',   `💡 在浏览器中打开即可使用仪表盘`);
});

// ===== 启动 D1 轮询（如果配置了 POLL_TOKEN）=====
if (POLL_TOKEN) {
  log('info', '📡 D1 轮询已启用（间隔 10 秒）');
  setInterval(() => pollAndQueueD1Orders(), POLL_INTERVAL);
  // 启动后立即轮询一次
  setTimeout(() => pollAndQueueD1Orders(), 2000);
} else {
  log('info', '📡 D1 轮询未配置（设置 POLL_TOKEN 后启用）');
}

process.on('uncaughtException', (e) => {
  log('error', `未捕获异常: ${e.message}`);
});
process.on('SIGTERM', () => { log('info', '收到 SIGTERM'); process.exit(0); });
process.on('SIGINT', () => { log('info', '收到 SIGINT'); process.exit(0); });
