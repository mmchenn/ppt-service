// server.mjs — 本地 HTTP 接收服务 + CDP 自动化
//
// 工作流程:
//   浏览器直接 POST http://localhost:3456/api/submit (FormData)
//   → 接收表单 + 保存附件到本地临时目录
//   → 调用 kimi-cdp.mjs (原文 + 真实文件)
//   → 返回成功给浏览器
//
// 用法: node server.mjs [--port 3456]
//
// 环境变量:
//   TEMP_DIR     - 附件临时目录 (默认 %TEMP%/ppt-service)

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

// ===== 配置 =====
const PORT = parseInt(process.argv.find(a => a.startsWith('--port='))?.split('=')[1]) || 3456;
const TEMP_DIR = process.env.TEMP_DIR || path.join(process.env.USERPROFILE || 'C:/Users/Administrator', 'AppData/Local/Temp/ppt-service');

// ===== 工具 =====
function log(msg, type = 'info') {
  const ts = new Date().toISOString().replace(/T/, ' ').slice(0, 19);
  const icons = { info: '📌', request: '📥', success: '✅', error: '❌', warn: '⚠️', cdp: '🤖', dl: '💾' };
  console.log(`${ts} ${icons[type] || '·'} ${msg}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ===== 解析 multipart/form-data =====
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
      parts.push({
        name,
        filename: filenameMatch[1],
        contentType: contentTypeMatch ? contentTypeMatch[1] : 'application/octet-stream',
        data,
        isFile: true,
      });
    } else {
      parts.push({
        name,
        value: data.toString('utf-8').trim(),
        isFile: false,
      });
    }
  }

  return parts;
}

// ===== 调用 CDP 自动化 =====
function runCdpAutomation(opts) {
  return new Promise((resolve) => {
    const scriptPath = path.resolve('kimi-cdp.mjs');
    const args = ['--prompt', opts.prompt];

    if (opts.mode) args.push('--mode', opts.mode);
    if (opts.email) args.push('--email', opts.email);
    if (opts.customer) args.push('--customer', opts.customer);
    if (opts.topic) args.push('--topic', opts.topic);
    if (opts.pageCount) args.push('--pages', String(opts.pageCount));
    if (opts.filePaths && opts.filePaths.length > 0) {
      args.push('--files-json', JSON.stringify(opts.filePaths));
    }

    log(`启动 CDP 自动化`, 'cdp');
    log(`  提示词长度: ${opts.prompt.length} 字符`, 'cdp');
    log(`  附件数量: ${(opts.filePaths || []).length}`, 'cdp');

    const child = spawn('node', [scriptPath, ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        RESEND_API_KEY: process.env.RESEND_API_KEY || '',
        SMTP_USER: process.env.SMTP_USER || '',
        SMTP_PASS: process.env.SMTP_PASS || '',
        SMTP_HOST: process.env.SMTP_HOST || '',
        SMTP_PORT: process.env.SMTP_PORT || '',
        ADMIN_EMAIL: process.env.ADMIN_EMAIL || '',
        DOWNLOAD_DIR: process.env.DOWNLOAD_DIR || 'M:/资料',
      },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      process.stdout.write(`  [CDP] ${text}`);
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      if (text.trim()) process.stderr.write(`  [CDP:err] ${text}`);
    });

    child.on('close', (code) => {
      log(`CDP 进程退出 code=${code}`, code === 0 ? 'success' : 'warn');
      resolve({ success: code === 0, output: stdout, stderr, exitCode: code });
    });

    child.on('error', (err) => {
      log(`CDP 启动失败: ${err.message}`, 'error');
      resolve({ success: false, error: err.message });
    });
  });
}

// ===== 构造 Kimi 提示词 =====
function buildPrompt(item) {
  let text = `请使用 AgentPPT 能力生成一份专业的 PowerPoint 演示文稿。

## 基本信息
- 客户称呼：${item.name}
- 接收邮箱：${item.email}
- PPT 主题：${item.topic}
- 页数要求：${item.pages} 页
- 交付时间：${item.deadline}`;

  if (item.style) text += `\n- 风格偏好：${item.style}`;
  if (item.notes) text += `\n\n## 内容要求\n${item.notes}`;
  if (item.files && item.files.length > 0) {
    text += `\n\n## 附件资料\n`;
    item.files.forEach((f, i) => {
      const sizeStr = f.size
        ? (f.size < 1024 ? f.size + 'B' : f.size < 1048576 ? (f.size / 1024).toFixed(1) + 'KB' : (f.size / 1048576).toFixed(1) + 'MB')
        : '未知大小';
      text += `  ${i + 1}. ${f.name} (${sizeStr})\n`;
    });
    text += `请参考附件资料中的内容生成 PPT。`;
  }
  text += `\n\n## 输出要求\n1. 内容完整、逻辑清晰、排版美观\n2. 控制在 ${item.pages} 页左右\n3. 生成后提供下载链接或直接发送给客户`;

  return text;
}

// ===== 清理临时目录 =====
function cleanup(submissionId) {
  const dir = path.join(TEMP_DIR, submissionId);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

// ===== HTTP 请求处理 =====
async function handleRequest(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // GET / — 健康检查
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'running', port: PORT, tempDir: TEMP_DIR }));
    return;
  }

  // POST /api/submit — 接收表单
  if (req.method === 'POST' && req.url === '/api/submit') {
    const contentType = req.headers['content-type'] || '';
    log('收到新提交', 'request');

    if (!contentType.includes('multipart/form-data')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: '需要 multipart/form-data' }));
      return;
    }

    try {
      // 1. 收集请求体
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const buf = Buffer.concat(chunks);

      // 2. 解析 multipart
      const boundary = contentType.split('boundary=')[1];
      if (!boundary) throw new Error('缺少 boundary');
      const parts = parseMultipart(buf, boundary);

      // 3. 提取表单字段
      const fields = {};
      const attachments = [];
      for (const p of parts) {
        if (p.isFile) {
          attachments.push(p);
        } else {
          fields[p.name] = p.value;
        }
      }

      // 4. 验证必填
      if (!fields.name || !fields.email || !fields.topic || !fields.pages || !fields.deadline) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: '请填写所有必填项' }));
        return;
      }

      // 5. 保存附件到本地
      const submissionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const dir = path.join(TEMP_DIR, submissionId);
      fs.mkdirSync(dir, { recursive: true });

      const savedFiles = [];
      const localPaths = [];
      for (const att of attachments) {
        const safeName = att.filename.replace(/[^a-zA-Z0-9一-龥._-]/g, '_');
        const filePath = path.join(dir, safeName);
        fs.writeFileSync(filePath, att.data);
        localPaths.push(filePath);
        savedFiles.push({ name: att.filename, size: att.data.length });
        log(`已保存附件: ${att.filename} (${(att.data.length/1024).toFixed(1)}KB)`, 'dl');
      }

      // 6. 构造提示词
      const item = {
        name: fields.name,
        email: fields.email,
        topic: fields.topic,
        pages: fields.pages,
        deadline: fields.deadline,
        style: fields.style || '',
        notes: fields.notes || '',
        files: savedFiles,
      };
      const prompt = buildPrompt(item);

      // 7. 打印提交详情
      log('─'.repeat(50), 'request');
      log(`  客户: ${item.name} <${item.email}>`);
      log(`  主题: ${item.topic}`);
      log(`  页数: ${item.pages} | 交付: ${item.deadline}`);
      if (item.style) log(`  风格: ${item.style}`);
      if (item.notes) log(`  要求: ${item.notes.slice(0, 200)}`);
      log(`  附件: ${savedFiles.length} 个`);
      savedFiles.forEach(f => log(`    · ${f.name}`));
      log('─'.repeat(50), 'request');

      // 8. 先返回给浏览器（让前端知道提交成功）
      //    然后后台异步执行 CDP
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: '需求已提交！正在自动提交到 Kimi 生成…',
        submission_id: submissionId,
        file_count: savedFiles.length,
        agent_prompt: prompt,
        files: savedFiles,
      }));

      // 9. 异步执行 CDP（不影响前端响应）
      log(`开始 CDP 自动化...`, 'cdp');
      const cdpResult = await runCdpAutomation({
        prompt,
        mode: item.style || '智能布局',
        filePaths: localPaths,
        pageCount: item.pages,
        email: item.email,
        customer: item.name,
        topic: item.topic,
      });

      if (cdpResult.success) {
        log(`✅ 全流程完成: ${item.topic}`, 'success');
      } else {
        log(`❌ CDP 自动化失败: ${cdpResult.error || 'exit code ' + cdpResult.exitCode}`, 'error');
      }

      // 10. 清理临时文件
      cleanup(submissionId);

    } catch (e) {
      log(`处理失败: ${e.message}`, 'error');
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
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

log('='.repeat(50));
log('PPT Service — 本地直收模式');
log('='.repeat(50));
log(`监听端口: ${PORT}`);
log(`接收地址: http://localhost:${PORT}/api/submit`);
log(`临时目录: ${TEMP_DIR}`);
log('');
log('📌 确保以下条件就绪:');
log('  1. Edge 已启动 --remote-debugging-port=9222');
log('  2. Kimi slides 页面已打开并登录');
log('  3. 前端 index.html 中的 fetch 指向本机');
log('='.repeat(50));

import http from 'http';
const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  log(`服务已启动: http://localhost:${PORT}`, 'success');
});

process.on('uncaughtException', (e) => {
  log(`未捕获异常: ${e.message}`, 'error');
});

process.on('SIGTERM', () => {
  log('收到 SIGTERM，正在关闭...', 'info');
  process.exit(0);
});
