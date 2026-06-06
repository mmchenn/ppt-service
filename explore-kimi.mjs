// explore-kimi.mjs — 探索 Kimi Slides 页面结构
import CDP from 'chrome-remote-interface';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const tab = await CDP({ port: 9222, target: (targets) => targets.find(t => t.url.includes('kimi.com/slides')) });
  const { Page, DOM, Runtime } = tab;
  await Page.enable();
  await DOM.enable();

  // Wait for page to be ready
  await Page.reload();
  await sleep(3000);

  // Get page structure
  const result = await Runtime.evaluate({
    expression: `(() => {
      const r = {};

      // All interactive buttons
      r.buttons = Array.from(document.querySelectorAll('button, [role="button"], [tabindex]:not([tabindex="-1"])')).map(el => ({
        tag: el.tagName,
        cls: el.className.slice(0, 60),
        text: el.textContent.replace(/\\s+/g, ' ').trim().slice(0, 50),
        disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
        x: Math.round(el.getBoundingClientRect().x),
        y: Math.round(el.getBoundingClientRect().y),
        w: Math.round(el.getBoundingClientRect().width),
        h: Math.round(el.getBoundingClientRect().height),
        visible: el.offsetParent !== null,
        rect_top: Math.round(el.getBoundingClientRect().top),
        rect_bottom: Math.round(el.getBoundingClientRect().bottom),
      })).filter(b => b.w > 0 && b.h > 0);

      // The full page HTML structure (key sections)
      r.keySections = [];
      const chatBox = document.getElementById('chat-box');
      if (chatBox) {
        r.chatBoxHTML = chatBox.innerHTML.slice(0, 5000);
        // Count children
        r.chatBoxChildren = chatBox.children.length;
        Array.from(chatBox.children).forEach((child, i) => {
          r.keySections.push({
            index: i,
            cls: child.className.slice(0, 80),
            tag: child.tagName,
            childCount: child.children.length,
            text: child.textContent.replace(/\\s+/g, ' ').trim().slice(0, 100),
            x: Math.round(child.getBoundingClientRect().x),
            y: Math.round(child.getBoundingClientRect().y),
            w: Math.round(child.getBoundingClientRect().width),
            h: Math.round(child.getBoundingClientRect().height),
          });
        });
      }

      // Input area details
      const inputArea = document.querySelector('.chat-input');
      if (inputArea) {
        r.inputAreaHTML = inputArea.outerHTML.slice(0, 3000);
      }

      // Look for file upload mechanism
      r.fileInputs = [];
      const allInputs = document.querySelectorAll('input');
      allInputs.forEach(el => {
        r.fileInputs.push({
          type: el.type,
          accept: el.accept || '',
          id: el.id || '',
          cls: el.className.slice(0, 40),
          hidden: el.hidden,
          display: window.getComputedStyle(el).display,
          parentCls: el.parentElement?.className?.slice(0, 40) || '',
        });
      });

      // Look for any clickable areas at the bottom of page
      r.bottomElements = [];
      const bottom = document.querySelector('[class*="bottom"], [class*="footer"], [class*="toolbar"], .chat-input');
      if (bottom) {
        const bottomRect = bottom.getBoundingClientRect();
        r.bottomRect = { x: Math.round(bottomRect.x), y: Math.round(bottomRect.y), w: Math.round(bottomRect.width), h: Math.round(bottomRect.height) };
        r.bottomHTML = bottom.outerHTML.slice(0, 2000);
      }

      // Check page body children structure
      r.bodyStructure = [];
      Array.from(document.body.children).slice(0, 10).forEach((child, i) => {
        r.bodyStructure.push({
          index: i,
          tag: child.tagName,
          id: child.id || '',
          cls: child.className.slice(0, 80),
          childCount: child.children.length,
          text: child.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80),
        });
      });

      return r;
    })()`,
    returnByValue: true,
  });

  console.log(JSON.stringify(result.result, null, 2));

  await tab.close();
}

main().catch(e => { console.error(e); process.exit(1); });
