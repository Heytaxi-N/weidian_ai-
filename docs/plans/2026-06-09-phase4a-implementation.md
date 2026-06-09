# Phase 4a Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 Phase 3 草稿模式之上加 FAQ KB、JSON-output escalation 判定、企微推送，仍保持草稿模式（不真发）。

**Architecture:** 单文件 Tampermonkey userscript 拆成「pure functions in `src/lib.mjs`」+「Tampermonkey 壳 in `src/main.js`」；构建脚本把 KB markdown 内容 + lib 函数都注入到 `dist/weidian-ai-reply.user.js`。pure functions 用 node 自带 test runner 跑单测。

**Tech Stack:** Vanilla JS (ES modules in source; IIFE in dist)；node:test 单元测试；DeepSeek `response_format: json_object`；企微群机器人 markdown webhook。

---

## 0. 文件结构

```
weidian-ai-reply/
  knowledge/
    prompt.md, faq.md          (已有；KB 源)
  src/
    main.js                    (Tampermonkey 壳；包含 {{INJECT_LIB}} 和 {{INJECT_KB}} 占位)
    lib.mjs                    (pure functions，可单测，export 形式)
  scripts/
    build.mjs                  (拼装 dist/...user.js)
  tests/
    parseAIOutput.test.mjs
    keywordCheck.test.mjs
    renderEscalationCard.test.mjs
    createDebouncer.test.mjs
  dist/
    weidian-ai-reply.user.js   (Tampermonkey 装这个)
  docs/
    specs/2026-06-09-phase4a-design.md
    plans/2026-06-09-phase4a-implementation.md
  package.json
  weidian-ai-reply.user.js     (旧的 Phase 3，最后一个 task 删掉)
```

---

## Task 1: 建立项目骨架 + package.json

**Files:**
- Create: `package.json`
- Create dirs: `src/`, `tests/`, `scripts/`, `dist/`

- [ ] **Step 1: 建目录**

```bash
cd /Users/nick/Downloads/work/weidian-ai-reply
mkdir -p src tests scripts dist
```

- [ ] **Step 2: 写 package.json**

Create `package.json`:

```json
{
  "name": "weidian-ai-reply",
  "version": "0.4.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test tests/",
    "build": "node scripts/build.mjs"
  }
}
```

- [ ] **Step 3: 验证 node 版本**

Run: `node --version`
Expected: `v18.x` 或更新（node:test 内建需要 ≥ 18）

---

## Task 2: 把现有 Phase 3 userscript 搬到 src/main.js，加占位

**Files:**
- Read: 当前 `weidian-ai-reply.user.js`
- Create: `src/main.js`

- [ ] **Step 1: 复制现有 userscript 内容到 src/main.js**

```bash
cp weidian-ai-reply.user.js src/main.js
```

- [ ] **Step 2: 在 src/main.js IIFE 开头加两个占位（紧跟 `'use strict';`）**

Find this line in `src/main.js`:

```js
(function () {
  'use strict';

  const TAG = '[wd-ai]';
```

Replace with:

```js
(function () {
  'use strict';

  const TAG = '[wd-ai]';

  // {{INJECT_LIB}}

  // {{INJECT_KB}}
```

- [ ] **Step 3: 升级 metadata header**

Replace top of `src/main.js`:

```js
// ==UserScript==
// @name         微店 IM AI 自动回复（Phase 3 草稿模式）
// @namespace    https://im.weidian.com/
// @version      0.3.0
// @description  收到买家消息→DeepSeek 生成草稿打到 console。仍不真发，等 Phase 4 接入发送。
// @match        https://im.weidian.com/*
// @run-at       document-start
// @grant        none
// @connect      api.deepseek.com
// ==/UserScript==
```

With:

```js
// ==UserScript==
// @name         微店 IM AI 自动回复（Phase 4a：KB + Escalation + 企微推送）
// @namespace    https://im.weidian.com/
// @version      0.4.0
// @description  KB-grounded AI 草稿 + hybrid escalation 判定 + 企微群机器人推送。仍是草稿模式，不真发。
// @match        https://im.weidian.com/*
// @run-at       document-start
// @grant        none
// @connect      api.deepseek.com
// @connect      qyapi.weixin.qq.com
// ==/UserScript==
```

---

## Task 3: 构建脚本（KB 注入 + lib 拼装）

**Files:**
- Create: `scripts/build.mjs`

- [ ] **Step 1: 写 src/lib.mjs 占位（空 export，让 build 不报错）**

Create `src/lib.mjs`:

```js
// Pure, side-effect-free functions. Tested by tests/*.test.mjs.
// Built into dist/ by scripts/build.mjs (which strips the `export ` keywords).
```

- [ ] **Step 2: 写构建脚本**

Create `scripts/build.mjs`:

```js
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function read(rel) { return readFileSync(join(root, rel), 'utf8'); }

const promptMd = read('knowledge/prompt.md');
const faqMd    = read('knowledge/faq.md');

// Strip `export ` for IIFE concat
const libRaw = read('src/lib.mjs');
const libInIIFE = libRaw.replace(/^export\s+/gm, '');

const kbBlock = `
const __KB_PROMPT__ = ${JSON.stringify(promptMd)};
const __KB_FAQ__    = ${JSON.stringify(faqMd)};
`.trim();

const main = read('src/main.js');
const out = main
  .replace('// {{INJECT_LIB}}', libInIIFE)
  .replace('// {{INJECT_KB}}',  kbBlock);

mkdirSync(join(root, 'dist'), { recursive: true });
const dest = join(root, 'dist/weidian-ai-reply.user.js');
writeFileSync(dest, out);
console.log(`✓ built ${dest} (${out.length} bytes)`);
```

- [ ] **Step 3: 跑构建**

Run: `npm run build`
Expected: `✓ built /Users/nick/Downloads/work/weidian-ai-reply/dist/weidian-ai-reply.user.js (NNNNN bytes)`

- [ ] **Step 4: 人工 sanity check**

Open `dist/weidian-ai-reply.user.js`, 确认：
- 顶部有 `// ==UserScript==` 头，含 `@connect qyapi.weixin.qq.com`
- 有 `const __KB_PROMPT__ = "..."` 和 `const __KB_FAQ__ = "..."`
- 没有 `{{INJECT_LIB}}` 或 `{{INJECT_KB}}` 残留

---

## Task 4: pure function — parseAIOutput + 单测

**Files:**
- Modify: `src/lib.mjs`
- Create: `tests/parseAIOutput.test.mjs`

- [ ] **Step 1: 先写测试**

Create `tests/parseAIOutput.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAIOutput } from '../src/lib.mjs';

test('parseAIOutput: 合法 JSON 全字段', () => {
  const r = parseAIOutput('{"should_escalate":false,"reason":"命中 FAQ","draft":"稍等~"}');
  assert.deepEqual(r, { ok: true, value: { should_escalate: false, reason: '命中 FAQ', draft: '稍等~' } });
});

test('parseAIOutput: 缺 reason 字段（应允许，置空字符串）', () => {
  const r = parseAIOutput('{"should_escalate":true,"draft":"转人工"}');
  assert.equal(r.ok, true);
  assert.equal(r.value.reason, '');
});

test('parseAIOutput: should_escalate 不是 boolean', () => {
  const r = parseAIOutput('{"should_escalate":"yes","draft":"x"}');
  assert.equal(r.ok, false);
  assert.match(r.error, /should_escalate/);
});

test('parseAIOutput: 缺 draft 字段', () => {
  const r = parseAIOutput('{"should_escalate":false}');
  assert.equal(r.ok, false);
  assert.match(r.error, /draft/);
});

test('parseAIOutput: 不是合法 JSON', () => {
  const r = parseAIOutput('{not json');
  assert.equal(r.ok, false);
  assert.match(r.error, /JSON parse/);
});

test('parseAIOutput: 接受外层带空白', () => {
  const r = parseAIOutput('  \n{"should_escalate":false,"draft":"x"}\n');
  assert.equal(r.ok, true);
});
```

- [ ] **Step 2: 跑测试看失败**

Run: `npm test`
Expected: 全部 FAIL（`parseAIOutput` 还没 export）

- [ ] **Step 3: 实现函数**

Append to `src/lib.mjs`:

```js
export function parseAIOutput(raw) {
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: 'JSON parse failed: ' + e.message };
  }
  if (typeof obj.should_escalate !== 'boolean') {
    return { ok: false, error: 'should_escalate missing or wrong type' };
  }
  if (typeof obj.draft !== 'string') {
    return { ok: false, error: 'draft missing or wrong type' };
  }
  const reason = typeof obj.reason === 'string' ? obj.reason : '';
  return { ok: true, value: { should_escalate: obj.should_escalate, reason, draft: obj.draft } };
}
```

- [ ] **Step 4: 跑测试看通过**

Run: `npm test`
Expected: 6 个 parseAIOutput 测试全 PASS。

---

## Task 5: pure function — keywordCheck + 单测

**Files:**
- Modify: `src/lib.mjs`
- Create: `tests/keywordCheck.test.mjs`

- [ ] **Step 1: 写测试**

Create `tests/keywordCheck.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keywordCheck } from '../src/lib.mjs';

const BL = ['投诉', '12315', '差评', '退款'];

test('keywordCheck: 命中第一个词', () => {
  assert.deepEqual(keywordCheck('我要投诉你们', BL), { hit: true, term: '投诉' });
});

test('keywordCheck: 命中夹在中间的词', () => {
  assert.deepEqual(keywordCheck('再不处理我打 12315 啊', BL), { hit: true, term: '12315' });
});

test('keywordCheck: 没命中', () => {
  assert.deepEqual(keywordCheck('你好，多久发货', BL), { hit: false });
});

test('keywordCheck: 空黑名单', () => {
  assert.deepEqual(keywordCheck('投诉', []), { hit: false });
});

test('keywordCheck: 空文本', () => {
  assert.deepEqual(keywordCheck('', BL), { hit: false });
});

test('keywordCheck: 返回首个命中（按 blacklist 顺序）', () => {
  const r = keywordCheck('投诉和差评', BL);
  assert.equal(r.term, '投诉');
});
```

- [ ] **Step 2: 跑测试看失败**

Run: `npm test`
Expected: keywordCheck 用例 FAIL。

- [ ] **Step 3: 实现**

Append to `src/lib.mjs`:

```js
export function keywordCheck(text, blacklist) {
  for (const kw of blacklist) {
    if (text.includes(kw)) return { hit: true, term: kw };
  }
  return { hit: false };
}
```

- [ ] **Step 4: 跑测试看通过**

Run: `npm test`
Expected: parseAIOutput + keywordCheck 全 PASS。

---

## Task 6: pure function — renderEscalationCard + 单测

**Files:**
- Modify: `src/lib.mjs`
- Create: `tests/renderEscalationCard.test.mjs`

- [ ] **Step 1: 写测试**

Create `tests/renderEscalationCard.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderEscalationCard } from '../src/lib.mjs';

test('renderEscalationCard: 完整输入', () => {
  const md = renderEscalationCard({
    sellerName: '旷野户外',
    buyerName: 'Jason',
    buyerUid: '8231960975030111227',
    recentTexts: ['还有货吗', '在吗'],
    draft: '稍等我帮您看下库存哈~',
    reason: 'keyword:12315',
  });
  assert.match(md, /🛎 需要人工：旷野户外 客服/);
  assert.match(md, /客户.*Jason/);
  assert.match(md, /#\/session\/recent\/8231960975030111227/);
  assert.match(md, /1\. 还有货吗/);
  assert.match(md, /2\. 在吗/);
  assert.match(md, /稍等我帮您看下库存哈~/);
  assert.match(md, /keyword:12315/);
});

test('renderEscalationCard: buyerName 缺失退化到 uid', () => {
  const md = renderEscalationCard({
    sellerName: '旷野户外', buyerName: null, buyerUid: '999',
    recentTexts: ['你好'], draft: 'x', reason: 'r',
  });
  assert.match(md, /客户.*999/);
});

test('renderEscalationCard: 只有一条最近消息', () => {
  const md = renderEscalationCard({
    sellerName: 'X', buyerName: 'Y', buyerUid: '1',
    recentTexts: ['一句话'], draft: 'd', reason: 'r',
  });
  assert.match(md, /最近 1 条/);
  assert.match(md, /1\. 一句话/);
});

test('renderEscalationCard: 空 recentTexts', () => {
  const md = renderEscalationCard({
    sellerName: 'X', buyerName: 'Y', buyerUid: '1',
    recentTexts: [], draft: 'd', reason: 'r',
  });
  assert.match(md, /最近 0 条/);
});
```

- [ ] **Step 2: 跑测试看失败**

Run: `npm test`
Expected: renderEscalationCard 用例 FAIL。

- [ ] **Step 3: 实现**

Append to `src/lib.mjs`:

```js
export function renderEscalationCard({ sellerName, buyerName, buyerUid, recentTexts, draft, reason }) {
  const url = `https://im.weidian.com/im-team/im-pc-2/#/session/recent/${buyerUid}`;
  const lines = [];
  lines.push(`**🛎 需要人工：${sellerName} 客服**`);
  lines.push('');
  lines.push(`> **客户**：${buyerName || buyerUid}`);
  lines.push(`> **会话**：${url}`);
  lines.push('');
  lines.push(`**最近 ${recentTexts.length} 条**`);
  recentTexts.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
  lines.push('');
  lines.push(`**AI 建议草稿**（仅参考，未发送）`);
  lines.push(`> ${draft}`);
  lines.push('');
  lines.push(`**触发原因**`);
  lines.push(reason);
  return lines.join('\n');
}
```

- [ ] **Step 4: 跑测试看通过**

Run: `npm test`
Expected: 三套测试全 PASS。

---

## Task 7: pure function — createDebouncer + 单测

**Files:**
- Modify: `src/lib.mjs`
- Create: `tests/createDebouncer.test.mjs`

- [ ] **Step 1: 写测试（用注入时钟，避免真实计时）**

Create `tests/createDebouncer.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDebouncer } from '../src/lib.mjs';

test('createDebouncer: 第一次 shouldFire 必返回 true', () => {
  let now = 1000;
  const d = createDebouncer(60_000, () => now);
  assert.equal(d.shouldFire('user1'), true);
});

test('createDebouncer: 同 key 在 interval 内不再 fire', () => {
  let now = 1000;
  const d = createDebouncer(60_000, () => now);
  d.shouldFire('user1');
  now = 30_000;
  assert.equal(d.shouldFire('user1'), false);
});

test('createDebouncer: 同 key 超过 interval 再次 fire', () => {
  let now = 1000;
  const d = createDebouncer(60_000, () => now);
  d.shouldFire('user1');
  now = 1000 + 60_001;
  assert.equal(d.shouldFire('user1'), true);
});

test('createDebouncer: 不同 key 互不影响', () => {
  let now = 1000;
  const d = createDebouncer(60_000, () => now);
  d.shouldFire('user1');
  assert.equal(d.shouldFire('user2'), true);
});

test('createDebouncer: reset(key) 让该 key 立刻可以再 fire', () => {
  let now = 1000;
  const d = createDebouncer(60_000, () => now);
  d.shouldFire('user1');
  d.reset('user1');
  assert.equal(d.shouldFire('user1'), true);
});

test('createDebouncer: reset() 不带参数清空全部', () => {
  let now = 1000;
  const d = createDebouncer(60_000, () => now);
  d.shouldFire('a');
  d.shouldFire('b');
  d.reset();
  assert.equal(d.shouldFire('a'), true);
  assert.equal(d.shouldFire('b'), true);
});
```

- [ ] **Step 2: 跑测试看失败**

Run: `npm test`
Expected: createDebouncer 用例 FAIL。

- [ ] **Step 3: 实现**

Append to `src/lib.mjs`:

```js
export function createDebouncer(intervalMs, nowFn = Date.now) {
  const last = new Map();
  return {
    shouldFire(key) {
      const t = nowFn();
      const prev = last.get(key);
      if (prev !== undefined && t - prev < intervalMs) return false;
      last.set(key, t);
      return true;
    },
    reset(key) {
      if (key === undefined) last.clear();
      else last.delete(key);
    },
  };
}
```

- [ ] **Step 4: 跑测试看通过**

Run: `npm test`
Expected: 全部测试 PASS（parse + keyword + render + debounce 四类）。

---

## Task 8: 把 lib 函数接进 main.js（结构改造，行为不变）

**Files:**
- Modify: `src/main.js`

目的：让 Phase 3 的 `safetyCheck`（黑名单）改用 lib 里的 `keywordCheck`，证明 lib 注入 path 通。不引入新功能。

- [ ] **Step 1: 在 src/main.js 找到旧的 safetyCheck 函数**

旧代码：

```js
  function safetyCheck(text) {
    for (const kw of CFG.blacklist) if (text.includes(kw)) return { decision: 'skip', hit: kw };
    return { decision: 'auto' };
  }
```

- [ ] **Step 2: 替换为调 lib 函数**

```js
  function safetyCheck(text) {
    const r = keywordCheck(text, CFG.blacklist);
    return r.hit ? { decision: 'skip', hit: r.term } : { decision: 'auto' };
  }
```

- [ ] **Step 3: 构建**

Run: `npm run build`
Expected: 成功输出 dist/...user.js。

- [ ] **Step 4: 浏览器烟雾测试**

在 Tampermonkey 里用 `dist/weidian-ai-reply.user.js` 替换装好的脚本；刷新 `im.weidian.com/im-team/im-pc-2/`，console 应该看到 `[wd-ai] Phase 3 已加载` 类似行（meta 名已经改了所以应该是 `Phase 4a`，但运行时打印还没改，本任务只验证不崩）。

打开 console 执行：

```js
typeof keywordCheck    // 应为 'function'
typeof parseAIOutput   // 应为 'function'
typeof renderEscalationCard  // 应为 'function'
typeof createDebouncer // 应为 'function'
typeof __KB_PROMPT__   // 应为 'string'
typeof __KB_FAQ__      // 应为 'string'
```

如果有任何项是 `'undefined'`，build 注入不对，停下排查。

---

## Task 9: 扩展 CFG（KB、企微、debounce）

**Files:**
- Modify: `src/main.js`

- [ ] **Step 1: 在 CFG 里删除内嵌 systemPrompt（KB 取代）+ 加新字段**

找到 src/main.js 中 `const CFG = {...}` 整块。**替换**为：

```js
  const CFG = {
    // DeepSeek
    deepseekApiKey:  'sk-PLACEHOLDER-REPLACE-ME',
    deepseekModel:   'deepseek-v4-flash',
    deepseekUrl:     'https://api.deepseek.com/chat/completions',
    deepseekTemperature: 0.5,
    deepseekMaxTokens: 400,

    // 店铺
    sellerUid:  '7761657479685210349',
    sellerName: '旷野户外',

    // 对话记忆
    historyLimit:        6,
    productCardTTLms:    30 * 60 * 1000,
    escalationCardLines: 2,        // 企微卡片里展示最近多少条买家文字

    // 安全过滤（硬触发，绕过 LLM 直接 escalate）
    blacklist: [
      '12315','工商','市场监管','曝光','起诉','报警','律师',
      '投诉','差评','举报','维权','假货','骗',
      '威胁','赔偿','赔付','补偿',
    ],

    // 企微群机器人 webhook（在企微群里 + 添加机器人 → 复制 URL 填这里）
    qywxWebhookUrl: '',
    qywxEnabled:    true,
    escalationDebounceMs: 60_000,  // 同买家 60s 内多次触发只推一次

    // 保守话术：所有 escalate 分支都用这个作为客户端兜底草稿
    fallbackText: '稍等，我需要帮您核实一下，马上回您~',

    // 草稿模式开关（Phase 4a 不接发送层，这字段为 false 也只是个 placeholder）
    autoreplyEnabled: false,
  };
```

注意：**删掉了原 systemPrompt 字段**——Phase 4a 起 systemPrompt 由 KB 拼出来，不再放 CFG。

- [ ] **Step 2: 构建 + 烟雾测试**

Run: `npm run build`

在浏览器换装新版，刷新，console 跑：

```js
__wd.config().qywxEnabled            // 应为 true
__wd.config().escalationDebounceMs   // 应为 60000
__wd.config().fallbackText           // 应为字符串
__wd.config().systemPrompt           // 应为 undefined（已经移除）
__wd.config().blacklist.length       // 应为 ~20
```

---

## Task 10: 重写 buildMessages —— 用 KB 拼 system prompt + 加 JSON schema 提示

**Files:**
- Modify: `src/main.js`

- [ ] **Step 1: 找到旧 buildMessages**

旧代码大致是：

```js
  function buildMessages(buyerUid, currentText) {
    const conv = getConv(buyerUid);
    const card = ...;
    const ctxLines = [...];
    const systemContent = CFG.systemPrompt + '\n\n' + ctxLines.join('\n');
    const messages = [{ role: 'system', content: systemContent }];
    for (const h of conv.history) messages.push({ role: h.role, content: h.text });
    messages.push({ role: 'user', content: currentText });
    return messages;
  }
```

- [ ] **Step 2: 替换为**

```js
  function buildMessages(buyerUid, currentText) {
    const conv = getConv(buyerUid);
    const card = conv.lastProductCard
      && (Date.now() - conv.lastProductCard.ts < CFG.productCardTTLms)
      ? conv.lastProductCard : null;

    const ctxLines = [];
    if (card) {
      ctxLines.push('【客户正在咨询的商品】');
      ctxLines.push(`标题：${card.title}`);
      if (card.price)  ctxLines.push(`价格：${card.price}`);
      if (card.itemId) ctxLines.push(`商品ID：${card.itemId}`);
    } else {
      ctxLines.push('【客户没有从特定商品页进来，没有商品上下文】');
    }

    const jsonSchemaPrompt = `
【输出格式 — 极其重要】
必须返回严格的 JSON，只包含以下 3 个字段，不要任何额外文字、不要 markdown 代码块：
{
  "should_escalate": true 或 false,
  "reason": "<简短判定理由，给后台看>",
  "draft": "<给客户的回复文字>"
}
判定 should_escalate = true 的情况：
- 客户情绪明显激动、抱怨升温、催促立刻处理
- 你不确定怎么回 / 不在知识库覆盖范围
- "强制转人工"列表里任一场景（投诉、差评、12315、质量责任判断等）
其他情况 should_escalate = false。
即便决定 escalate，draft 字段也要给出一条保守的安抚话术（"稍等我帮您核实下"之类），万一被用上不能空。`;

    const systemContent = [
      __KB_PROMPT__.trim(),
      '',
      '【店铺 FAQ 知识库 — 命中后请尽量逐字使用"可自动回复"那段，不要扩大承诺】',
      __KB_FAQ__.trim(),
      '',
      ctxLines.join('\n'),
      '',
      jsonSchemaPrompt.trim(),
    ].join('\n');

    const messages = [{ role: 'system', content: systemContent }];
    for (const h of conv.history) messages.push({ role: h.role, content: h.text });
    messages.push({ role: 'user', content: currentText });
    return messages;
  }
```

- [ ] **Step 3: 构建 + 烟雾测试**

Run: `npm run build`

浏览器装新版刷新，console 跑：

```js
const msgs = (function () {
  const conv = window.__wd.conversations().find(c => c.uid === 'TEST_LOCAL') || null;
  // 直接调内部 buildMessages 没暴露，借 testAI 间接验证
  return null;
})();
__wd.testAI('多久发货', '帽子', '￥36');
```

观察 console 里 `测试 messages:` 那行的 system content：
- 应该开头是 prompt.md 内容
- 接下来是 `【店铺 FAQ 知识库 ...】` + faq.md 内容
- 接下来是商品上下文
- 最后是 JSON schema 提示

如果 KB 内容没出现 → build 注入路径有问题。

---

## Task 11: callDeepSeek 改用 JSON mode + parseAIOutput

**Files:**
- Modify: `src/main.js`

- [ ] **Step 1: 找到旧 callDeepSeek**

```js
  async function callDeepSeek(messages) {
    if (!CFG.deepseekApiKey || CFG.deepseekApiKey.includes('PLACEHOLDER')) {
      throw new Error('DeepSeek API key 还没填，改 CFG.deepseekApiKey 或调 __wd.setKey(...)');
    }
    const res = await fetch(CFG.deepseekUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CFG.deepseekApiKey}` },
      body: JSON.stringify({
        model: CFG.deepseekModel,
        messages,
        temperature: CFG.deepseekTemperature,
        max_tokens: CFG.deepseekMaxTokens,
        stream: false,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`DeepSeek HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    return (json.choices?.[0]?.message?.content || '').trim();
  }
```

- [ ] **Step 2: 替换为（返回结构化结果）**

```js
  async function callDeepSeek(messages) {
    if (!CFG.deepseekApiKey || CFG.deepseekApiKey.includes('PLACEHOLDER')) {
      throw new Error('DeepSeek API key 还没填，改 CFG.deepseekApiKey 或调 __wd.setKey(...)');
    }
    const res = await fetch(CFG.deepseekUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CFG.deepseekApiKey}` },
      body: JSON.stringify({
        model: CFG.deepseekModel,
        messages,
        temperature: CFG.deepseekTemperature,
        max_tokens: CFG.deepseekMaxTokens,
        stream: false,
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`DeepSeek HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    const raw = (json.choices?.[0]?.message?.content || '').trim();
    const parsed = parseAIOutput(raw);
    if (!parsed.ok) {
      // 安全默认：JSON 失败视为 escalate
      return {
        should_escalate: true,
        reason: 'JSON 解析失败: ' + parsed.error + ' | 原文: ' + raw.slice(0, 200),
        draft: CFG.fallbackText,
      };
    }
    return parsed.value;
  }
```

- [ ] **Step 3: 同步修改 __wd.testAI**

找到 `__wd` 对象里的 `testAI`：

```js
    testAI: async (text, productTitle, productPrice) => {
      const fakeUid = 'TEST_LOCAL';
      const conv = getConv(fakeUid);
      if (productTitle) conv.lastProductCard = { title: productTitle, price: productPrice, ts: Date.now() };
      const msgs = buildMessages(fakeUid, text);
      console.log(TAG, '测试 messages:', msgs);
      const draft = await callDeepSeek(msgs);
      console.log(TAG, '测试草稿:', draft);
      return draft;
    },
```

返回类型从 string 变为 object，名字改一下避免混淆：

```js
    testAI: async (text, productTitle, productPrice) => {
      const fakeUid = 'TEST_LOCAL';
      const conv = getConv(fakeUid);
      if (productTitle) conv.lastProductCard = { title: productTitle, price: productPrice, ts: Date.now() };
      const msgs = buildMessages(fakeUid, text);
      console.log(TAG, '测试 messages:', msgs);
      const result = await callDeepSeek(msgs);
      console.log(TAG, '测试结果:', result);
      return result;
    },
```

- [ ] **Step 4: 构建 + 浏览器烟雾**

```js
const r = await __wd.testAI('这个还有货吗', '帽子', '￥36');
// r 应为 { should_escalate: false|true, reason: '...', draft: '...' }
typeof r.should_escalate  // boolean
typeof r.draft            // string
```

如果 r.reason 含 'JSON 解析失败' → 模型没遵守 JSON 格式，可能 deepseek-v4-flash 不支持 response_format。尝试 `__wd.config().deepseekModel = 'deepseek-chat'` 再 testAI。

---

## Task 12: 加 qywxPush 函数 + 注入 debouncer

**Files:**
- Modify: `src/main.js`

- [ ] **Step 1: 在 src/main.js 工具区之后、controller 之前，加新函数**

在 `async function handleIncoming` 之前插入：

```js
  // ===========================================================================
  // 企微推送
  // ===========================================================================
  const escalationDebouncer = createDebouncer(CFG.escalationDebounceMs);

  function recentBuyerTexts(buyerUid, n) {
    const conv = getConv(buyerUid);
    return conv.history
      .filter(h => h.role === 'user')
      .slice(-n)
      .map(h => h.text);
  }

  async function pushEscalation({ buyerUid, buyerName, draft, reason, currentText }) {
    if (!CFG.qywxEnabled) {
      console.warn(TAG, '🔕 qywx disabled, skip push');
      return;
    }
    if (!CFG.qywxWebhookUrl) {
      console.warn(TAG, '🔕 qywxWebhookUrl 没配，skip push');
      return;
    }
    if (!escalationDebouncer.shouldFire(buyerUid)) {
      console.log(TAG, '⏭️ debounce skip', buyerUid);
      return;
    }

    // 把当前这条也算进"最近 N 条"——保证企微卡片至少包含触发那一条
    let recents = recentBuyerTexts(buyerUid, CFG.escalationCardLines);
    if (recents[recents.length - 1] !== currentText) {
      recents = [...recents, currentText].slice(-CFG.escalationCardLines);
    }

    const content = renderEscalationCard({
      sellerName: CFG.sellerName,
      buyerName, buyerUid,
      recentTexts: recents, draft, reason,
    });

    try {
      const res = await fetch(CFG.qywxWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
      });
      if (!res.ok) {
        console.error(TAG, '❌ 企微推送 HTTP', res.status, await res.text().catch(() => ''));
        return;
      }
      const json = await res.json().catch(() => ({}));
      if (json.errcode && json.errcode !== 0) {
        console.error(TAG, '❌ 企微推送 errcode:', json.errcode, json.errmsg);
      } else {
        console.log(TAG, '✅ 企微推送成功');
      }
    } catch (e) {
      console.error(TAG, '❌ 企微推送 fetch 失败:', e.message);
    }
  }
```

- [ ] **Step 2: 构建 + 烟雾测试**

```js
// 在浏览器 console 手动触发一次推送，确认 webhook 通
__wd.config().qywxWebhookUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=YOUR_KEY';
// 然后无法直接调 pushEscalation（不在 __wd 上），先跳过这步，留到 Task 13 整合后验证
```

（无法在此 task 直接验证，要到 Task 13 controller 串起来后通过真实进线触发。）

---

## Task 13: 重写 handleIncoming（controller 串新流程）

**Files:**
- Modify: `src/main.js`

- [ ] **Step 1: 找到旧 handleIncoming**

```js
  async function handleIncoming(parsed) {
    const ev = classifyIncoming(parsed);
    if (!ev) return;
    if (ev.kind === 'product_card') {
      const conv = getConv(ev.buyerUid);
      conv.lastProductCard = { ...ev, ts: Date.now() };
      console.log(TAG, '🛍️ 商品卡片', ev.buyerUid, ev.title, ev.price || '');
      return;
    }
    if (ev.kind !== 'text') return;

    const text = safeDecode(ev.text || '');
    console.log(TAG, '👤', ev.buyerName || ev.buyerUid, '→', text);

    const safety = safetyCheck(text);
    if (safety.decision === 'skip') {
      console.warn(TAG, '🚧 安全过滤命中，等人工：', safety.hit, '|', text);
      return;
    }

    addToHistory(ev.buyerUid, 'user', text);

    try {
      const messages = buildMessages(ev.buyerUid, text);
      const t0 = performance.now();
      const draft = await callDeepSeek(messages);
      const dt = (performance.now() - t0).toFixed(0);
      addToHistory(ev.buyerUid, 'assistant', draft);
      console.log(...);
      ...
    } catch (e) {
      console.error(TAG, '❌ DeepSeek 失败：', e.message);
    }
  }
```

- [ ] **Step 2: 替换为新版**

```js
  async function handleIncoming(parsed) {
    const ev = classifyIncoming(parsed);
    if (!ev) return;

    if (ev.kind === 'product_card') {
      const conv = getConv(ev.buyerUid);
      conv.lastProductCard = { ...ev, ts: Date.now() };
      console.log(TAG, '🛍️ 商品卡片', ev.buyerUid, ev.title, ev.price || '');
      return;
    }
    if (ev.kind !== 'text') return;

    const text = safeDecode(ev.text || '');
    console.log(TAG, '👤', ev.buyerName || ev.buyerUid, '→', text);

    // 总是把进线文字进 history，方便 escalation 卡片拿"最近 N 条"
    addToHistory(ev.buyerUid, 'user', text);

    // —— 关键词硬触发：不调 LLM 直接 escalate ——
    const kwHit = keywordCheck(text, CFG.blacklist);
    if (kwHit.hit) {
      console.warn(TAG, '🚧 关键词 escalate:', kwHit.term);
      await pushEscalation({
        buyerUid: ev.buyerUid, buyerName: ev.buyerName,
        draft: CFG.fallbackText,
        reason: `keyword:${kwHit.term}`,
        currentText: text,
      });
      return;
    }

    // —— 调 LLM ——
    let aiResult;
    try {
      const messages = buildMessages(ev.buyerUid, text);
      const t0 = performance.now();
      aiResult = await callDeepSeek(messages);
      const dt = (performance.now() - t0).toFixed(0);
      console.log(
        `%c${TAG} 🤖 AI 结果 (${dt}ms)`,
        'color:#0a7;font-weight:bold',
        { buyer: ev.buyerName || ev.buyerUid, asked: text, ...aiResult }
      );
    } catch (e) {
      console.error(TAG, '❌ DeepSeek 失败：', e.message);
      // LLM 失败：也 escalate，让人工兜
      await pushEscalation({
        buyerUid: ev.buyerUid, buyerName: ev.buyerName,
        draft: CFG.fallbackText,
        reason: 'LLM 调用失败: ' + e.message,
        currentText: text,
      });
      return;
    }

    addToHistory(ev.buyerUid, 'assistant', aiResult.draft);

    if (aiResult.should_escalate) {
      console.warn(TAG, '🚧 LLM 自评 escalate:', aiResult.reason);
      await pushEscalation({
        buyerUid: ev.buyerUid, buyerName: ev.buyerName,
        draft: aiResult.draft,
        reason: 'llm:' + (aiResult.reason || '(未给原因)'),
        currentText: text,
      });
      return;
    }

    // 自动答 ✓：仅打草稿，不推送
    if (CFG.autoreplyEnabled) {
      console.warn(TAG, '⚠️ autoreplyEnabled=true 但 Phase 4a 没接发送层，仍只打草稿');
    }
  }
```

- [ ] **Step 3: 更新 help 文案**

找到 `__wd.help` 改成：

```js
    help: () => console.log(`
${TAG} Phase 4a 草稿模式（KB + Escalation + 企微推送）
1) 填 DeepSeek key:    __wd.setKey('sk-xxx')
2) 填 企微 webhook:    __wd.config().qywxWebhookUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...'
3) 本地测 prompt:      __wd.testAI('这个有货吗', '商品标题', '￥36.71')
4) 看会话状态:         __wd.conversations()
5) Phase 4a 不真发；命中黑名单 / LLM 判定 escalate 时推企微
    `.trim()),
```

- [ ] **Step 4: 构建 + 整体烟雾测试**

```bash
npm run build
```

在 Tampermonkey 装新版 → 刷新页面 → console 应看到 `Phase 4a 已加载` 或类似。

填上 DeepSeek key + 企微 webhook：

```js
__wd.setKey('sk-xxx');
__wd.config().qywxWebhookUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=YOUR_KEY';
```

---

## Task 14: 端到端验收（spec 第 8 节四条用例）

按 spec 第 8 节，让 Jason 依次发以下消息（每条间隔 ≥ 5s 避免误触发 debounce）：

- [ ] **用例 1：硬触发**

Jason 发："12315 投诉你们"

期望：
- console 出现 `[wd-ai] 🚧 关键词 escalate: 12315`
- console 出现 `[wd-ai] ✅ 企微推送成功`
- 企微群收到卡片，触发原因显示 `keyword:12315`
- DeepSeek API **没被调用**（看 `Network` 面板没有 `api.deepseek.com` 请求）

- [ ] **用例 2：KB 命中、AI 自答**

Jason 发："多久发货"

期望：
- console 显示 `🤖 AI 结果` 含 `should_escalate: false`
- draft 应接近 faq.md 里"多久发货"的话术
- 企微**没**收到推送

- [ ] **用例 3：LLM 软触发**

Jason 发："赶紧给我处理啊我等不及了"

期望：
- console 显示 `🚧 LLM 自评 escalate`
- 企微收到卡片，触发原因 `llm:...`（含 LLM 给的理由）

- [ ] **用例 4：商品上下文驱动**

Jason 从某商品页点"咨询客服"，然后发："这帽子能戴跑步吗"

期望：
- 先看到 `🛍️ 商品卡片` 日志
- 再看到 `🤖 AI 结果` 含 `should_escalate: false`，draft 引用了商品标题信息
- 企微不推

- [ ] **用例 5：debounce**

紧接用例 3 之后 < 60s，让 Jason 再发一条会触发 escalate 的（比如"你们什么时候给我处理"）。

期望：
- console 显示 `⏭️ debounce skip`
- 企微**不**收到第二条推送

- [ ] **用例 6：webhook 失败不阻塞**

```js
__wd.config().qywxWebhookUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=INVALID';
```

让 Jason 发"12315"。

期望：
- console 显示 `❌ 企微推送 errcode:` 或 `HTTP 4xx`
- 主流程不挂；之后 Jason 发"在吗"仍能正常处理。

---

## Task 15: 清理 — 删除旧的 root userscript

**Files:**
- Delete: `weidian-ai-reply.user.js` (项目根那个)

- [ ] **Step 1: 确认 dist 文件已经替换 Tampermonkey 里的脚本**

`__wd.config().sellerName` 在 console 能正常返回，证明跑的是 dist 版。

- [ ] **Step 2: 删除根目录旧版**

```bash
rm /Users/nick/Downloads/work/weidian-ai-reply/weidian-ai-reply.user.js
```

- [ ] **Step 3: 添加 README 工作流说明**

Create `README.md`（如果不存在；如果已经存在就 append 一节）：

```markdown
# weidian-ai-reply

微店客服 AI 自动回复（草稿模式 / Phase 4a）。

## 开发流程

```bash
# 装依赖（仅 node 内置 test，无外部 deps）
node --version  # 需 ≥ 18

# 改 KB 或 src/ 后构建
npm run build

# 跑单测
npm test
```

构建产物在 `dist/weidian-ai-reply.user.js`，Tampermonkey 装这个。

KB 在 `knowledge/`；构建时会被字面注入到 dist。

## 当前阶段

Phase 4a：草稿模式 + KB + escalation 判定 + 企微推送。**不真发**。

下一步 Phase 4b：UI 驱动发送 + 轻量防封号。
```

---

## Self-Review

**Spec coverage check（对照 `docs/specs/2026-06-09-phase4a-design.md`）:**

- §2 范围（KB 加载、JSON 输出、两级 escalation、企微推送）→ Tasks 9-13 ✓
- §2 不做（真发送、防封号、商品引用独立字段、热加载）→ 没引入 ✓
- §3 数据流（关键词命中跳 LLM、JSON 失败安全 escalate、debounce、失败不阻塞）→ Task 13 controller 完整覆盖 ✓
- §4 KB 加载（build script 注入）→ Tasks 1-3 ✓
- §5 prompt 组装（prompt.md + faq.md + 商品上下文 + JSON schema 提示）→ Task 10 ✓
- §5 AI 调用（response_format json_object, temp 0.5, max_tokens 400）→ Task 11 ✓
- §6 企微（CFG 字段、markdown 卡片、debounce、失败不阻塞）→ Tasks 9, 12 ✓
- §6.2 卡片格式 → Task 6 测试用例约束了输出形态 ✓
- §7 模块拆分 → Tasks 4-7 lib 函数 + Task 8 接进来 ✓
- §8 验收（4 + 2 个场景）→ Task 14 ✓
- §9 风险（JSON mode 兜底、CORS 兜底、保守话术单句、token 量）→ Tasks 11-13 处理 ✓

**Placeholder scan:** 无 TBD/TODO；每个步骤都给了完整代码。

**Type consistency:**
- `parseAIOutput` 返回 `{ ok: true, value: {...} } | { ok: false, error }` 一致
- `keywordCheck` 返回 `{ hit, term? }` 一致（Task 5 测试 / Task 8 调用方一致）
- `createDebouncer` 返回 `{ shouldFire(key), reset(key?) }` 一致（Task 7 测试 / Task 12 调用一致）
- `renderEscalationCard` 输入对象字段：sellerName, buyerName, buyerUid, recentTexts, draft, reason → 与 Task 12 `pushEscalation` 构造一致 ✓
- `callDeepSeek` 返回从 string 变为 `{ should_escalate, reason, draft }` → Task 13 controller 使用一致；__wd.testAI 同步更新（Task 11 step 3）✓

OK，自检完成。
