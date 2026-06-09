// =============================================================================
// Phase 2 验证脚本 —— UI 驱动发送
// 用法：在客服后台页面打开 Jason 的会话，F12 控制台粘贴本文件全部内容运行。
// 它会：
//   1) 找到输入框 + 发送按钮 DOM 引用
//   2) 模拟"键盘打字"把测试文字写进去（用 React/Vue 兼容的 input 事件触发）
//   3) 点击发送按钮
//   4) 你的 __wd_buf 会捕获到一个 subCmd:"send" 的 outgoing 帧 — 说明发送通道走通了
//
// ★ 这段脚本不构造任何协议帧 —— 完全复用页面自己的发送逻辑。
//   等价于"机器人快速地敲了键盘点了发送"。
// =============================================================================

(function () {
  const TEXT_TO_SEND = '这是 Phase 2 自动测试，不用回';

  // 1) 找输入框：客服后台输入框通常是 contenteditable=true 的 div 或 textarea
  const candidates = [
    ...document.querySelectorAll('textarea'),
    ...document.querySelectorAll('[contenteditable="true"]'),
    ...document.querySelectorAll('.input-area, .message-input, .editor'),
  ];
  // 取看起来是"消息输入框"的（在底部 + 尺寸大）
  const visible = candidates.filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 100 && r.height > 20 && r.top > window.innerHeight / 2;
  });
  console.log('[probe] 输入框候选:', visible);
  if (!visible.length) {
    console.error('[probe] 找不到输入框，把上面的 candidates 数组发给我看');
    return;
  }
  const input = visible[0];

  // 2) 找发送按钮（通常是右下角"发送"两个字的 button / div）
  const allBtns = [...document.querySelectorAll('button, [class*="send"], [class*="Send"]')];
  const sendBtn = allBtns.find((b) => /发\s*送|send/i.test(b.textContent || b.className));
  console.log('[probe] 发送按钮:', sendBtn);

  // 3) 写入文字 —— textarea 和 contenteditable 不同处理
  if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, TEXT_TO_SEND);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    // contenteditable
    input.focus();
    document.execCommand('insertText', false, TEXT_TO_SEND);
  }
  console.log('[probe] 文字已写入：', TEXT_TO_SEND);

  // 4) 触发发送
  // 优先点按钮；按钮可能 disabled，等一下 framework 把状态打开
  setTimeout(() => {
    if (sendBtn && !sendBtn.disabled) {
      sendBtn.click();
      console.log('[probe] 已点击发送按钮');
    } else {
      // 退化方案：模拟 Enter 键
      const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true });
      input.dispatchEvent(ev);
      console.log('[probe] 退化用 Enter 键触发');
    }

    // 5) 校验
    setTimeout(() => {
      if (!window.__wd_buf) { console.warn('[probe] 没有 __wd_buf，先装上 Phase 1 监听脚本'); return; }
      const recentOut = window.__wd_buf.all().filter(e => e.dir === 'out' && e.parsed?.data?.subCmd === 'send');
      console.log('[probe] 最近的 subCmd:send 出口帧数量:', recentOut.length);
      if (recentOut.length) {
        console.log('[probe] ✅ 通过 —— 页面 send 流程被驱动成功，最后一帧:', recentOut[recentOut.length - 1]);
      } else {
        console.warn('[probe] ⚠️  没看到 send 出口帧。可能按钮没点中，或者 UI 框架阻止了我们的事件。');
      }
    }, 1500);
  }, 200);
})();
