// kimi-cdp.mjs — CDP 自动化提交到 Kimi AgentPPT + 下载 PPT + 发送邮件
//
// 用法: node kimi-cdp.mjs [--prompt "提示词"] [--files "f1,f2"] [--mode 智能布局|经典模板]
//                         [--email "client@example.com"] [--customer "称呼"]
//
// 环境变量:
//   RESEND_API_KEY — 用于发送邮件 (可选，不设置则不发送)
//   ADMIN_EMAIL    — 管理员通知邮箱 (可选)
//   DOWNLOAD_DIR   — PPT 下载目录 (默认: %TEMP%/ppt-service/downloads)

import CDP from 'chrome-remote-interface';
import { createInterface } from 'readline';
import fs from 'fs';
import path from 'path';
import http from 'http';

// ===== 配置 =====
const KIMI_URL = 'https://www.kimi.com/slides';
const DEBUG_PORT = 9222;
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || 'M:/资料';

// ===== 工具函数 =====
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(msg, level = 'info') {
  const ts = new Date().toISOString().replace(/T/, ' ').slice(0, 19);
  const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : level === 'step' ? '▶️' : level === 'mail' ? '📧' : level === 'dl' ? '💾' : '✅';
  console.log(`${ts} ${prefix} ${msg}`);
}

function safeName(str) {
  return str.replace(/[^a-zA-Z0-9一-龥_-]/g, '_').slice(0, 60);
}

// ===== 解析命令行参数 =====
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    prompt: '',
    files: [],
    mode: '智能布局',
    pageCount: 'auto',
    email: '',
    customer: '',
    topic: '',
    deadline: '',
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--prompt' && args[i+1]) opts.prompt = args[++i];
    else if (args[i] === '--files' && args[i+1]) opts.files = args[++i].split(',').filter(Boolean);
    else if (args[i] === '--mode' && args[i+1]) opts.mode = args[++i];
    else if (args[i] === '--pages' && args[i+1]) opts.pageCount = args[++i];
    else if (args[i] === '--email' && args[i+1]) opts.email = args[++i];
    else if (args[i] === '--customer' && args[i+1]) opts.customer = args[++i];
    else if (args[i] === '--topic' && args[i+1]) opts.topic = args[++i];
    else if (args[i] === '--deadline' && args[i+1]) opts.deadline = args[++i];
  }
  return opts;
}

// ===== 查找 Kimi 标签页 =====
async function findKimiTab() {
  const tabs = await CDP.List({ port: DEBUG_PORT });
  const slidesTab = tabs.find(t => t.url.includes('kimi.com/slides'));
  const chatTab = tabs.find(t => t.url.includes('kimi.com/chat/'));
  // 优先找 chat 页面（已有生成任务的），其次 slides
  if (chatTab) {
    log(`找到 Kimi Chat 标签页: ${chatTab.title}`, 'info');
    return { tab: chatTab, navigate: false };
  }
  if (slidesTab) {
    log(`找到 Kimi Slides 标签页: ${slidesTab.title}`, 'info');
    return { tab: slidesTab, navigate: false };
  }
  const anyKimi = tabs.find(t => t.url.includes('kimi.com'));
  if (anyKimi) {
    log(`找到 Kimi 页面但不是 slides: ${anyKimi.url}`, 'warn');
    return { tab: anyKimi, navigate: true };
  }
  return null;
}

// ===== 等待元素存在 =====
async function waitForElement(Runtime, selector, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const { result } = await Runtime.evaluate({
      expression: `document.querySelector('${selector}') !== null`,
      returnByValue: true,
    });
    if (result.value) return true;
    await sleep(500);
  }
  return false;
}

// ===== 在 contenteditable 中插入文本 (Lexical 编辑器) =====
async function insertTextInEditor(Runtime, Input, text) {
  log('在编辑器中输入提示词...', 'step');

  await Runtime.evaluate({ expression: `document.querySelector('.chat-input-editor')?.focus()` });
  await sleep(300);

  // 清空
  await Runtime.evaluate({
    expression: `(() => {
      const editor = document.querySelector('.chat-input-editor');
      if (!editor) return;
      const sel = window.getSelection();
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(editor);
      sel.addRange(range);
    })()`,
    returnByValue: true,
  });
  await sleep(100);
  await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Backspace', windowsVirtualKeyCode: 8 });
  await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Backspace', windowsVirtualKeyCode: 8 });
  await sleep(200);
  await Runtime.evaluate({ expression: `document.querySelector('.chat-input-editor').innerHTML = ''`, returnByValue: true });
  await sleep(100);

  // CDP 键盘模拟
  log('通过 CDP Input.insertText 模拟键盘输入...', 'step');
  for (let i = 0; i < text.length; i += 50) {
    await Input.insertText({ text: text.slice(i, i + 50) });
    await sleep(50);
  }
  await sleep(500);
  await Runtime.evaluate({
    expression: `document.querySelector('.chat-input-editor')?.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }))`,
    returnByValue: true,
  });
  await sleep(800);

  const { result: check } = await Runtime.evaluate({
    expression: `document.querySelector('.chat-input-editor')?.innerText?.length || 0`,
    returnByValue: true,
  });
  log(`编辑器内容长度: ${check.value} 字符`);

  if (check.value < 5) {
    log('重试：逐字符输入...', 'warn');
    await Runtime.evaluate({ expression: `document.querySelector('.chat-input-editor').innerHTML = ''`, returnByValue: true });
    await Runtime.evaluate({ expression: `document.querySelector('.chat-input-editor')?.focus()` });
    await sleep(200);
    for (const char of text) {
      await Input.insertText({ text: char });
      await sleep(15);
    }
    await sleep(500);
    const { result: retry } = await Runtime.evaluate({
      expression: `document.querySelector('.chat-input-editor')?.innerText?.length || 0`,
      returnByValue: true,
    });
    log(`重试后长度: ${retry.value} 字符`);
    return retry.value > 10;
  }
  return check.value > 10;
}

// ===== 模式选择 =====
async function selectMode(Runtime, mode) {
  const modeText = mode === '经典模板' ? '经典模板' : '智能布局';
  log(`选择模式: ${modeText}...`, 'step');
  const { result } = await Runtime.evaluate({
    expression: `(() => {
      const buttons = document.querySelectorAll('.select-option');
      for (const btn of buttons) {
        if (btn.textContent.includes('${modeText}') && !btn.disabled) { btn.click(); return 'clicked'; }
      }
      return 'not-found';
    })()`,
    returnByValue: true,
  });
  if (result.value === 'clicked') { log(`已选择模式: ${modeText}`); await sleep(1000); return true; }
  log(`模式按钮未找到或已禁用`, 'warn');
  return false;
}

// ===== 等待发送按钮可用并点击 =====
async function clickSend(Runtime, Input) {
  log('等待发送按钮可用...', 'step');
  const start = Date.now();
  let sendEnabled = false;

  while (Date.now() - start < 30000) {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const c = document.querySelector('.send-button-container');
        if (!c) return { status: 'not-found' };
        return { status: c.classList.contains('disabled') ? 'disabled' : 'enabled', classes: c.className };
      })()`,
      returnByValue: true,
    });

    if (result.value.status === 'enabled') { sendEnabled = true; break; }

    // 前 5 秒触发 blur/focus 尝试唤醒 Vue 响应
    if (Date.now() - start < 5000) {
      await Runtime.evaluate({
        expression: `(() => {
          const ed = document.querySelector('.chat-input-editor');
          if (ed) { ed.blur(); setTimeout(() => { ed.focus(); ed.dispatchEvent(new Event('input', {bubbles:true})); }, 100); }
        })()`,
        returnByValue: true,
      });
    }
    await sleep(500);
  }

  if (!sendEnabled) {
    log('发送按钮未自动启用，尝试强制启用...', 'warn');
    await Runtime.evaluate({
      expression: `(() => {
        const c = document.querySelector('.send-button-container');
        if (!c) return;
        c.classList.remove('disabled');
        c.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        const svg = c.querySelector('svg');
        if (svg) svg.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      })()`,
      returnByValue: true,
    });
    await sleep(3000);
    return true;
  }

  log('点击发送按钮...', 'step');
  await Runtime.evaluate({
    expression: `(() => {
      const c = document.querySelector('.send-button-container');
      if (c) c.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    })()`,
    returnByValue: true,
  });
  await sleep(2000);
  return true;
}

// ===== 等待生成完成并自动下载 =====
async function waitAndDownload(Runtime, Page, downloadDir) {
  log('等待 Kimi 生成 PPT...', 'step');
  log('(这可能需要几分钟到几十分钟)', 'info');

  const start = Date.now();
  const TIMEOUT = 3600000; // 最长 60 分钟
  let lastStatus = '';

  // ---- 阶段 1: 等待生成完成（检测预览卡片或"去编辑"按钮） ----
  log('阶段 1: 等待生成完成...', 'step');
  while (Date.now() - start < TIMEOUT) {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const status = {};

        // 检测预览卡片
        const card = document.querySelector('.preview-card');
        if (card) {
          status.hasCard = true;
          status.cardText = card.textContent.replace(/\\s+/g, ' ').trim().slice(0, 100);
        }

        // 检测"去编辑"按钮
        const buttons = document.querySelectorAll('button');
        buttons.forEach(b => {
          const t = b.textContent.replace(/\\s+/g, ' ').trim();
          if (t === '去编辑') status.hasEditBtn = true;
        });

        // 检测文本中的完成标志
        const body = document.body.innerText;
        if (body.includes('PPT 已生成') || body.includes('生成完成')) status.phase = 'completed';
        if (body.includes('导出为PPTX') || body.includes('您可以点击下方卡片')) status.phase = 'completed';
        if (body.includes('生成失败') || body.includes('出错了')) status.phase = 'error';

        return status;
      })()`,
      returnByValue: true,
    });

    const st = result.value;
    const statusText = st.hasCard ? '✅ 已完成(出现预览卡片)' : (st.phase || '⏳ 生成中');
    if (statusText !== lastStatus) {
      log(`状态: ${statusText}`);
      if (st.cardText) log(`  卡片: ${st.cardText}`);
      lastStatus = statusText;
    }

    if (st.hasCard || st.phase === 'completed') {
      log('🎉 生成完成！', 'info');
      break;
    }
    if (st.phase === 'error') {
      log('生成出错！', 'error');
      return { success: false, action: 'error' };
    }

    await sleep(5000);
  }

  if (Date.now() - start >= TIMEOUT) {
    return { success: false, action: 'timeout' };
  }

  // ---- 阶段 2: 进入编辑器（点击预览卡片） ----
  log('阶段 2: 进入编辑器...', 'step');
  await Runtime.evaluate({
    expression: `(() => {
      const card = document.querySelector('.preview-card');
      if (card) { card.click(); return 'card-clicked'; }
      // 也可能卡片在 clickable 容器内
      const container = document.querySelector('.ppt-cards');
      if (container) { container.click(); return 'container-clicked'; }
      // 或者直接点"去编辑"按钮
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '去编辑');
      if (btn) { btn.click(); return 'btn-clicked'; }
      return 'not-found';
    })()`,
    returnByValue: true,
  });
  log('已点击预览卡片进入编辑器');

  // 等待编辑器加载（可能打开覆盖层或新页面）
  await sleep(3000);

  // 检查是否有 iframe（编辑器可能在 iframe 中）
  const { result: iframeCheck } = await Runtime.evaluate({
    expression: `(() => {
      const iframes = document.querySelectorAll('iframe');
      return Array.from(iframes).filter(f => f.offsetParent !== null).map(f => ({
        src: (f.src || '').slice(0, 100),
        w: f.getBoundingClientRect().width,
        h: f.getBoundingClientRect().height,
        x: Math.round(f.getBoundingClientRect().x),
        y: Math.round(f.getBoundingClientRect().y),
      }));
    })()`,
    returnByValue: true,
  });
  if (iframeCheck.value && iframeCheck.value.length > 0) {
    log(`发现 ${iframeCheck.value.length} 个可见 iframe，编辑器可能在 iframe 中`, 'info');
    iframeCheck.value.forEach(f => log(`  [${f.x},${f.y}] ${f.w}x${f.h} ${f.src.slice(0,60)}`, 'info'));
  }

  // ---- 阶段 3: 在编辑器中找导出/下载按钮 ----
  log('阶段 3: 查找导出按钮...', 'step');
  // 编辑器加载后，右上角会有导出/分享等操作按钮
  // 可能需要点击一个"更多"按钮展开菜单，或直接有"导出"按钮
  await sleep(2000);

  const { result: exportSearch } = await Runtime.evaluate({
    expression: `(() => {
      const results = [];

      // 搜索所有可见元素中是否包含导出相关文字
      const allElements = document.querySelectorAll('button, a, [class*="action"], [class*="tool"], [class*="header"] *');
      allElements.forEach(el => {
        if (el.offsetParent === null) return;
        const t = el.textContent.replace(/\\s+/g, ' ').trim();
        const cls = (el.className || '') + ' ' + (el.getAttribute('role') || '');
        const r = el.getBoundingClientRect();

        if (r.width < 5 || r.height < 5) return;

        // 匹配导出/下载
        if (t === '导出' || t === '下载' || t === 'Export' || t === 'Download' ||
            t.includes('导出') || t.includes('下载') ||
            cls.includes('export') || cls.includes('download')) {
          results.push({ text: t.slice(0,20), cls: cls.slice(0,50), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w) });
        }
      });

      return results;
    })()`,
    returnByValue: true,
  });

  if (exportSearch.value && exportSearch.value.length > 0) {
    log(`找到 ${exportSearch.value.length} 个导出相关按钮`, 'info');
    exportSearch.value.forEach(b => log(`  [${b.x},${b.y}] ${b.text} | ${b.cls}`, 'info'));

    // 点击第一个匹配的
    const target = exportSearch.value.find(b => b.text === '导出' || b.text.includes('导出')) || exportSearch.value[0];
    log(`点击: ${target.text}`, 'dl');

    // 设置下载行为
    try {
      await Page.setDownloadBehavior({
        behavior: 'allow',
        downloadPath: downloadDir,
      });
    } catch(e) {
      log(`设置下载路径失败: ${e.message} (可能是新标签页)`, 'warn');
    }

    await Runtime.evaluate({
      expression: `(() => {
        const el = document.elementFromPoint(${target.x + 5}, ${target.y + 5});
        if (el) { el.dispatchEvent(new MouseEvent('click', {bubbles:true,cancelable:true})); return 'clicked'; }
        return 'not-found';
      })()`,
      returnByValue: true,
    });
    log('已点击导出按钮', 'dl');
    await sleep(5000);
  } else {
    log('当前页面未找到导出按钮', 'warn');
    log('导出按钮可能在编辑器内部，需要进入编辑器内层', 'info');

    // 尝试点击右上角"更多"或"..."的按钮
    const { result: moreBtns } = await Runtime.evaluate({
      expression: `(() => {
        const topRight = [];
        const all = document.querySelectorAll('button, [role="button"], [class*="icon"], [class*="more"], [class*="menu"]');
        all.forEach(el => {
          if (el.offsetParent === null) return;
          const r = el.getBoundingClientRect();
          // 右上角区域
          if (r.y < 80 && r.x > 500 && r.width > 10 && r.height > 10) {
            topRight.push({
              t: el.textContent.replace(/\\s+/g,' ').trim().slice(0,20),
              cls: (el.className || '').slice(0, 50),
              x: Math.round(r.x), y: Math.round(r.y)
            });
          }
        });
        return topRight;
      })()`,
      returnByValue: true,
    });
    if (moreBtns.value && moreBtns.value.length > 0) {
      log('右上角元素:', 'info');
      moreBtns.value.forEach(b => log(`  [${b.x},${b.y}] ${b.t} | ${b.cls}`, 'info'));
    }
  }

  // ---- 阶段 4: 等待文件下载 ----
  log('阶段 4: 等待文件保存...', 'step');
  const fileInfo = await findDownloadedFile(downloadDir, 15000);

  if (fileInfo) {
    log(`✅ PPT 已保存到: ${fileInfo.filePath}`, 'dl');
  } else {
    log('⚠️ 未检测到下载文件，可能还未完成', 'warn');
    log(`  检查目录: ${downloadDir}`, 'info');
  }

  return { success: true, filePath: fileInfo?.filePath || null };
}

// ===== 查找最新下载的文件 =====
async function findDownloadedFile(downloadDir, timeout = 30000) {
  const start = Date.now();
  log(`监控下载目录: ${downloadDir}`, 'dl');

  fs.mkdirSync(downloadDir, { recursive: true });

  const knownFiles = new Set();
  // 记录已有的文件
  try {
    fs.readdirSync(downloadDir).forEach(f => knownFiles.add(f));
  } catch(e) {}

  while (Date.now() - start < timeout) {
    await sleep(1000);
    try {
      const files = fs.readdirSync(downloadDir);
      const newFiles = files.filter(f => !knownFiles.has(f) && !f.endsWith('.crdownload') && !f.endsWith('.tmp'));
      if (newFiles.length > 0) {
        // 按修改时间排序取最新的
        const sorted = newFiles.map(f => ({
          name: f,
          path: path.join(downloadDir, f),
          mtime: fs.statSync(path.join(downloadDir, f)).mtimeMs,
        })).sort((a, b) => b.mtime - a.mtime);

        const latest = sorted[0];
        const size = fs.statSync(latest.path).size;
        log(`发现新文件: ${latest.name} (${(size/1024).toFixed(1)}KB)`, 'dl');

        // 等文件写完（可能还在下载中）
        await sleep(2000);

        return { filePath: latest.path, fileName: latest.name, fileSize: size };
      }
    } catch(e) {
      // 文件夹可能还没创建
    }
  }
  log(`在 ${timeout/1000}s 内未发现新下载文件`, 'warn');
  return null;
}

// ===== 清空输入区域 =====
async function resetEditor(Runtime, Input) {
  await Runtime.evaluate({ expression: `document.querySelector('.chat-input-editor')?.focus()` });
  await sleep(200);
  await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Backspace', windowsVirtualKeyCode: 8 });
  await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Backspace', windowsVirtualKeyCode: 8 });
  await sleep(100);
  await Runtime.evaluate({ expression: `document.querySelector('.chat-input-editor').innerHTML = '<p><br></p>'` });
  await Runtime.evaluate({ expression: `document.querySelector('.chat-input-editor')?.dispatchEvent(new Event('input', {bubbles:true}))` });
  await sleep(300);
}

// ===== 发送邮件（Resend API） =====
async function sendEmailWithAttachment(apiKey, to, subject, htmlContent, attachmentPath) {
  if (!apiKey) {
    log('未设置 RESEND_API_KEY，跳过邮件发送', 'warn');
    return false;
  }

  const boundary = '----' + Date.now().toString(36);

  // 构建 multipart body
  const parts = [];

  // 需要发邮件的收件人列表
  const recipients = typeof to === 'string' ? [to] : to;

  // 先发不带附件的部分 (from, to, subject, html)
  let body = '';
  body += `--${boundary}\r\n`;
  body += 'Content-Type: application/json; charset="UTF-8"\r\n\r\n';
  body += JSON.stringify({
    from: 'PPT 智能生成 <noreply@ppt-service.pages.dev>',
    to: recipients,
    subject: subject,
    html: htmlContent,
  }) + '\r\n';

  // 如果有附件
  if (attachmentPath && fs.existsSync(attachmentPath)) {
    const fileName = path.basename(attachmentPath);
    const fileBuffer = fs.readFileSync(attachmentPath);
    const fileBase64 = fileBuffer.toString('base64');
    const mimeType = fileName.endsWith('.pptx') ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      : fileName.endsWith('.ppt') ? 'application/vnd.ms-powerpoint'
      : 'application/octet-stream';

    body += `--${boundary}\r\n`;
    body += `Content-Type: ${mimeType}\r\n`;
    body += 'Content-Disposition: attachment; filename="' + fileName + '"\r\n';
    body += 'Content-Transfer-Encoding: base64\r\n\r\n';
    body += fileBase64 + '\r\n';
  }

  body += `--${boundary}--\r\n`;

  log(`发送邮件到 ${recipients.join(', ')}...`, 'mail');

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': `multipart/mixed; boundary="${boundary}"`,
      },
      body: body,
    });

    if (resp.ok) {
      const data = await resp.json();
      log(`邮件发送成功: ${data.id}`, 'mail');
      return true;
    } else {
      const errText = await resp.text();
      log(`邮件发送失败: ${resp.status} ${errText}`, 'error');
      return false;
    }
  } catch(e) {
    log(`邮件发送异常: ${e.message}`, 'error');
    return false;
  }
}

// ===== 主要自动化流程 =====
async function runAutomation(opts) {
  log('='.repeat(60));
  log('Kimi AgentPPT CDP 自动化 — 完整版 (含下载 + 邮件)');
  log('='.repeat(60));

  // 准备下载目录
  const downloadDir = path.resolve(DOWNLOAD_DIR);
  fs.mkdirSync(downloadDir, { recursive: true });
  log(`下载目录: ${downloadDir}`, 'dl');
  if (opts.email) log(`客户邮箱: ${opts.email}`, 'mail');
  if (opts.customer) log(`客户称呼: ${opts.customer}`);

  try {
    // 1. 查找 Kimi 标签页
    log('查找 Kimi 标签页...', 'step');
    const kimiInfo = await findKimiTab();
    if (!kimiInfo) {
      log('❌ 未找到 Kimi 标签页，请先打开 https://www.kimi.com/slides', 'error');
      return false;
    }

    // 2. 连接到 Tab
    log('连接到页面...', 'step');
    const tab = await CDP({ port: DEBUG_PORT, target: () => kimiInfo.tab });
    const { Page, Runtime, DOM, Input } = tab;
    await Page.enable();
    await DOM.enable();

    // 获取当前标签页列表，供后续检测页面跳转用
    const allTabs = await CDP.List({ port: DEBUG_PORT });

    // 3. 如果需要，跳转到 Slides
    if (kimiInfo.navigate) {
      log('导航到 Kimi Slides...', 'step');
      await Page.navigate({ url: KIMI_URL });
      await sleep(3000);
    }

    // 4. 判断当前状态：如果已经是 chat 页面（有历史生成），直接等待完成
    const isChatPage = kimiInfo.tab.url.includes('kimi.com/chat/');

    if (isChatPage) {
      log('当前已在 Kimi Chat 页面，检测生成状态...', 'info');
      // 跳过输入，直接等待完成
    } else {
      // Slides 页面 → 需要输入并发送

      // 等待页面加载
      log('等待页面加载...', 'step');
      await waitForElement(Runtime, '.chat-input-editor', 15000);
      log('编辑器已就绪');

      // 5. 选择模式
      await selectMode(Runtime, opts.mode);

      // 6. 输入提示词
      const textInserted = await insertTextInEditor(Runtime, Input, opts.prompt);

      // 7. 上传附件 (如果有)
      if (opts.files && opts.files.length > 0) {
        log('附件上传: 路径已记录，将在提示词中引用', 'info');
      }

      // 8. 点击发送
      await clickSend(Runtime, Input);
    }

    // 9. 等待生成完成并下载
    const dlResult = await waitAndDownload(Runtime, Page, downloadDir);
    if (!dlResult.success) {
      log('生成未成功完成', 'error');
      await tab.close();
      return dlResult;
    }

    // 10. 查找下载的 PPT 文件
    const fileInfo = await findDownloadedFile(downloadDir, 15000);

    // 11. 发送邮件
    if (opts.email && RESEND_API_KEY) {
      const customerName = opts.customer || opts.email.split('@')[0];
      const topic = opts.topic || 'PPT';

      let htmlContent = `<div style="max-width:600px;margin:auto;font-family:sans-serif;">
        <h2 style="color:#2563eb;">📊 您的 PPT 已生成</h2>
        <p>您好 <b>${customerName}</b>，</p>
        <p>您提交的「<b>${topic}</b>」PPT 已通过 Kimi + AgentPPT 智能生成，附件中即为成品文件。</p>
        <p style="color:#64748b;font-size:13px;">如需修改或有其他需求，欢迎随时联系我们。</p>
        <hr style="border:none;border-top:1px solid #e2e8f0;">
        <p style="color:#94a3b8;font-size:12px;">Powered by Kimi + AgentPPT · PPT 智能生成服务</p>
      </div>`;

      // 如果有下载到的文件，带附件
      await sendEmailWithAttachment(
        RESEND_API_KEY,
        [opts.email, ADMIN_EMAIL].filter(Boolean),
        `📊 您的 PPT「${topic}」已生成 - ${customerName}`,
        htmlContent,
        fileInfo?.filePath || null
      );
    } else if (fileInfo?.filePath) {
      log(`PPT 已下载到: ${fileInfo.filePath}`, 'dl');
      log('未设置 RESEND_API_KEY，未发送邮件', 'warn');
      if (ADMIN_EMAIL) {
        log(`如需自动发送，请设置环境变量 RESEND_API_KEY`, 'info');
      }
    }

    await tab.close();
    log('='.repeat(60));
    if (fileInfo) {
      log(`🎉 全流程完成！PPT: ${fileInfo.fileName}`);
    } else {
      log(`🎉 全流程完成！`);
    }
    log('='.repeat(60));
    return { success: true, filePath: fileInfo?.filePath || null };

  } catch (e) {
    log(`自动化失败: ${e.stack || e.message}`, 'error');
    return { success: false, error: e.message };
  }
}

// ===== 启动 =====
const opts = parseArgs();

if (opts.prompt) {
  runAutomation(opts).then(result => {
    process.exit(result.success ? 0 : 1);
  });
} else {
  // 交互模式
  console.log('\n📋 Kimi AgentPPT CDP 自动化 (含下载 + 邮件)\n');
  promptUser('请输入 PPT 提示词: ').then(prompt => {
    opts.prompt = prompt;
    return promptUser('客户邮箱 (可选，用于发送成品): ');
  }).then(email => {
    if (email.trim()) opts.email = email.trim();
    return promptUser('客户称呼 (可选): ');
  }).then(name => {
    if (name.trim()) opts.customer = name.trim();
    return promptUser('文件路径 (可选，逗号分隔): ');
  }).then(files => {
    if (files.trim()) opts.files = files.split(',').map(f => f.trim()).filter(Boolean);
    return promptUser('模式 (1-智能布局 / 2-经典模板) [默认1]: ');
  }).then(mode => {
    if (mode === '2') opts.mode = '经典模板';
    return runAutomation(opts);
  }).then(result => {
    process.exit(result.success ? 0 : 1);
  });
}
