# weidian-ai-reply

微店客服 AI 自动回复（Phase 4b：自动发送 + 配置持久化）。

收到买家消息 → 关键词硬触发 / DeepSeek 自评 → 命中 escalate 推企微群机器人，未命中且 `autoreplyEnabled=true` 时 **UI 驱动真发送**。

## 项目结构

```
.
├── knowledge/                 # 知识库（人维护）
│   ├── prompt.md              # 高层风格 + 必须转人工清单
│   └── faq.md                 # 高频可自动回复话术
├── src/
│   ├── main.js                # Tampermonkey 壳（含 PROTOCOL_NOTES、CFG、控制器、WS hook）
│   └── lib.mjs                # 纯函数（parseAIOutput / keywordCheck / renderEscalationCard / createDebouncer）
├── scripts/
│   └── build.mjs              # 把 knowledge 和 lib 注入到 main.js，输出 dist/...user.js
├── tests/                     # node:test 单元测试
├── dist/
│   └── weidian-ai-reply.user.js  # Tampermonkey 装这个文件
├── docs/
│   ├── specs/                 # 设计文档
│   └── plans/                 # 实施计划
└── package.json
```

## 开发流程

```bash
# 单元测试（pure functions）
npm test

# 构建（每次改 knowledge/ 或 src/ 后跑）
npm run build
```

构建产物在 `dist/weidian-ai-reply.user.js`。把它的内容粘到 Tampermonkey 装好的脚本里替换，然后刷新 `im.weidian.com/im-team/im-pc-2/`。

## 装好后的使用

页面 console 里：

```js
// 首次配置（自动持久化到 localStorage，刷新后不用重填）
__wd.setKey('sk-你的 DeepSeek key')
__wd.setWebhook('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=你的企微机器人 key')

// 开启自动发送（默认关闭，手动开）
__wd.toggle()     // ON ↔ OFF 切换

// 验证发送通道（手动发一条到当前会话）
await __wd.send('测试文字')

// 本地测 prompt（不依赖买家进线）
await __wd.testAI('多久发货', '商品标题', '￥36')

// 查会话状态
__wd.conversations()

// 帮助
__wd.help()
```

## 数据流（Phase 4a）

```
买家文字
  ↓ keywordCheck
命中黑名单 → pushEscalation（reason: keyword:...）→ 企微推送
没命中 → DeepSeek（JSON mode）→ parseAIOutput
        ↓
      should_escalate=true → pushEscalation（reason: llm:...）→ 企微推送
      should_escalate=false + autoreplyEnabled → sendReply（UI 驱动输入框 + Enter）
      should_escalate=false + !autoreplyEnabled → 只 console 打草稿
JSON 解析失败 → 安全默认 escalate
```

去重：同买家 60s 内多次触发只推一次。
持久化：`deepseekApiKey`、`qywxWebhookUrl`、`autoreplyEnabled` 存 localStorage，刷新不丢。

## 当前阶段 / 接下来

- ✅ Phase 0：协议侦察
- ✅ Phase 1：WebSocket 监听
- ✅ Phase 2：UI 驱动发送（仅验证，未集成）
- ✅ Phase 3：DeepSeek 草稿
- ✅ Phase 4a：KB + Escalation + 企微推送
- ✅ Phase 4b：自动发送（UI 驱动）+ 配置持久化
- ⏭ Phase 4c（待定）：轻量防封号（rate limit + 人性化延迟 + kill switch）
- ⏭ Phase 5（待定）：FAQ 知识库热加载
