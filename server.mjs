// server.mjs — 本地 Webhook 服务
// 接收来自 Cloudflare Worker 的 POST 请求 → 自动提交到 Kimi AgentPPT
//
// Cloudflare Worker 配置:
//   环境变量: WEBHOOK_URL=http://localhost:3456/webhook
//
// 用法: node server.mjs [--port 3456]

import http from 'http';
import url from 'url';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

// ===== 配置 =====
const PORT = parseInt(process.argv.find(a => a.startsWith('--port='))?.split('=')[1]) || 3456;
const SECRET = process.env.WEBHOOK_SECRET || '';  // 可选，用于验证请求来源

// 日志目录 (存储附件)
const TEMP_DIR = process.env.TEMP_DIR || path.join(process.env.USERPROFILE || 'C:/Users/Administrator', 'AppData/Local/Temp/ppt-service');

// ===== 工具 =====
function log(msg, type = 'info') {
  const ts = new Date().toISOString().replace(/T/, ' ').slice(0, 19);
  const icons = { info: '📌', request: '📥', success: '✅', error: '❌', warn: '⚠️', cdp: '🤖' };
  console.log(`${ts} ${icons[type] || '·'} ${msg}`);
}

function safeName(str) {
  return str.replace(/[^a-zA-Z0-9一-龥_-]/g, '_').slice(0, 40);
}

// ===== 保存附件到本地 =====
async function saveAttachments(formData, requestId) {
  const dir = path.join(TEMP_DIR, requestId);
  fs.mkdirSync(dir, { recursive: true });

  const files = formData.getAll('attachments').filter(f => f instanceof File && f.size > 0);
  const savedPaths = [];

  for (const file of files) {
    const safeFileName = `${Date.now()}-${safeName(file.name)}`;
    const filePath = path.join(dir, safeFileName);
    const buffer = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(filePath, buffer);
    savedPaths.push(filePath);
    log(`已保存附件: ${file.name} (${(file.size/1024).toFixed(1)}KB) -> ${filePath}`);
  }

  return { dir, savedPaths };
}

// ===== 生成 Kimi 提示词（与 Worker 一致） =====
function buildKimiPrompt(data) {
  let text = `请使用 AgentPPT 能力生成一份专业的 PowerPoint 演示文稿。

## 基本信息
- 客户称呼：${data.name}
- 接收邮箱：${data.email}
- PPT 主题：${data.topic}
- 页数要求：${data.pages} 页（不超过 35 页）
- 交付时间：${data.deadline}`;

  if (data.style) text += `\n- 风格偏好：${data.style}`;
  if (data.notes) text += `\n\n## 内容要求\n${data.notes}`;

  text += `\n\n## 输出要求
1. 内容完整、逻辑清晰、排版美观
2. 控制在 ${data.pages} 页左右
3. 生成后提供下载链接或直接发送给客户`;

  return text;
}

// ===== 调用 CDP 自动化脚本 =====
function runCdpAutomation(opts) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.resolve('kimi-cdp.mjs');
    const args = ['--prompt', opts.prompt, '--mode', opts.mode || '智能布局'];

    // 传递客户信息（用于邮件）
    if (opts.email) args.push('--email', opts.email);
    if (opts.customer) args.push('--customer', opts.customer);
    if (opts.topic) args.push('--topic', opts.topic);

    if (opts.filePaths && opts.filePaths.length > 0) {
      opts.filePaths.forEach(f => {
        // 文件路径可能包含空格，用分隔符传
      });
      args.push('--files', opts.filePaths.join(','));
    }
    if (opts.pageCount && opts.pageCount !== 'auto') {
      args.push('--pages', opts.pageCount);
    }

    log(`启动 CDP 自动化: node kimi-cdp.mjs ${args.join(' ')}`, 'cdp');

    const child = spawn('node', [scriptPath, ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';

    child.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      process.stdout.write(`  [CDP] ${text}`);
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      output += text;
      process.stderr.write(`  [CDP:err] ${text}`);
    });

    child.on('close', (code) => {
      log(`CDP 进程退出，code=${code}`, code === 0 ? 'success' : 'warn');
      if (code === 0) {
        resolve({ success: true, output });
      } else {
        resolve({ success: false, output, exitCode: code });
      }
    });

    child.on('error', (err) => {
      log(`CDP 进程启动失败: ${err.message}`, 'error');
      reject(err);
    });
  });
}

// ===== 清理临时文件 =====
function cleanup(requestId) {
  const dir = path.join(TEMP_DIR, requestId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    log(`已清理临时目录: ${dir}`);
  } catch(e) {
    // ignore
  }
}

// ===== 验证请求 =====
function verifyRequest(req, body) {
  if (!SECRET) return true;

  const signature = req.headers['x-webhook-signature'];
  const timestamp = req.headers['x-webhook-timestamp'];

  if (!signature || !timestamp) {
    log('缺少签名头', 'warn');
    return false;
  }

  // 简单的 HMAC 验证
  const payload = `${timestamp}.${body}`;
  const expected = crypto
    .createHmac('sha256', SECRET)
    .update(payload)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// ===== HTTP 服务 =====
async function parseBody(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    const chunks = [];

    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);

      if (contentType.includes('multipart/form-data')) {
        // 解析 multipart 表单 (简单实现)
        const boundary = contentType.split('boundary=')[1];
        if (!boundary) return resolve({ raw: buf, type: 'unknown' });
        resolve({ raw: buf, type: 'multipart', boundary });
      } else if (contentType.includes('application/json')) {
        try {
          const data = JSON.parse(buf.toString());
          resolve({ data, type: 'json', raw: buf });
        } catch(e) {
          reject(new Error('JSON 解析失败'));
        }
      } else {
        resolve({ raw: buf, type: 'text', text: buf.toString() });
      }
    });
  });
}

// ===== 简易 multipart 解析 =====
function parseMultipart(raw, boundary) {
  const parts = [];
  const delimiter = `--${boundary}`;
  const buf = raw;
  let pos = 0;

  while (pos < buf.length) {
    const start = buf.indexOf(delimiter, pos);
    if (start === -1) break;
    const end = buf.indexOf(`\r\n`, start + delimiter.length);
    if (end === -1) break;

    const partStart = start + delimiter.length;
    if (buf.slice(partStart, partStart + 2).toString() === '--') break; // 结束

    // 跳过 \r\n
    const headersStart = partStart + 2;
    const headersEnd = buf.indexOf(`\r\n\r\n`, headersStart);
    if (headersEnd === -1) break;

    const headerStr = buf.slice(headersStart, headersEnd).toString();
    const dataStart = headersEnd + 4;
    const dataEnd = buf.indexOf(`\r\n${delimiter}`, dataStart);
    if (dataEnd === -1) break;

    const data = buf.slice(dataStart, dataEnd);
    pos = dataEnd;

    // 解析 header
    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);
    const contentTypeMatch = headerStr.match(/Content-Type:\s*(\S+)/i);

    if (filenameMatch) {
      parts.push({
        name: nameMatch?.[1] || 'file',
        filename: filenameMatch[1],
        contentType: contentTypeMatch?.[1] || 'application/octet-stream',
        data,
        isFile: true,
      });
    } else {
      parts.push({
        name: nameMatch?.[1] || 'unknown',
        value: data.toString(),
        isFile: false,
      });
    }
  }

  return parts;
}

// ===== 转化为 FormData 兼容对象 =====
function partsToFormData(parts) {
  const formData = new Map();
  const attachments = [];

  for (const p of parts) {
    if (p.isFile) {
      const file = {
        name: p.filename,
        size: p.data.length,
        type: p.contentType,
        arrayBuffer: async () => p.data,
        stream: () => p.data,
      };
      attachments.push(file);
    } else {
      formData.set(p.name, p.value);
    }
  }
  formData.set('attachments', attachments);
  formData.getAll = (name) => name === 'attachments' ? attachments : [formData.get(name)];

  return formData;
}

// ===== 主请求处理 =====
async function handleRequest(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS 头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-webhook-signature, x-webhook-timestamp');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // GET / — 健康检查
  if (req.method === 'GET' && (pathname === '/' || pathname === '/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'running',
      port: PORT,
      tempDir: TEMP_DIR,
      webhook: `http://localhost:${PORT}/webhook`,
    }));
    return;
  }

  // POST /webhook — 接收 Worker 请求
  if (req.method === 'POST' && pathname === '/webhook') {
    log('收到 webhook 请求', 'request');
    const requestId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    let responseSent = false;

    try {
      const body = await parseBody(req);

      let formData;
      let rawData = {};

      if (body.type === 'multipart') {
        const parts = parseMultipart(body.raw, body.boundary);
        formData = partsToFormData(parts);
        for (const p of parts) {
          if (!p.isFile) rawData[p.name] = p.value;
        }
        rawData.attachments = formData.getAll('attachments');
      } else if (body.type === 'json') {
        rawData = body.data;
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '不支持的 Content-Type' }));
        return;
      }

      // 验证
      if (!rawData.topic) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '缺少 topic 字段' }));
        return;
      }

      // 立即返回 202 给 Worker (异步处理)
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: '已接收请求，正在提交到 Kimi AgentPPT',
        requestId,
      }));
      responseSent = true;

      // 保存附件
      let savedPaths = [];
      if (rawData.attachments && rawData.attachments.length > 0) {
        const fileList = rawData.attachments;
        const dir = path.join(TEMP_DIR, requestId);
        fs.mkdirSync(dir, { recursive: true });

        for (const file of fileList) {
          const safeFileName = `${Date.now()}-${safeName(file.name)}`;
          const filePath = path.join(dir, safeFileName);
          const buffer = Buffer.from(await file.arrayBuffer());
          fs.writeFileSync(filePath, buffer);
          savedPaths.push(filePath);
          log(`已保存附件: ${file.name} -> ${filePath}`);
        }
      }

      // 构造完整提示词
      const prompt = buildKimiPrompt(rawData);

      // 运行 CDP 自动化
      const cdpResult = await runCdpAutomation({
        prompt,
        mode: rawData.style || '智能布局',
        filePaths: savedPaths.length > 0 ? savedPaths : undefined,
        pageCount: rawData.pages || 'auto',
        email: rawData.email || undefined,
        customer: rawData.name || undefined,
        topic: rawData.topic,
      });

      // 清理临时文件
      cleanup(requestId);

      if (!cdpResult.success) {
        log('CDP 自动化未完全成功', 'warn');
      }

    } catch (e) {
      log(`处理 webhook 失败: ${e.message}`, 'error');
      cleanup(requestId);

      if (!responseSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    }
    return;
  }

  // 404
  res.writeHead(404);
  res.end('Not Found');
}

// ===== 启动 =====
fs.mkdirSync(TEMP_DIR, { recursive: true });

const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  log('='.repeat(50));
  log('PPT Service Local Webhook Server');
  log('='.repeat(50));
  log(`监听端口: ${PORT}`);
  log(`Webhook URL: http://localhost:${PORT}/webhook`);
  log(`临时目录: ${TEMP_DIR}`);
  log('');
  log('在 Cloudflare Worker 中设置环境变量:');
  log(`  WEBHOOK_URL=http://YOUR_IP:${PORT}/webhook`);
  log('');
  log('健康检查: http://localhost:${PORT}/health');
  log('='.repeat(50));
});

process.on('uncaughtException', (e) => {
  log(`未捕获异常: ${e.message}`, 'error');
});

process.on('SIGTERM', () => {
  log('收到 SIGTERM，正在关闭...');
  server.close(() => process.exit(0));
});
