# Phase 0 — 微店 IM 协议侦察手册

> 这一步**只能你在自己已登录的微店客服后台里做**——脚本里的所有解析、发送都依赖这一步的结论。
> 没有这份笔记，后面写的代码都是瞎猜。

预计时间：30–60 分钟。准备：一个测试买家小号（或求朋友配合）。

---

## 0. 装好 Phase 1 监听脚本

把 [weidian-ai-reply.user.js](./weidian-ai-reply.user.js) 装进 Tampermonkey。
打开 `https://im.weidian.com/im-team/im-pc-2/`，刷新一次。
脚本会在 console 打出 `[wd-ai] hook installed, waiting for WebSocket(s)...`。

---

## 1. 抓 WebSocket 端点

1. F12 → **Network** 面板 → 顶部 filter 选 **WS**。
2. 刷新页面，等聊天列表加载好。
3. 你会看到一条或几条 WS 连接，**记下 URL**（形如 `wss://im.weidian.com/...`）。
   - 写进 `PROTOCOL_NOTES.WEBSOCKET_URL`
4. 点击那条 WS → **Messages** 标签页，应该能看到双向消息流。

---

## 2. 抓"进线消息"帧结构

1. 让测试买家发一条**最简单的纯文字**消息（比如"你好"）。
2. 在 Network → WS → Messages 找到刚收到的那一帧（绿色↓箭头），**右键 → Copy message**。
3. 粘贴到一个临时文件，逐字段标注：

   | 你看到的字段名 | 含义 | 示例值 |
   |---|---|---|
   | ? | 会话 ID | |
   | ? | 发送方 ID | |
   | ? | 发送方身份（buyer/seller/system） | |
   | ? | 消息类型 | text |
   | ? | 文字内容 | "你好" |
   | ? | 时间戳 | |

4. 再让测试买家做以下 3 类操作，每类抓一帧：
   - 从某商品页点"咨询客服"过来 → 应该带商品 ID 或商品卡片字段
   - 发一张图
   - 发一个表情/emoji
5. 写进 `PROTOCOL_NOTES.INCOMING_FRAME`。

⚠️ 在分享/提交这份笔记前，**把所有真实用户 ID、手机号、订单号脱敏成 `<USER_ID>` 这种占位符**。

---

## 3. 抓"发送回复"通道

1. 在客服页面**手动回**测试买家一句"收到"。
2. 同时观察：
   - Network → WS → Messages：有没有一条↑箭头的发送帧？如果有 → **走 WS 发送**。
   - Network → Fetch/XHR：有没有一条 POST 出去？如果有 → **走 HTTP 发送**。
3. 记下发送帧/请求的结构（URL、headers、body）→ `PROTOCOL_NOTES.OUTGOING`。

---

## 4. 找页面已暴露的 send 方法（最理想的发送通道）

这一步如果能找到，Phase 2 的 sender 代码会非常薄。

1. F12 → **Sources** 面板 → Ctrl+Shift+F 全文搜索：
   - `sendMessage`
   - `sendMsg`
   - `send_text`
   - `im.send`
   - `imSend`
2. 找到看起来像"客服发送"的函数，在那行打断点，再在页面手动发一条消息。
3. 断下后看调用栈：
   - 哪个 `window.xxx.yyy()` 是入口？
   - 入参格式是什么（会话 ID + text 字符串？还是一个 message 对象？）
4. 在 console 里**直接调一次**看能不能复现发送：
   ```js
   window.xxx.sendMessage({ conversationId: '<已知会话ID>', text: '测试' })
   ```
   如果能发出去，记下函数路径 → `PROTOCOL_NOTES.SEND_FUNCTION`。
5. 如果找不到暴露在 `window` 上的，记一下"必须走 WS.send 重放"或"必须走 fetch 重放"。

---

## 5. 抓商品上下文

买家从商品页咨询时，会话头部会显示商品卡片。你需要拿到这个商品的标题/价格/规格。

1. 看 Step 2 抓的"商品咨询"帧里有没有 `itemId` / `productId` / `goodsId` 字段。
2. 如果有：在 Network 里找请求商品详情的 API（看页面打开会话时发了什么 GET），记下 URL 和返回字段。
3. 如果没有：在 Elements 里找会话头部商品卡片的 DOM 节点（class 名通常含 `item` `goods` `product`），
   记下 CSS selector → `PROTOCOL_NOTES.PRODUCT_DOM_SELECTOR`。

---

## 6. 完成后填这份模板

把下面的内容（脱敏后）粘进 [weidian-ai-reply.user.js](./weidian-ai-reply.user.js) 顶部的
`PROTOCOL_NOTES` 注释块，作为后续所有 Phase 的事实源：

```
PROTOCOL_NOTES (last verified: YYYY-MM-DD)

WEBSOCKET_URL: wss://...

INCOMING_FRAME (text msg from buyer):
  { ... 真实样本（脱敏） ... }
  fields:
    conversation_id  →  data.xxx
    sender_id        →  data.yyy
    sender_role      →  data.zzz  (1=buyer, 2=seller, 3=system 或类似)
    msg_type         →  data.t    (text / image / item_card / order_card / system)
    text_content     →  data.body.text
    item_ref         →  data.body.item.id  (仅商品咨询入会时有)
    timestamp        →  data.ts

OUTGOING:
  channel: ws  (or http)
  WS frame: { ... 模板 ... }
  signature/sequence: 用 page method, 不自己组装

SEND_FUNCTION: window.__im_store.sendText(conversationId, text)
  (或：page method not exposed, must replay WS.send via captured proxy)

PRODUCT_CONTEXT:
  from frame: yes / no
  if from frame: itemId at data.body.item.id
  if from DOM: selector '.session-header .item-card'
  detail API: GET https://...?id=<itemId>  →  { title, price, sku, stock }
```

---

填好后告诉我，我们进 Phase 1 验证 + 写 Phase 2 的 sender。
