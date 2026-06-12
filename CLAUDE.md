# CLAUDE.md

给后续 Claude Code 会话用的项目速读。详细的产品/数据流看 [README.md](README.md)。

## 项目本质

Tampermonkey 脚本，注入到 `im.weidian.com/im-team/im-pc-2/`，劫持 WebSocket 拦截买家消息，调 DeepSeek 生成回复，UI 驱动编辑器自动发送，无法回的推企微让人工接手。

## 开发流程（必须记住）

```bash
npm test            # 单元测试（lib.mjs 纯函数）
npm run build       # 把 knowledge/ 和 src/lib.mjs 注入到 src/main.js 输出 dist/
```

**改完 src/ 或 knowledge/ 必须 `npm run build`**。否则用户装的 dist 还是旧的。`pbcopy < dist/weidian-ai-reply.user.js` 把构建产物送到剪贴板让用户粘到 Tampermonkey。

## 关键设计红线（违反就是事故）

1. **永远不自组 WS send 帧** —— 用 UI 驱动（写编辑器 + 派发 Enter）。绕开页面就绕开了 seq 维护、反爬埋点、错误重试。决策记录在 [src/main.js:126](src/main.js#L126)。

2. **任何失败都 escalate 推企微，永远不"凑合发"** —— API timeout / JSON 解析失败（重试后仍失败）/ 编辑器有内容 / WS 帧未观察到，都要 `pushEscalation`。**禁止在错误状态下发送**。

3. **sendReply 必须传 `targetUid`** —— 不传就会用当前页面的编辑器，导致**把 A 的回复发给 B**（已修过的严重 bug）。`sendReply(text, buyerUid)` 内部会先切 hash 再发。

4. **切换 hash 后等 1500ms** —— React state / WS 订阅切到新会话需要这么久。短了 Enter 会静默失败（页面不发 WS 帧）。

5. **发送后用 WS 出口帧验证** —— `__wd_lastOutgoing.data.cmd === 'msg' && sub === 'send' && body.toUid === targetUid`。没观察到就 return false → 推草稿。

6. **全局 `sendLock` + per-buyer `buyerLocks`** —— 编辑器是单例 DOM，必须全局串行；同一买家用 per-buyer 锁排队避免并发调 API。

## 常改的文件

| 我想改 | 改这里 |
|---|---|
| AI 回复风格、转人工判定 | [knowledge/prompt.md](knowledge/prompt.md) |
| FAQ 模板话术 | [knowledge/faq.md](knowledge/faq.md) |
| sendReply / hash 切换 / 编辑器交互 | [src/main.js](src/main.js) `sendReply` 函数 |
| 进线分类、过滤 | [src/main.js](src/main.js) `classifyIncoming` / `handleIncoming` |
| DeepSeek 调用、重试 | [src/main.js](src/main.js) `callDeepSeek` / `deepseekOnce` |
| 企微卡片渲染、JSON 解析 | [src/lib.mjs](src/lib.mjs) |
| 未读扫描、周期任务 | [src/main.js](src/main.js) `sweep` / `startPeriodicSweep` |

## CFG 默认值（[src/main.js:188](src/main.js#L188)）

| key | 默认 | 备注 |
|---|---|---|
| `deepseekModel` | `deepseek-v4-flash` | JSON mode 偶发空响应 → 已加重试 |
| `deepseekTemperature` | 0.5 | 重试时 temp=0 |
| `deepseekMaxTokens` | 800 | 之前 400 偶尔截断 |
| `sellerUid` | 7761657479685210349 | 旷野户外卖家 uid |
| `sweepDelayMs` | 1500 | 切换会话后等待页面对齐 |
| `escalationDebounceMs` | 60_000 | 同买家 60s 内只推一次 |

`ignoreUids` 默认含 4 个供货商 uid，不自动回复他们的消息。

## 调试入口（页面 console）

```js
__wd.debug(true)            // 打印所有 WS 进线 + 跳过原因
__wd.sweep()                // 手动扫一次未读
__wd.send('text', 'uid')    // 手动测发送
__wd.testAI('问题')         // 本地测 prompt
__wd.conversations()        // 看会话 Map 状态
__wd.testHistory('uid')     // 探 history API 看原始响应
```

完整列表见 `__wd.help()`。

## 验证发送通路（提交前自查）

不要光靠"日志说发了"。日志 `📤 已发送（已验证 WS 帧）` 才代表买家真的收到了 —— 这条 log 是 `verifyOutgoingSend` 在 WS hook 上看到了真实出口帧才打的。若是 `📤 已发送` 没有"已验证"字样说明走了 fallback 路径。

## Build 怎么工作

[scripts/build.mjs](scripts/build.mjs) 把 `src/lib.mjs` 剥掉 `export ` 关键字注入到 `src/main.js` 的 `{{INJECT_LIB}}` 占位符，knowledge 拼成字符串塞 `{{INJECT_KB}}`。lib.mjs 因此**不能用 ES module 顶层语法**（顶层 import/异步）；只导出纯函数。

测试时直接 import `src/lib.mjs`（node 支持 .mjs），不走构建。

## 当前已知陷阱

- DeepSeek v4-flash 在 `response_format: json_object` 下偶发返回**空 content + finish_reason: stop** → 已加 retry。如果用户报"企微推送很多"，先看 reason 字段里 `(重试后, ...)` 字样区分是不是同一类。
- 编辑器在切 hash 后短时间内**看似可用但 send 不出去**，必须靠 WS 帧验证才能判断。
- `discoverUnreadItems` 用 DOM `.session-item-box .unread-hot-tag`，**微店改前端 class 名就会失效**。

## 仓库

GitHub: <https://github.com/Heytaxi-N/weidian_ai->（注意 URL 末尾的横杠是仓库名一部分）

## Session cwd 提醒

这个项目的真实路径是 `/Users/nick/Downloads/work/weidian-ai-reply`。如果 Claude Code session 启动在别处（比如 `/Users/nick/projects/weidian_aftersales`），所有 bash 命令必须显式 `cd /Users/nick/Downloads/work/weidian-ai-reply &&` 前缀。建议用户 `/exit` 然后从这个目录 `claude --resume` 重启。
