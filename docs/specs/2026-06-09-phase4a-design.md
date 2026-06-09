# Phase 4a 设计：FAQ 知识库 + Escalation 判定 + 企微推送

**项目**：微店客服 AI 自动回复
**阶段**：Phase 4a（Phase 3 草稿模式之上）
**日期**：2026-06-09
**状态**：设计已批准，待写实施 plan

---

## 1. 上下文（为什么做这一阶段）

Phase 3 已经验证：在真实卖家号"旷野户外"上，DeepSeek 草稿模式端到端跑通——商品卡片识别、文字解析、prompt 强化防虚构、对话历史累积都正常。问题不在通路，在**质量边界**：

- 现在 AI 没有店铺自己的话术（FAQ），所以一遇到"多久发货""怎么换尺码"只能保守说"稍等我确认"，对真实场景太弱
- 当前 escalation 只有关键词黑名单，漏判软情况（情绪激动、隐晦威胁）
- 草稿打在 console 里，卖家如果没盯页面就不知道有客户在等

Phase 4a 解决这三件事，但**仍不开真发送**——草稿质量先稳，下一阶段才是 Phase 4b 上 UI 驱动 + 轻量防封号。

---

## 2. 范围

**做**：
- 启动时加载 `knowledge/{prompt.md, faq.md}` 拼进 system prompt
- AI 输出强制 JSON：`{should_escalate: bool, reason: string, draft: string}`（DeepSeek `response_format: json_object`）
- 两级 escalation 判定：硬关键词 + LLM 自评
- 命中 → 推送结构化卡片到企微群机器人 webhook

**不做（Phase 4b 再上）**：
- 真发送（继续草稿模式，AI 草稿 + escalation 都只在 console 打 + 推企微）
- 防封号机器（rate limit + kill switch 留到真发送一起加）
- 商品引用作为企微卡片独立字段（按用户要求不加）
- KB 改动后的热加载、双向回复、向量检索

---

## 3. 总体数据流

```
WS 收到 send_notify (fromSourceType:5008, msgMediaType:1)
  │
  ▼
关键词黑名单（保留 Phase 3 既有逻辑）
  ├─ 命中 → escalate 直接推企微（不调 LLM 省 token）
  │         reason = "keyword:<命中词>", draft = CFG.fallbackText
  │
  └─ 没命中 → 调 DeepSeek（JSON mode + KB system prompt）
              │
              ▼
            解析 {should_escalate, reason, draft}
              ├─ JSON 解析失败 → 安全默认 escalate
              │                   reason = "JSON 解析失败: <err>", draft = CFG.fallbackText
              ├─ should_escalate=true → 推企微 + console 打草稿
              └─ should_escalate=false → 只 console 打草稿，结束

企微推送：60s 同买家去重，单次失败不阻塞主流程
```

---

## 4. KB 加载机制

userscript 跑在浏览器 main world，没法读本地文件系统。方案：**md 在源文件、构建脚本注入**：

- KB 仍以 `knowledge/prompt.md` + `knowledge/faq.md` 维护
- 新增 `scripts/build-userscript.mjs`：读两个 md → 拼成单一 JS 常量 `KB_CONTENT` → 替换源 userscript 模板里的占位符 → 输出可装的 `dist/weidian-ai-reply.user.js`
- 工作流：改 md → `node scripts/build-userscript.mjs` → Tampermonkey 里粘贴新版 → 刷新页面

这样 KB 改了不用手粘到 JS 字符串里，但运行时仍是零依赖。

---

## 5. AI 调用与 prompt 组装

每次进线（关键词未命中后）的 prompt 结构：

```
[system]
<prompt.md 内容>

【店铺 FAQ 知识库】
<faq.md 内容>

【客户正在咨询的商品】（如有）
标题：...
价格：...
商品ID：...

【输出格式】
必须返回严格的 JSON，结构如下，不要任何其他文字：
{
  "should_escalate": <true|false>,
  "reason": "<简短判定理由，给后台看>",
  "draft": "<给客户的回复文字>"
}
判定 should_escalate=true 的情况：
- 客户情绪明显激动、抱怨升温、催促
- prompt.md 列出的"必须转人工"任一场景
- 你拿不准时（保守原则）

[user/assistant 对话历史 ...]

[user]
<当前买家这条文字>
```

调用参数：
- `model`: 沿用 CFG（当前 `deepseek-v4-flash`）
- `response_format: { type: "json_object" }`
- `temperature: 0.5`, `max_tokens: 400`

错误处理：
- 网络/HTTP 错误 → console 红字、跳过本次（不推企微，避免错误循环）
- JSON 解析失败 → 安全默认 escalate，推企微

---

## 6. 企微推送

### 6.1 配置

新增 CFG 字段：
- `qywxWebhookUrl: ''` —— 群机器人 URL，用户自己创建机器人后填
- `qywxEnabled: true`
- `escalationDebounceMs: 60_000` —— 同买家 60s 内多次触发只推一次
- `escalationCardLines: 2` —— 卡片里展示最近多少条买家文字
- `fallbackText: '稍等，正在为您处理~'` —— 关键词/JSON 失败时的占位草稿

userscript 顶部 `// @connect qywx.work.weixin.qq.com` 加上。

### 6.2 卡片内容（markdown 类型）

```markdown
**🛎 需要人工：旷野户外 客服**

> **客户**：<buyerName>
> **会话**：https://im.weidian.com/im-team/im-pc-2/#/session/recent/<buyerUid>

**最近 N 条**
1. <text-1>
2. <text-2>

**AI 建议草稿**（仅参考，未发送）
> <draft>

**触发原因**
<reason>
```

### 6.3 推送实现

- 用 `fetch` POST 到 webhook URL，body：`{"msgtype":"markdown","markdown":{"content":"..."}}`
- 去重：`Map<buyerUid, lastPushTs>`，命中 debounce 直接 skip 推送（但 console 仍记日志）
- 推送失败（webhook 错误、CORS、网络）→ console.error，不重试，不阻塞主流程

---

## 7. 模块拆分（在现有 userscript 内部）

依然单文件 userscript。文件内逻辑分块：

```
weidian-ai-reply.user.js
├─ PROTOCOL_NOTES (注释，沿用)
├─ CFG (扩展：加 qywx 字段)
├─ KB_CONTENT (build 脚本注入；prompt + faq 字符串)
├─ tools (tryParse / safeDecode，沿用)
├─ conversations (沿用，加 recentBuyerTexts 拉最近 N 条)
├─ classifyIncoming (沿用)
├─ keywordSafety (沿用 Phase 3 的 safetyCheck，改名)
├─ buildMessages (扩展：拼 KB、加 JSON schema 提示)
├─ callDeepSeek (扩展：response_format)
├─ parseAIOutput (新增：JSON 解析 + fallback)
├─ qywxPush (新增：去重 + 卡片渲染 + fetch)
├─ controller (扩展：串起新流程)
└─ WS hook (沿用)
```

---

## 8. 验收（端到端，仍是草稿模式）

让 Jason 发以下 4 条，依次验证：

| 输入 | 期望 |
|---|---|
| "12315 投诉你们" | 关键词命中 → 秒 escalate → 企微红卡 → **未调 DeepSeek** |
| "多久发货" | KB 命中 faq → AI 返回 should_escalate=false → 草稿用 FAQ 话术 → 企微**不推** |
| "赶紧给我处理啊我等不及了" | 关键词不命中但 LLM 自评 escalate=true → 推企微 |
| "这帽子能戴跑步吗" | 自动答（用商品标题"越野跑山"）→ 不推企微 |

另外两个非功能验收：
- 同一买家 60s 内连续触发 escalate，企微只收一次推送（debounce 生效）
- 故意把 webhook URL 改错 → 推送失败但主流程不挂、其他买家的草稿生成不受影响

---

## 9. 风险与决策记录

- **DeepSeek JSON mode 稳定性**：`deepseek-v4-flash` 是否稳定支持 `response_format: json_object` 待验。Phase 3 已经验证 chat completions 正常，JSON mode 留到实施时测；失败回退到「按文本解析 + 安全默认 escalate」。
- **企微 webhook CORS**：`qywx.work.weixin.qq.com` 应该允许跨域，但需要在实施时实测。如果 CORS 拦了，回退到 Tampermonkey `GM_xmlhttpRequest`（需改 `@grant`）。
- **保守话术只有 1 句**：所有 escalate 分支都用 `CFG.fallbackText`。后续如果需要分场景（投诉用一句、催发货用另一句），再扩为对象。Phase 4a 暂不做。
- **KB 用 token 量**：`prompt.md` + `faq.md` 约 7KB / ~2500 tokens。每次调用都喂 → ~每条 1k+ 输入 token。`deepseek-v4-flash` 单价低，可接受；如果将来要换模型，可考虑用 cache 或者 prompt prefix 缓存。

---

## 10. 出 Phase 4a 之后

下一阶段 Phase 4b：
- 接入真发送（UI 驱动 textInput.editor + Enter，复用 Phase 2 验证过的）
- 轻量防封号：单分钟/小时上限 + kill switch（检测 send 失败 / 验证码 DOM）
- `autoreplyEnabled` 开关从死值 false 变成可切；默认仍 false，灰度时手动开
