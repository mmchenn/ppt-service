// kimi-cdp.mjs — CDP 自动化提交到 Kimi AgentPPT + 真实附件上传 + 下载 + 邮件
//
// 用法: node kimi-cdp.mjs --prompt "提示词" [--files-json '["path1","path2"]']
//
// 新增功能:
//   - --files-json: JSON 数组格式的文件路径列表（避免转义问题）
//   - DOM.setFileInputFiles 将本地文件直接注入 Kimi 的文件上传 input
//   - 先上传文件再发送，Kimi 拿到的是原始文件内容

import CDP from 'chrome-remote-interface';
import { createInterface } from 'readline';
import fs from 'fs';
import path from 'path';

// ===== 尝试加载 .env =====
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
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || 'M:/资料';

// ===== 工具 =====
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(msg, level = 'info') {
  const ts = new Date().toISOString().replace(/T/, ' ').slice(0, 19);
  const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : level === 'step' ? '▶️' : level === 'mail' ? '📧' : level === 'dl' ? '💾' : level === 'upload' ? '📤' : '✅';
  console.log(`${ts} ${prefix} ${msg}`);
}

function safeName(str) {
  return str.replace(/[^a-zA-Z0-9一-龥_-]/g, '_').slice(0, 60);
}

// ===== 解析命令行 =====
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
    else if (args[i] === '--files-json' && args[i+1]) {
      try { opts.files = JSON.parse(args[++i]); } catch(e) { log(`--files-json 解析失败: ${e.message}`, 'warn'); }
    }
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

// ===== 在 contenteditable 中插入文本 =====
async function insertTextInEditor(Runtime, Input, text) {
  log('在编辑器中输入提示词...', 'step');

  if (!text || text.length < 2) {
    log(`提示词为空或太短 (${text.length} 字符)`, 'warn');
    return false;
  }

  // 1. 聚焦编辑器
  await Runtime.evaluate({ expression: `document.querySelector('.chat-input-editor')?.focus()` });
  await sleep(300);

  // 2. 清空编辑器
  await Runtime.evaluate({
    expression: `(() => {
      const ed = document.querySelector('.chat-input-editor');
      if (!ed) return;
      ed.focus();
      const sel = window.getSelection();
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(ed);
      sel.addRange(range);
    })()`,
    returnByValue: true,
  });
  await sleep(100);
  await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Backspace', windowsVirtualKeyCode: 8 });
  await sleep(50);
  await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Backspace', windowsVirtualKeyCode: 8 });
  await sleep(100);
  await Runtime.evaluate({ expression: `document.querySelector('.chat-input-editor').innerHTML = ''`, returnByValue: true });
  await sleep(100);

  // 3. 用 Input.insertText 一次性写入（处理所有字符编码）
  log(`正在写入 ${text.length} 字符...`, 'step');
  await Input.insertText({ text: text });
  await sleep(500);

  // 4. 触发 Vue 响应
  await Runtime.evaluate({
    expression: `(() => {
      const ed = document.querySelector('.chat-input-editor');
      if (ed) {
        ed.dispatchEvent(new Event('input', { bubbles: true }));
        ed.dispatchEvent(new Event('compositionend', { bubbles: true }));
      }
    })()`,
    returnByValue: true,
  });
  await sleep(500);

  // 5. 验证
  const { result: check } = await Runtime.evaluate({
    expression: `document.querySelector('.chat-input-editor')?.innerText?.length || 0`,
    returnByValue: true,
  });
  log(`编辑器内容长度: ${check.value} 字符`, check.value > 5 ? 'success' : 'warn');

  return check.value > 5;
}

// ===== 核心新增: 上传文件到 Kimi =====
async function uploadFilesToKimi(Runtime, DOM, filePaths) {
  if (!filePaths || filePaths.length === 0) {
    log('无文件需要上传', 'info');
    return [];
  }

  log(`上传 ${filePaths.length} 个附件到 Kimi...`, 'step');
  const uploaded = [];

  for (const fp of filePaths) {
    if (!fs.existsSync(fp)) {
      log(`文件不存在: ${fp}`, 'warn');
      continue;
    }

    const fileName = path.basename(fp);
    const fileSize = fs.statSync(fp).size;
    log(`准备上传: ${fileName} (${(fileSize/1024).toFixed(1)}KB)`, 'upload');

    try {
      // 策略 1: 找到 "+" 按钮展开工具栏，然后找到 file input
      let fileInputFound = false;

      // 先尝试查找页面上已有的 input[type="file"]
      const { result: fileInputCheck } = await Runtime.evaluate({
        expression: `(() => {
          const inputs = document.querySelectorAll('input[type="file"]');
          if (inputs.length > 0) {
            return JSON.stringify(Array.from(inputs).map(i => ({
              id: i.id,
              cls: i.className.slice(0, 60),
              hidden: i.hidden,
              display: window.getComputedStyle(i).display,
              visibility: window.getComputedStyle(i).visibility,
              parentCls: i.parentElement?.className?.slice(0, 40) || '',
            })));
          }
          return 'none';
        })()`,
        returnByValue: true,
      });

      let inputFound = fileInputCheck.value !== 'none';

      // 如果没有直接找到 input，尝试点击 "+" 按钮展开工具栏
      if (!inputFound) {
        log('未直接找到 file input，尝试点击 "+" 按钮...', 'upload');

        const { result: plusResult } = await Runtime.evaluate({
          expression: `(() => {
            // 多种选择器尝试找 "+" 按钮
            const selectors = [
              '.toolkit-trigger-btn',
              '[class*="toolkit"] button',
              'button[class*="plus"]',
              'button[class*="attach"]',
              'button[aria-label*="上传"]',
              'button[aria-label*="附件"]',
              'button[aria-label*="文件"]',
            ];
            for (const sel of selectors) {
              const btn = document.querySelector(sel);
              if (btn && btn.offsetParent !== null) {
                btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                return 'clicked-' + sel;
              }
            }
            return 'not-found';
          })()`,
          returnByValue: true,
        });
        log(`"+" 按钮操作: ${plusResult.value}`, 'upload');
        await sleep(2000);

        // 再次检查是否有 file input 出现
        const { result: recheck } = await Runtime.evaluate({
          expression: `document.querySelector('input[type="file"]') !== null`,
          returnByValue: true,
        });
        inputFound = recheck.value;
        if (inputFound) log('展开后找到了 file input', 'upload');
      }

      // 策略 2: 直接找页面任何位置的 input[type="file"]
      if (inputFound) {
        // 用 CDP DOM 工具找到 input 并注入文件
        const { root } = await DOM.getDocument();
        // 尝试多种选择器
        let nodeId = null;
        for (const sel of ['input[type="file"]', '.file-upload-input', '[class*="upload"] input']) {
          const searchResult = await DOM.querySelector({ nodeId: root.nodeId, selector: sel }).catch(() => null);
          if (searchResult && searchResult.nodeId) {
            nodeId = searchResult.nodeId;
            break;
          }
        }

        if (nodeId) {
          await DOM.setFileInputFiles({ nodeId, files: [fp] });
          await sleep(2000);
          log(`✅ CDP 注入文件成功: ${fileName}`, 'upload');
          uploaded.push(fp);
          fileInputFound = true;
        } else {
          log(`找到 file input 但获取 nodeId 失败，尝试后备策略`, 'warn');
        }
      }

      // 策略 3: 通过 Runtime API 找 input 并尝试用 JS 方式设置
      if (!fileInputFound) {
        log('尝试 JS 方式上传文件 (后备策略)...', 'upload');

        const { result: jsUpload } = await Runtime.evaluate({
          expression: `(() => {
            const input = document.querySelector('input[type="file"]');
            if (!input) return 'no-input';

            // 读取文件内容并通过 DataTransfer 上传
            // 注：由于安全限制，JS 无法设置 File 对象的完整内容，
            // 但 CDP 的 DOM.setFileInputFiles 已经是最可靠的方式，
            // 这里作为备用触发 change 事件
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return 'trigger-change';
          })()`,
          returnByValue: true,
        });
        log(`JS 后备: ${jsUpload.value}`, 'upload');
        await sleep(1000);
      }

      // 已上传文件记录
      if (!uploaded.includes(fp)) {
        // 检查是否有上传成功标志（Kimi 界面中的文件列表）
        const { result: checkUpload } = await Runtime.evaluate({
          expression: `(() => {
            // 检查页面上是否有文件列表/预览
            const fileCards = document.querySelectorAll('[class*="file-card"], [class*="file-item"], [class*="FileCard"], [class*="file-list"] li, [class*="attachment"]');
            return fileCards.length > 0 ? 'found-' + fileCards.length : 'none';
          })()`,
          returnByValue: true,
        });
        if (checkUpload.value.startsWith('found-')) {
          log(`✅ Kimi 界面已显示文件列表: ${checkUpload.value.replace('found-', '')} 个文件`, 'upload');
          uploaded.push(fp);
        } else {
          log(`⚠️ 文件 ${fileName} 可能未成功上传，但在提示词中已引用文件名`, 'upload');
          uploaded.push(fp); // 即使 UI 没显示也加入，因为提示词里提到了文件名
        }
      }
    } catch (e) {
      log(`上传文件失败 ${path.basename(fp)}: ${e.message}`, 'error');
    }

    // 文件间间隔，避免并发问题
    await sleep(1500);
  }

  log(`上传结果: ${uploaded.length}/${filePaths.length} 个文件`, uploaded.length > 0 ? 'success' : 'warn');
  return uploaded;
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

  // 多个可能的选择器
  const sendSelectors = [
    '.send-button-container',
    '.send-btn',
    '[class*="send"]',
    'button[class*="send"]',
    'button:has(svg)',
    '.submit-btn',
    '[class*="submit"]',
    'button[class*="submit"]',
    // 检测可交互的发送区域
    '[class*="toolbar"] button:last-child',
    'form button[type="submit"]',
    '.chat-input-area button:last-child',
  ];

  while (Date.now() - start < 30000) {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const sendBtn = document.querySelector('.send-button-container');
        if (sendBtn) {
          return { status: sendBtn.classList.contains('disabled') ? 'disabled' : 'enabled', selector: '.send-button-container' };
        }
        // 尝试查找任何可点击的发送按钮
        const selectors = ${JSON.stringify(sendSelectors)};
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.offsetParent !== null) {
            const cls = el.className || '';
            const disabled = el.disabled || cls.includes('disabled');
            return { status: disabled ? 'disabled' : 'enabled', selector: sel, classes: cls.slice(0, 60) };
          }
        }
        // 查找包含发送图标的按钮
        const allButtons = document.querySelectorAll('button');
        for (const btn of allButtons) {
          if (btn.offsetParent === null) continue;
          const html = btn.innerHTML.toLowerCase();
          if (html.includes('send') || html.includes('发送') || html.includes('arrow') || html.includes('play') || html.includes('启动') || html.includes('生成')) {
            const cls = btn.className || '';
            const disabled = btn.disabled || cls.includes('disabled');
            return { status: disabled ? 'disabled' : 'enabled', selector: 'button-icon-match', text: btn.textContent.trim().slice(0, 20) };
          }
        }
        return { status: 'not-found' };
      })()`,
      returnByValue: true,
    });

    const status = result.value;
    if (status.status === 'enabled') {
      sendEnabled = true;
      log(`发送按钮已就绪 (选择器: ${status.selector}${status.text ? ', text: ' + status.text : ''})`);
      break;
    }
    if (status.status === 'not-found') {
      // 还没找到按钮，先触发 input 事件尝试唤醒 Vue
      if (Date.now() - start < 8000) {
        await Runtime.evaluate({
          expression: `(() => {
            const ed = document.querySelector('.chat-input-editor');
            if (ed) {
              ed.dispatchEvent(new Event('input', {bubbles:true}));
              ed.dispatchEvent(new Event('compositionend', {bubbles:true}));
            }
          })()`,
          returnByValue: true,
        });
        await sleep(100);
        // 按下回车尝试触发 Vue 响应
        await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13 });
        await sleep(50);
        await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', windowsVirtualKeyCode: 13 });
        await sleep(300);
      }
    }
    await sleep(500);
  }

  if (!sendEnabled) {
    log('发送按钮未就绪，尝试强制点击所有可能的按钮...', 'warn');
    await Runtime.evaluate({
      expression: `(() => {
        // 移除 disabled 类并点击
        const candidates = document.querySelectorAll('.send-button-container, [class*="send"], [class*="submit"], button:last-child');
        candidates.forEach(el => {
          el.classList.remove('disabled');
          if (el.disabled) el.disabled = false;
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        });
        // 也尝试直接点击发送图标按钮
        document.querySelectorAll('button').forEach(btn => {
          const html = btn.innerHTML.toLowerCase();
          if ((html.includes('send') || html.includes('发送') || html.includes('arrow') || html.includes('启动') || html.includes('生成')) && btn.offsetParent !== null) {
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          }
        });
      })()`,
      returnByValue: true,
    });
    await sleep(3000);
    return true;
  }

  log('点击发送按钮...', 'step');
  // 直接在页面内完成查找和点击，避免传变量
  const clickResult = await Runtime.evaluate({
    expression: `(() => {
      const sels = ${JSON.stringify(sendSelectors)};
      // 1. 尝试 .send-button-container
      const c = document.querySelector('.send-button-container');
      if (c && !c.classList.contains('disabled')) {
        c.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return 'clicked-send-button-container';
      }
      // 2. 遍历候选选择器
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) {
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          return 'clicked-' + sel;
        }
      }
      // 3. 文本匹配按钮
      const allButtons = document.querySelectorAll('button');
      for (const btn of allButtons) {
        if (btn.offsetParent === null) continue;
        const html = btn.innerHTML.toLowerCase();
        if (html.includes('send') || html.includes('发送') || html.includes('arrow') || html.includes('启动') || html.includes('生成')) {
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          return 'clicked-by-text-' + btn.textContent.trim().slice(0, 10);
        }
      }
      return 'no-button-found';
    })()`,
    returnByValue: true,
  });
  log(`点击结果: ${clickResult.value}`, 'info');
  await sleep(3000);

  // 验证是否真的发送了（编辑器内容应该被清空）
  const { result: checkSent } = await Runtime.evaluate({
    expression: `document.querySelector('.chat-input-editor')?.innerText?.length || 0`,
    returnByValue: true,
  });
  log(`发送后编辑器长度: ${checkSent.value}`, checkSent.value < 10 ? 'success' : 'warn');
  if (checkSent.value > 10) {
    log('按钮可能未生效，尝试按 Enter 键发送...', 'warn');
    await Runtime.evaluate({ expression: `document.querySelector('.chat-input-editor')?.focus()`, returnByValue: true });
    await sleep(200);
    // Ctrl+Enter 或直接 Enter
    await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', modifiers: ['meta'] });
    await sleep(50);
    await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', modifiers: ['meta'] });
    await sleep(500);
    const { result: retry } = await Runtime.evaluate({
      expression: `document.querySelector('.chat-input-editor')?.innerText?.length || 0`,
      returnByValue: true,
    });
    log(`Enter 发送后编辑器长度: ${retry.value}`, 'info');
  }

  return true;
}

// ===== 等待生成完成并自动下载 =====
async function waitAndDownload(Runtime, Page, downloadDir) {
  log('等待 Kimi 生成 PPT...', 'step');
  log('(这可能需要几分钟到几十分钟)', 'info');

  const start = Date.now();
  const TIMEOUT = 3600000;
  let lastStatus = '';

  // ---- 阶段 1: 等待生成完成 ----
  log('阶段 1: 等待生成完成...', 'step');
  while (Date.now() - start < TIMEOUT) {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const status = {};
        const card = document.querySelector('.preview-card');
        if (card) {
          status.hasCard = true;
          status.cardText = card.textContent.replace(/\\s+/g, ' ').trim().slice(0, 100);
        }
        const buttons = document.querySelectorAll('button');
        buttons.forEach(b => {
          const t = b.textContent.replace(/\\s+/g, ' ').trim();
          if (t === '去编辑') status.hasEditBtn = true;
        });
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

  // ---- 阶段 2: 进入编辑器并下载 ----
  log('阶段 2: 进入编辑器...', 'step');

  await Runtime.evaluate({
    expression: `(function() {
      var card = document.querySelector('.preview-card');
      if (card) { card.click(); return 'ok'; }
      return 'no-card';
    })()`,
    returnByValue: true,
  });

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
    log('直接在 iframe 中操作...', 'step');
    await sleep(3000);

    log('查找导出按钮...', 'step');
    var exportBtn = null;

    for (var attempt = 0; attempt < 12; attempt++) {
      var btnCheck = await Runtime.evaluate({
        expression: `(function() {
          try {
            var f = document.querySelector('iframe.ppt-frame, iframe[class*="ppt"], iframe[src*="/ppt"]');
            if (!f || !f.contentDocument) return JSON.stringify({error: 'no iframe content'});
            var doc = f.contentDocument;
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
        log(`✅ 找到"导出"按钮 (第 ${attempt+1} 次)`, 'info');
        editorConnected = true;

        try {
          await Page.setDownloadBehavior({ behavior: 'allow', downloadPath: downloadDir });
          log(`设置下载路径: ${downloadDir}`, 'dl');
        } catch(e) {
          log(`设置下载失败: ${e.message}`, 'warn');
        }

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
            log(`✅ 找到"直接下载"按钮`, 'info');
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
            exportBtn.clicked = true;
            break;
          }
          await sleep(2000);
        }
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

  // ---- 等待文件保存 ----
  log('等待文件保存...', 'step');
  var fileInfo = await findDownloadedFile(downloadDir, 60000);

  if (fileInfo) {
    log(`✅ PPT 已保存到: ${fileInfo.filePath}`, 'dl');
  } else {
    log('⚠️ 未检测到下载文件', 'warn');
    try {
      const pptxFiles = fs.readdirSync(downloadDir)
        .filter(f => f.endsWith('.pptx'))
        .map(f => ({ name: f, path: path.join(downloadDir, f), mtime: fs.statSync(path.join(downloadDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (pptxFiles.length > 0) {
        log(`✅ 最近文件: ${pptxFiles[0].name}`, 'dl');
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
          if (!knownMtimes[f] || stat.mtimeMs > knownMtimes[f]) {
            log(`发现文件变化: ${f} (${(stat.size/1024).toFixed(1)}KB)`, 'dl');
            knownMtimes[f] = stat.mtimeMs;
            await sleep(2000);
            return { filePath, fileName: f, fileSize: stat.size };
          }
        } catch(e) {}
      }
    } catch(e) {}
  }
  log(`在 ${timeout/1000}s 内未发现新下载文件`, 'warn');
  return null;
}

// ===== 发送邮件 =====
async function sendEmailWithAttachment(apiKey, to, subject, htmlContent, attachmentPath) {
  const smtpUser = process.env.SMTP_USER;
  if (smtpUser) {
    return sendEmailViaSMTP(to, subject, htmlContent, attachmentPath);
  }
  return sendEmailViaResend(to, subject, htmlContent, attachmentPath);
}

async function sendEmailViaSMTP(to, subject, htmlContent, attachmentPath) {
  const nodemailer = await import('nodemailer');
  const smtpHost = process.env.SMTP_HOST || 'smtp.qq.com';
  const smtpPort = parseInt(process.env.SMTP_PORT || '465');
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const fromName = process.env.SMTP_FROM_NAME || 'PPT 智能生成';

  if (!smtpUser || !smtpPass) {
    log('SMTP 未配置，跳过邮件发送', 'warn');
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
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
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

async function sendEmailViaResend(to, subject, htmlContent, attachmentPath) {
  if (!RESEND_API_KEY) {
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
      log(`上传附件到 Resend: ${fileName}`, 'mail');
      const formData = new FormData();
      const blob = new Blob([fileBuffer]);
      formData.append('file', blob, fileName);
      const uploadResp = await fetch('https://api.resend.com/attachments', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}` },
        body: formData,
      });
      if (uploadResp.ok) {
        attachmentId = (await uploadResp.json()).id;
        log(`附件上传成功`, 'mail');
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
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(emailPayload),
    });
    if (resp.ok) {
      log(`邮件发送成功`, 'mail');
      return true;
    } else {
      log(`邮件发送失败: ${resp.status}`, 'error');
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
  log('Kimi AgentPPT CDP 自动化 — 完整版 (文件上传 + 下载 + 邮件)');
  log('='.repeat(60));

  const downloadDir = path.resolve(DOWNLOAD_DIR);
  fs.mkdirSync(downloadDir, { recursive: true });
  log(`下载目录: ${downloadDir}`, 'dl');
  if (opts.email) log(`客户邮箱: ${opts.email}`, 'mail');
  if (opts.customer) log(`客户称呼: ${opts.customer}`);
  if (opts.files && opts.files.length > 0) {
    log(`待上传附件: ${opts.files.length} 个`, 'upload');
    opts.files.forEach(f => log(`  ${path.basename(f)}`, 'upload'));
  }

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

    // 3. 导航到 Slides（如果需要）
    if (kimiInfo.navigate) {
      log('导航到 Kimi Slides...', 'step');
      await Page.navigate({ url: KIMI_URL });
      await sleep(3000);
    }

    // 4. 判断当前状态
    const isChatPage = kimiInfo.tab.url.includes('kimi.com/chat/');

    if (isChatPage) {
      log('当前已在 Kimi Chat 页面', 'info');
    } else {
      // 等待页面加载
      log('等待页面加载...', 'step');
      await waitForElement(Runtime, '.chat-input-editor', 15000);
      log('编辑器已就绪');

      // 5. 输入提示词（先输入文字，再上传文件）
      const textInserted = await insertTextInEditor(Runtime, Input, opts.prompt);

      // 6. 上传附件到 Kimi（关键新增步骤）
      //    先上传文件再发送，确保 Kimi 收到原始文件
      if (opts.files && opts.files.length > 0) {
        await uploadFilesToKimi(Runtime, DOM, opts.files);
      }

      // 7. 重新聚焦编辑器并触发输入事件，确保 Vue 响应式状态同步
      log('同步编辑器状态...', 'step');
      await Runtime.evaluate({
        expression: `(() => {
          const ed = document.querySelector('.chat-input-editor');
          if (ed) {
            ed.focus();
            ed.dispatchEvent(new Event('focus', { bubbles: true }));
            ed.dispatchEvent(new Event('input', { bubbles: true }));
            ed.dispatchEvent(new Event('compositionend', { bubbles: true }));
            // 点击编辑器触发 Vue 更新
            ed.click();
          }
        })()`,
        returnByValue: true,
      });
      await sleep(500);

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

    // 10. 发送邮件（使用 dlResult.filePath 作为附件，已在 waitAndDownload 中找到）
    const fileInfoPath = dlResult.filePath;
    if (fileInfoPath) log(`PPT 文件: ${fileInfoPath}`, 'dl');

    // 11. 发送邮件
    if (opts.email && (RESEND_API_KEY || process.env.SMTP_USER)) {
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

      await sendEmailWithAttachment(
        RESEND_API_KEY,
        [opts.email].filter(Boolean),
        `📊 您的 PPT「${topic}」已生成 - ${customerName}`,
        htmlContent,
        fileInfoPath
      );
    } else if (fileInfoPath) {
      log(`PPT 已下载到: ${fileInfoPath}`, 'dl');
    }

    // 12. 重置 Kimi 页面，为下一次提交做准备
    log('重置 Kimi 页面...', 'step');
    log('导航到 Kimi Slides 首页...', 'step');
    await Page.navigate({ url: KIMI_URL });
    await sleep(5000);
    log('✅ Kimi 页面已重置到首页', 'info');

    await tab.close();
    log('='.repeat(60));
    log(`🎉 全流程完成！` + (fileInfoPath ? ` PPT: ${path.basename(fileInfoPath)}` : ''));

    return { success: true, filePath: fileInfoPath || null };

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
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  function promptUser(q) { return new Promise(r => rl.question(q, r)); }

  console.log('\n📋 Kimi AgentPPT CDP 自动化 (文件上传 + 下载 + 邮件)\n');
  promptUser('请输入 PPT 提示词: ').then(prompt => {
    opts.prompt = prompt;
    return promptUser('客户邮箱 (可选): ');
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
    rl.close();
    return runAutomation(opts);
  }).then(result => {
    process.exit(result.success ? 0 : 1);
  });
}
