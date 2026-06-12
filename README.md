# weidian-ai-reply

微店客服 AI 自动回复 Tampermonkey 脚本。运行在 `im.weidian.com/im-team/im-pc-2/`。

收到买家文字 → 关键词硬触发 / DeepSeek 自评 → 命中 escalate 推企微群机器人；未命中且 `autoreplyEnabled=true` 时 **UI 驱动真发送**给买家。

## 项目结构

```
.
├── knowledge/                       # 知识库（人维护，构建时注入到主脚本）
│   ├── prompt.md                    # 高层风格 + 必须转人工 / 允许直接回复清单
│   └── faq.md                       # 高频可自动回复话术
├── src/
│   ├── main.js                      # Tampermonkey 壳（PROTOCOL_NOTES、CFG、WS hook、控制器）
│   └── lib.mjs                      # 纯函数（parseAIOutput / extractJSON / keywordCheck / renderEscalationCard / createDebouncer）
├── scripts/
│   └── build.mjs                    # 注入 knowledge + lib 到 main.js，输出 dist/...user.js
├── tests/                           # node:test 单元测试
├── dist/
│   └── weidian-ai-reply.user.js     # Tampermonkey 装这个文件
├── docs/
│   ├── specs/                       # 设计文档
│   └── plans/                       # 实施计划
└── package.json
```

## 开发流程

```bash
npm test         # 单元测试（pure functions）
npm run build    # 把 knowledge + lib 注入主脚本，产出 dist/weidian-ai-reply.user.js
```

每次改 `knowledge/`、`src/lib.mjs` 或 `src/main.js` 后都要重 build。把 dist 内容粘到 Tampermonkey 替换原脚本，然后刷新 IM 页面。

## 装好后的使用

页面 console 里：

```js
// 首次配置（自动持久化到 localStorage）
__wd.setKey('sk-你的 DeepSeek key')
__wd.setWebhook('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx')

// 开关
__wd.toggle()                  // autoreply ON ↔ OFF
__wd.sweepToggle()             // 自动扫描未读 ON ↔ OFF

// 调试
__wd.debug(true)               // 打印所有 WS 进线 + 跳过原因
__wd.sweep()                   // 手动触发一次未读扫描
__wd.send('文字', '买家uid')   // 手动发；不传 uid 用当前会话
await __wd.testAI('多久发货')   // 本地试 prompt 不依赖买家进线
__wd.conversations()           // 看会话状态 Map
__wd.testHistory('uid')        // 探 history API

// 忽略名单（不自动回复，比如供货商）
__wd.addIgnoreUid('uid', '名字')
__wd.clearIgnoreUids()

// 帮助
__wd.help()
```

## 数据流

**WS 实时路径**（买家发新消息）：
```
WS send_notify 帧
  ↓ classifyIncoming（fromSourceType===5008 + msgMediaType===1 = 买家文字）
  ↓ ignoreUids 检查 + msgId 去重
  ↓ keywordCheck（黑名单硬触发 → 直接 escalate）
  ↓ callDeepSeek（JSON mode；失败时自动重试 1 次 temp=0）
  ↓ parseAIOutput（剥 ```json``` 围栏 + 抠 {} + 空 draft 拒收）
  ↓
should_escalate=true → pushEscalation（reason: llm:...）→ 企微
should_escalate=false + autoreplyEnabled + 白名单 → sendReply(draft, buyerUid)
  ↓ 切 hash 到目标会话 → 等 1500ms React state 对齐
  ↓ 写文本 + Enter
  ↓ 验证 WS 出口帧（cmd:msg/sub:send/toUid 匹配）→ 否则推草稿到企微
should_escalate=false + 白名单外 → 只记 history、不发
```

**未读扫描路径**（兜底，默认每 5 分钟）：
```
discoverUnreadItems（DOM 找带 .unread-hot-tag 角标的会话）
  ↓ 逐个 item.click() 触发 hash 切换 → 微店前端自动 clearUnread
  ↓ onConversationSwitch(uid)
  ↓ 拉 history API + 过滤（最后一条非买家 → 跳过；倒序找买家文本）
  ↓ 命中后走 processText（同上）
```

**关键设计决策**：
- **永远不自组 WS send 帧**：UI 驱动（输入框 + Enter）保留页面 seq / 反爬 / state 流
- **失败永远 escalate，不蒙发**：API timeout / JSON 失败 / 编辑器有内容 / WS 帧未观察到 → 推草稿企微让人工
- **per-buyer 串行锁**（buyerLocks）+ **全局发送锁**（sendLock）双层防并发
- **30 分钟 Map 清理 + 60s switchHandler timeout + 5 分钟周期 sweep + WS 心跳**

## 持久化的 CFG（localStorage 键前缀 `wd-ai:`）

| key | 说明 |
|---|---|
| `deepseekApiKey` | DeepSeek key |
| `qywxWebhookUrl` | 企微机器人 webhook |
| `autoreplyEnabled` | 自动发送开关，默认关 |
| `testOnlyUids` | 白名单，空数组 = 全量 |
| `ignoreUids` | 忽略名单（供货商等不自动回） |
| `sweepOnLoad` | 周期扫描开关 |

## 当前阶段

- ✅ Phase 0：协议侦察
- ✅ Phase 1：WebSocket 监听
- ✅ Phase 2：UI 驱动发送
- ✅ Phase 3：DeepSeek 草稿
- ✅ Phase 4a：KB + Escalation + 企微推送
- ✅ Phase 4b：自动发送 + 配置持久化
- ✅ Phase 4d：未读扫描 + 消息过滤 + 稳定性（API timeout / sweep / cleanup / WS 心跳）
- ✅ 串发修复：sendReply 加 targetUid + 切换会话 + 全局 sendLock + WS 出口帧验证
- ✅ JSON 解析失败自动重试 + 宽松提取
- ⏭ 可能：FAQ 知识库热加载、企微 escalation 减少（看 prompt 调优效果）
