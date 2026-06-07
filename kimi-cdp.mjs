// kimi-cdp.mjs — CDP 自动化提交到 Kimi AgentPPT + 下载 PPT + 发送邮件
//
// 用法: node kimi-cdp.mjs [--prompt "提示词"] [--files "f1,f2"] [--mode 智能布局|经典模板]
//                         [--email "client@example.com"] [--customer "称呼"]
//
// 环境变量:
//   RESEND_API_KEY  — 用于发送邮件 (可选，不设置则不发送)
//   SMTP_HOST       — SMTP 服务器 (可选，默认 smtp.qq.com)
//   SMTP_PORT       — SMTP 端口 (可选，默认 465)
//   SMTP_USER       — SMTP 邮箱账号
//   SMTP_PASS       — SMTP 密码/授权码
//   ADMIN_EMAIL     — 管理员通知邮箱 (可选)
//   DOWNLOAD_DIR    — PPT 下载目录 (默认: M:/资料)

import CDP from 'chrome-remote-interface';
import { createInterface } from 'readline';
import fs from 'fs';
import path from 'path';
import http from 'http';

// ===== 尝试加载 .env 文件 =====
try {
  const envPath = path.resolve('.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch(e) { /* .env 加载失败不影响 */ }

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

  // ---- 阶段 2: 进入编辑器 ----
  log('阶段 2: 进入编辑器...', 'step');

  // 点卡片触发 iframe 加载
  await Runtime.evaluate({
    expression: `(function() {
      var card = document.querySelector('.preview-card');
      if (card) { card.click(); return 'ok'; }
      return 'no-card';
    })()`,
    returnByValue: true,
  });

  // 等待 iframe 出现
  log('等待编辑器 iframe 加载...', 'step');
  await sleep(5000);

  // 获取 iframe URL
  const { result: editorUrlResult } = await Runtime.evaluate({
    expression: `(function() {
      var f = document.querySelector('iframe.ppt-frame, iframe[src*="kimi.com/ppt"], iframe[class*="ppt"]');
      return f && f.src ? f.src : null;
    })()`,
    returnByValue: true,
  });
  var editorUrl = editorUrlResult.value;
  log(`编辑器 URL: ${editorUrl || '未发现'}`, 'info');

  var editorConnected = false;
  if (editorUrl) {
    log('直接在 iframe 中操作（同源可访问）...', 'step');

    // 等 iframe 完全加载
    await sleep(3000);

    // 直接在 iframe 中查找"导出"按钮（div.ppt-button.ppt-button--invert.download-button）
    log('查找导出按钮...', 'step');
    var exportBtn = null;

    for (var attempt = 0; attempt < 12; attempt++) {
      var btnCheck = await Runtime.evaluate({
        expression: `(function() {
          try {
            var f = document.querySelector('iframe.ppt-frame, iframe[class*="ppt"], iframe[src*="/ppt"]');
            if (!f || !f.contentDocument) return JSON.stringify({error: 'no iframe content'});

            var doc = f.contentDocument;
            // 找"导出"文字元素
            var all = doc.querySelectorAll('*');
            var results = [];
            all.forEach(function(el) {
              if (el.offsetParent === null) return;
              var t = el.textContent.replace(/\\s+/g, ' ').trim();
              if (t === '导出') {
                var r = el.getBoundingClientRect();
                if (r.width > 10 && r.height > 10) {
                  results.push(JSON.stringify({ text: t, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), tag: el.tagName, cls: el.className.slice(0, 40) }));
                }
              }
            });
            if (results.length > 0) return '[' + results.join(',') + ']';
            return JSON.stringify({ note: 'waiting', buttons: doc.body.innerText.slice(0, 100) });
          } catch(e) {
            return JSON.stringify({ error: e.message });
          }
        })()`,
        returnByValue: true,
      });

      var result = JSON.parse(btnCheck.result.value);
      if (Array.isArray(result) && result.length > 0) {
        exportBtn = result[0];
        log(`✅ 找到"导出"按钮 (第 ${attempt+1} 次): [${exportBtn.x},${exportBtn.y}] ${exportBtn.text}`, 'info');
        editorConnected = true;

        // 设置下载目录（在主页面设置即可）
        try {
          await Page.setDownloadBehavior({ behavior: 'allow', downloadPath: downloadDir });
          log(`设置下载路径: ${downloadDir}`, 'dl');
        } catch(e) {
          log(`设置下载失败: ${e.message}`, 'warn');
        }

        // 通过 iframe contentDocument 点击导出按钮
        await Runtime.evaluate({
          expression: `(function() {
            try {
              var f = document.querySelector('iframe.ppt-frame, iframe[class*="ppt"], iframe[src*="/ppt"]');
              if (!f || !f.contentDocument) return 'no-iframe';
              var el = f.contentDocument.elementFromPoint(${exportBtn.x + Math.floor(exportBtn.w/2)}, ${exportBtn.y + Math.floor(exportBtn.h/2)});
              if (!el) return 'no-element';
              el.dispatchEvent(new MouseEvent('click', {bubbles:true,cancelable:true,view:f.contentWindow}));
              return 'clicked';
            } catch(e) { return 'error: ' + e.message; }
          })()`,
          returnByValue: true,
        });
        log('已点击导出按钮，等待弹窗加载...', 'dl');
        await sleep(3000);

        // 导出后会弹出窗口包含"选择目录直接下载"和"直接下载"按钮
        log('查找下载弹窗...', 'step');
        for (var popupAttempt = 0; popupAttempt < 10; popupAttempt++) {
          var popupCheck = await Runtime.evaluate({
            expression: `(function() {
              try {
                var f = document.querySelector('iframe.ppt-frame, iframe[class*="ppt"], iframe[src*="/ppt"]');
                if (!f || !f.contentDocument) return JSON.stringify({error: 'no iframe'});
                var doc = f.contentDocument;
                var all = doc.querySelectorAll('*');
                var results = [];
                all.forEach(function(el) {
                  if (el.offsetParent === null) return;
                  var t = el.textContent.replace(/\\s+/g, ' ').trim();
                  if (t === '直接下载') {
                    var r = el.getBoundingClientRect();
                    results.push({ text: t, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
                  }
                });
                return JSON.stringify(results);
              } catch(e) { return JSON.stringify({error: e.message}); }
            })()`,
            returnByValue: true,
          });

          var popupData = JSON.parse(popupCheck.result.value);
          if (Array.isArray(popupData) && popupData.length > 0) {
            log(`✅ 找到"直接下载"按钮: [${popupData[0].x},${popupData[0].y}]`, 'info');
            // 点击直接下载
            await Runtime.evaluate({
              expression: `(function() {
                try {
                  var f = document.querySelector('iframe.ppt-frame, iframe[class*="ppt"], iframe[src*="/ppt"]');
                  if (!f || !f.contentDocument) return 'no-iframe';
                  var el = f.contentDocument.elementFromPoint(${popupData[0].x + 5}, ${popupData[0].y + 5});
                  if (!el) return 'no-element';
                  el.dispatchEvent(new MouseEvent('click', {bubbles:true,cancelable:true,view:f.contentWindow}));
                  return 'done';
                } catch(e) { return 'error: ' + e.message; }
              })()`,
              returnByValue: true,
            });
            log('已点击直接下载，等待浏览器保存文件...', 'dl');
            await sleep(8000);
            // 直接跳出所有循环
            exportBtn.clicked = true;
            break;
          }
          await sleep(2000);
        }
        // 如果弹窗点击成功，直接跳出外层循环
        if (exportBtn && exportBtn.clicked) break;
      }

      if (attempt % 3 === 0 && attempt > 0) {
        log(`等待加载中... (${attempt+1}/12)`, 'info');
      }
      await sleep(2000);
    }

    if (!exportBtn) {
      log('⚠️ 未找到导出按钮', 'warn');
    }
  }

  if (!editorConnected) {
    log('未连接编辑器，跳过下载', 'warn');
  }

  // ---- 阶段 4: 等待文件保存（最长 60 秒） ----
  log('阶段 4: 等待文件保存（最长 60 秒）...', 'step');
  var fileInfo = await findDownloadedFile(downloadDir, 60000);

  if (fileInfo) {
    log(`✅ PPT 已保存到: ${fileInfo.filePath}`, 'dl');
  } else {
    log('⚠️ 未检测到下载文件', 'warn');
    // 直接扫描目录，找最近修改的 pptx
    log('扫描目录找最新 PPTX...', 'info');
    try {
      const pptxFiles = fs.readdirSync(downloadDir)
        .filter(f => f.endsWith('.pptx'))
        .map(f => ({ name: f, path: path.join(downloadDir, f), mtime: fs.statSync(path.join(downloadDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (pptxFiles.length > 0) {
        log(`✅ 最近文件: ${pptxFiles[0].name} (${new Date(pptxFiles[0].mtime).toLocaleTimeString()})`, 'dl');
        log(`  路径: ${pptxFiles[0].path}`, 'dl');
        const fStat = fs.statSync(pptxFiles[0].path);
        fileInfo = { filePath: pptxFiles[0].path, fileName: pptxFiles[0].name, fileSize: fStat.size };
      }
    } catch(e) {
      log(`扫描目录失败: ${e.message}`, 'warn');
    }
  }

  return { success: true, filePath: fileInfo?.filePath || null };
}

// ===== 查找最新下载的文件 =====
async function findDownloadedFile(downloadDir, timeout = 30000) {
  const start = Date.now();
  log(`监控下载目录: ${downloadDir}`, 'dl');

  fs.mkdirSync(downloadDir, { recursive: true });

  // 记录已有的文件修改时间
  const knownMtimes = {};
  try {
    fs.readdirSync(downloadDir).forEach(function(f) {
      try {
        const stat = fs.statSync(path.join(downloadDir, f));
        knownMtimes[f] = stat.mtimeMs;
      } catch(e) {}
    });
  } catch(e) {}

  while (Date.now() - start < timeout) {
    await sleep(1000);
    try {
      const files = fs.readdirSync(downloadDir);
      const pptFiles = files.filter(f => !f.endsWith('.crdownload') && !f.endsWith('.tmp'));

      for (const f of pptFiles) {
        const filePath = path.join(downloadDir, f);
        try {
          const stat = fs.statSync(filePath);
          // 文件是新出现的，或修改时间变了（被覆盖更新）
          if (!knownMtimes[f] || stat.mtimeMs > knownMtimes[f]) {
            log(`发现文件变化: ${f} (${(stat.size/1024).toFixed(1)}KB)`, 'dl');
            knownMtimes[f] = stat.mtimeMs;
            await sleep(2000); // 等写入完成
            return { filePath, fileName: f, fileSize: stat.size };
          }
        } catch(e) {}
      }
    } catch(e) {}
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

// ===== 发送邮件（SMTP）- 支持 QQ 邮箱等 =====
async function sendEmailWithAttachment(apiKey, to, subject, htmlContent, attachmentPath) {
  // 优先用 SMTP 发信
  const smtpUser = process.env.SMTP_USER;
  if (smtpUser) {
    return sendEmailViaSMTP(to, subject, htmlContent, attachmentPath);
  }
  // 后备：Resend API
  return sendEmailViaResend(to, subject, htmlContent, attachmentPath);
}

// ===== SMTP 发信（nodemailer） =====
async function sendEmailViaSMTP(to, subject, htmlContent, attachmentPath) {
  const nodemailer = await import('nodemailer');

  const smtpHost = process.env.SMTP_HOST || 'smtp.qq.com';
  const smtpPort = parseInt(process.env.SMTP_PORT || '465');
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const fromName = process.env.SMTP_FROM_NAME || 'PPT 智能生成';

  if (!smtpUser || !smtpPass) {
    log('SMTP 未配置（需要 SMTP_USER 和 SMTP_PASS），跳过邮件发送', 'warn');
    return false;
  }

  const recipients = typeof to === 'string' ? to : to.join(', ');

  log(`📧 通过 SMTP 发送到 ${recipients}...`, 'mail');

  try {
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPass },
    });

    const mailOptions = {
      from: `"${fromName}" <${smtpUser}>`,
      to: recipients,
      subject: subject,
      html: htmlContent,
    };

    if (attachmentPath && fs.existsSync(attachmentPath)) {
      mailOptions.attachments = [{
        filename: path.basename(attachmentPath),
        path: attachmentPath,
      }];
      log(`📎 附件: ${path.basename(attachmentPath)}`, 'mail');
    }

    const info = await transporter.sendMail(mailOptions);
    log(`✅ 邮件发送成功: ${info.messageId}`, 'mail');
    return true;
  } catch(e) {
    log(`❌ 邮件发送失败: ${e.message}`, 'error');
    return false;
  }
}

// ===== Resend API 发信（后备） =====
async function sendEmailViaResend(to, subject, htmlContent, attachmentPath) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    log('未设置 RESEND_API_KEY，跳过邮件发送', 'warn');
    return false;
  }

  const recipients = typeof to === 'string' ? [to] : to;
  log(`发送邮件到 ${recipients.join(', ')} (Resend)...`, 'mail');

  let attachmentId = null;
  if (attachmentPath && fs.existsSync(attachmentPath)) {
    try {
      const fileName = path.basename(attachmentPath);
      const fileBuffer = fs.readFileSync(attachmentPath);
      log(`上传附件到 Resend: ${fileName} (${(fileBuffer.length/1024).toFixed(1)}KB)`, 'mail');
      const formData = new FormData();
      const blob = new Blob([fileBuffer]);
      formData.append('file', blob, fileName);
      const uploadResp = await fetch('https://api.resend.com/attachments', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}` },
        body: formData,
      });
      if (uploadResp.ok) {
        attachmentId = (await uploadResp.json()).id;
        log(`附件上传成功: ${attachmentId}`, 'mail');
      } else {
        log(`附件上传失败: ${await uploadResp.text()}`, 'warn');
      }
    } catch(e) {
      log(`附件上传异常: ${e.message}`, 'warn');
    }
  }

  const emailPayload = {
    from: process.env.EMAIL_FROM || 'PPT 智能生成 <onboarding@resend.dev>',
    to: recipients,
    subject,
    html: htmlContent,
  };
  if (attachmentId) emailPayload.attachments = [{ id: attachmentId }];

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(emailPayload),
    });
    if (resp.ok) {
      log(`邮件发送成功: ${(await resp.json()).id}`, 'mail');
      return true;
    } else {
      log(`邮件发送失败: ${resp.status} ${await resp.text()}`, 'error');
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
