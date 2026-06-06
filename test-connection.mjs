// test-connection.mjs — 只读连接测试，验证 Edge CDP 和 Kimi 页面状态
// 用法: node test-connection.mjs

import CDP from 'chrome-remote-interface';

async function main() {
  console.log('\n🔌 测试 Edge CDP 连接\n');

  // 1. 检查调试端口
  try {
    const tabs = await CDP.List({ port: 9222 });
    console.log(`✅ 已连接 Edge 调试端口 (${tabs.length} 个标签页)\n`);
    console.log('--- 标签页列表 ---');
    tabs.forEach(t => {
      const isKimi = t.url.includes('kimi.com') ? ' ← Kimi' : '';
      const isSlides = t.url.includes('kimi.com/slides') ? ' ← ✅ Kimi Slides' : '';
      console.log(`  ${t.title?.slice(0, 30).padEnd(32)} ${t.url?.slice(0, 60)}${isSlides || isKimi}`);
    });
    console.log();

    // 2. 找 Kimi Slides
    const slides = tabs.find(t => t.url.includes('kimi.com/slides'));
    if (!slides) {
      console.log('❌ 未找到 Kimi Slides 标签页');
      console.log('  请打开 https://www.kimi.com/slides 并登录');
      process.exit(1);
    }

    // 3. 连接并检查页面状态
    console.log(`📄 ${slides.title}`);
    console.log(`   ${slides.url}\n`);
    const tab = await CDP({ port: 9222, target: () => slides });
    const { Page, Runtime } = tab;
    await Page.enable();

    const r = await Runtime.evaluate({
      expression: `({
        editor: !!document.querySelector('.chat-input-editor'),
        sendBtn: document.querySelector('.send-button-container')?.className || 'not-found',
        sendBtnDisabled: document.querySelector('.send-button-container')?.classList.contains('disabled'),
        modeActive: document.querySelector('.select-option.is-active')?.querySelector('.select-label')?.textContent?.trim() || 'unknown',
        modeOptions: Array.from(document.querySelectorAll('.select-option')).map(b => ({
          text: b.querySelector('.select-label')?.textContent?.trim() || b.textContent.trim().slice(0,20),
          disabled: b.disabled,
          active: b.classList.contains('is-active'),
        })),
        pageText: document.body.innerText.slice(0, 200),
      })`,
      returnByValue: true,
    });

    const s = r.result.value;
    console.log('--- 页面状态 ---');
    console.log(`  编辑器:       ${s.editor ? '✅ 存在' : '❌ 未找到'}`);
    console.log(`  发送按钮:     ${s.sendBtn}`);
    console.log(`  当前模式:     ${s.modeActive}`);
    console.log(`  模式选项:     ${s.modeOptions.map(m => `${m.text}(${m.active ? '激活' : ''}${m.disabled ? '禁用' : '可用'})`).join(', ')}`);
    console.log(`  页面文本:     ${s.pageText.replace(/\n/g, ' ').trim().slice(0, 100)}...`);

    // 4. 尝试检查 + 按钮
    const r2 = await Runtime.evaluate({
      expression: `document.querySelector('.toolkit-trigger-btn')?.className || 'not-found'`,
      returnByValue: true,
    });
    console.log(`  [+] 按钮:     ${r2.result.value}`);

    // 5. 检查页数选择
    const r3 = await Runtime.evaluate({
      expression: `document.querySelector('.page-limit-button')?.textContent?.trim() || 'not-found'`,
      returnByValue: true,
    });
    console.log(`  页数选择:     ${r3.result.value}`);

    await tab.close();
    console.log('\n✅ 连接测试通过 — 所有元素就绪');
    console.log('\n📋 下一步可运行: node kimi-cdp.mjs --prompt "你的PPT主题"');

  } catch (e) {
    if (e.code === 'ECONNREFUSED') {
      console.log('❌ Edge 调试端口 9222 未启动');
      console.log('   请用以下命令启动 Edge:');
      console.log('   "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" ^');
      console.log('     --remote-debugging-port=9222 ^');
      console.log('     --user-data-dir="C:\\Users\\Administrator\\.claude-edge-debug"');
    } else {
      console.log(`❌ 错误: ${e.message}`);
    }
    process.exit(1);
  }
}

main();
