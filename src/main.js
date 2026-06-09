// ==UserScript==
// @name         微店 IM AI 自动回复（Phase 4b：自动发送 + 配置持久化）
// @namespace    https://im.weidian.com/
// @version      0.5.0
// @description  AI 自动回复（autoreplyEnabled 时真发）+ escalation 推企微 + key/webhook 持久化到 localStorage。
// @match        https://im.weidian.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.deepseek.com
// @connect      qyapi.weixin.qq.com
// ==/UserScript==

/*
================================================================================
PROTOCOL_NOTES  (Phase 0 完成度 ~90%；2026-06-08 在真实卖家号 "旷野户外" 上抓取)
================================================================================

WEBSOCKET
  endpoint: wss://im.weidian.com/wentry
  query:    time, wsid, sourceType  (含登录态，复用页面已有连接即可)
  仅一条 WS 连接承担所有 IM 流量；30s 心跳一次（headType:3）

帧头共有字段
  cmd:           "msg" | "follow"
  headType:      2 = 业务消息   3 = 心跳   9 = 其他 ping
  subCmd:        "send" | "send_ack" | "send_notify" | "cm_notify" | "common_notify"
  seq:           自增序号（页面自己维护）
  sourceType:    1001 = 卖家 PC 端
  uidStr / suid: 卖家自身 uid

================================================================================
INCOMING — 监听这些帧来触发 AI 回复
================================================================================

(1) 业务消息：cmd=msg, subCmd=send_notify
{
  cmd: "msg", subCmd: "send_notify", headType: 2,
  protocolContent: "{...stringified...}"  // 注意是 JSON 字符串，要再 parse 一次
}

protocolContent 解出后的通用字段：
  fromUid:         "8231960975030111227"   // 发送方 uid
  fromSourceType:  5008                    // 5008 = 买家发出 / 1001 = 卖家自己发出（回显）
  toUid:           "7761657479685210349"   // 接收方
  msgType:         1                       // 1 = 业务消息（图片/系统类型待抓）
  msgMediaType:    <见下表>                // ★ 真正区分内容子类的就是这个
  msgid / servMsgid / time
  detail:          子类型相关结构（JSON 字符串）
  msgData:         文字摘要 / 简版内容
  userData:        JSON 字符串，含 fromUserInfo:{name, headimg, userId}  // 买家昵称在这里

msgMediaType 子类型：
  1  = 普通文字消息
       msgData = 明文文字（发送时需 URL-encode）
       detail = '{"antispam_flag":0}'
  8  = 商品卡片（买家从商品页点"咨询客服"自动发的"引用商品"）
       msgData = "[商品]<商品标题>"
       detail（JSON 字符串）= {
         text: "[商品]<标题>",
         pic_url: "<商品主图>",
         data: { subTitle: "￥<价格>" },
         jump_url: "<商品页跳转>",
         card_type: 14,
         message_source: {
           id: "<itemId/商品 ID>",     // ★ Phase 4 拉商品详情用这个
           from: "<买家 uid>",
           time: <ts>, type: "2"
         }
       }
  其他子类（图片/订单卡/红包...）待抓

★ 判定"是买家发的、需要 AI 回复"：
   subCmd === 'send_notify' &&
   protocolContent.fromSourceType === 5008 &&
   protocolContent.msgMediaType === 1     // 只对文字触发；msgMediaType:8 是商品卡片，作为上下文

★ AI 上下文组装策略：
   收到文字时，向前找该买家最近一条 msgMediaType:8 商品卡片，把
   detail.text + detail.data.subTitle + detail.message_source.id 拼成商品上下文喂 prompt。
   需要更多（库存/规格）时拿 itemId 调 thor.weidian.com 接口。

(2) 输入指示器：cmd=msg, subCmd=cm_notify
  protocolContent.commType === 2  → "正在输入..."（应忽略，别触发 AI）
  protocolContent.commType === 3  → 似乎是"消息到达通知"（仍带 msgid="0"，要忽略，等 send_notify）

(3) 关注/常用通知：cmd=follow → 忽略（系统通知、读已读等）

(4) 还要触发 send_ack（见 OUTGOING (2)）

================================================================================
OUTGOING — 发送回复（PC 网页发送走的就是 WebSocket）
================================================================================

(1) 卖家发文字消息：cmd=msg, subCmd=send（已抓到完整真实样本）
{
  cmd: "msg", sub: "send", subCmd: "send",
  seq: <自增>,
  headType: 2, sourceType: 1001, version: "1", ver: "1",
  uidStr: "<seller_uid>", source: 1001,
  vcode_session: "", vcode_usdata: "",
  msgExtend: '{"vcode_session":"","vcode_usdata":"","vcode_validate":""}',
  body: {
    detail: "",
    fromUid: "<seller_uid>",
    fromSourceType: 1001,
    toUid: "<buyer_uid>",
    toSourceType: "0",
    msgid: "<Date.now()*1000 + random3digit>",   // 客户端生成
    time: <Date.now()>,
    msgType: 1, mediaType: 1, msgMediaType: 1, msgSource: 0,
    innerUid: "<seller_uid>",
    msgData: encodeURIComponent("回复文字"),       // ★ 注意 URL-encoded
    userData: '{"contact_source_type":"6","lastMsgTime":<prev_ts>}'
  },
  protocolContent: JSON.stringify(body)            // 注意必须重复 stringify 一遍
}

(2) 收到 send_notify 后必须发 send_ack 确认（页面会自动做，我们不用管，但要知道存在）：
{
  cmd: "msg", sub: "send_ack", subCmd: "send_ack", seq: <自增>,
  body: { ackUid: "<msg.fromUid>", ackSourceType: <msg.fromSourceType>, ackMsgid: "<msg.servMsgid>" },
  ...
}

★ 重要决策：尽量不要自己组装上面的 (1) 帧，而是驱动页面 UI（往输入框写字 + 触发发送）。
  原因：页面有它自己的 seq 维护、可能的反爬埋点、错误重试逻辑。我们绕开越少越好。
  Phase 2 验证时用 UI 驱动；如果将来想节省成本不渲染输入框，再回头看自组帧。

================================================================================
HTTP API （会话上下文、历史、商品引用 — 留给 Phase 4 / Phase 5 用）
================================================================================

域名：thor.weidian.com，复用页面 cookie 即可（不要自己签名）

GET /imcontact/info.getInfos/1.0?param={"sourceType":1001,"targetUids":"<uid>"}
    → 拿用户名/头像

GET /imcontact/contact.conversation/1.0?param={"sourceType":1001,"targetUid":"<uid>","isOwnerContact":0}
    → 会话上下文（疑似含商品引用 — 待验证字段）

GET /immessage/history.getMessage/1.0?param={"direction":0,"limit":15,"startMsgId":"...","fromSourceType":1001,"targetUid":"<uid>"}
    → 历史消息（给 AI 当多轮上下文用）

GET /immessage/unread.clearUnread/1.0?param={"targetUid":"<uid>","fromSourceType":1001}
    → 清未读

POST /imcontact/pcInfo.combain/1.0  → 联系人聚合信息

★ 商品 ID 来源已确认：直接来自 msgMediaType:8 商品卡片帧的
  protocolContent.detail.message_source.id（详见上面"INCOMING"段说明）。
  contact.conversation 接口实际返回字段尚未抓，留作 Phase 4 拉库存/规格时再看。

================================================================================
关键 ID 记录（仅本店有效）
================================================================================
SELLER_UID  = "7761657479685210349"   // 旷野户外
TEST_BUYER_JASON_UID = "8231960975030111227"
================================================================================
*/

(function () {
  'use strict';

  const TAG = '[wd-ai]';

  // Tampermonkey sandbox: 写到页面真 window 必须用 unsafeWindow（@grant 非 none 时）
  const pageWindow = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  // {{INJECT_LIB}}

  // {{INJECT_KB}}

  // ===========================================================================
  // localStorage 持久化
  // ===========================================================================
  const LS_PREFIX = 'wd-ai:';
  function lsGet(key) {
    try { return localStorage.getItem(LS_PREFIX + key); } catch { return null; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(LS_PREFIX + key, val); } catch {}
  }

  // ===========================================================================
  // CONFIG ——使用前先填好下面这些
  // ===========================================================================
  const CFG = {
    // DeepSeek
    deepseekApiKey:  lsGet('deepseekApiKey') || 'sk-PLACEHOLDER-REPLACE-ME',
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
    qywxWebhookUrl: lsGet('qywxWebhookUrl') || '',
    qywxEnabled:    true,
    escalationDebounceMs: 60_000,  // 同买家 60s 内多次触发只推一次

    // 保守话术：所有 escalate 分支都用这个作为客户端兜底草稿
    fallbackText: '稍等，我需要帮您核实一下，马上回您~',

    // 自动发送开关（true = AI 草稿直接发给买家；false = 只 console 打草稿）
    autoreplyEnabled: lsGet('autoreplyEnabled') === 'true',
  };

  // ===========================================================================
  // 工具
  // ===========================================================================
  function tryParse(raw) {
    if (typeof raw !== 'string') return { kind: 'binary', byteLength: raw?.byteLength };
    try { return { kind: 'json', data: JSON.parse(raw) }; }
    catch { return { kind: 'text', text: raw }; }
  }
  function safeDecode(s) { try { return decodeURIComponent(s); } catch { return s; } }

  // ===========================================================================
  // 对话状态：每个买家独立的历史 + 最后看过的商品卡片
  // ===========================================================================
  const conversations = new Map();
  function getConv(buyerUid) {
    let c = conversations.get(buyerUid);
    if (!c) { c = { history: [], lastProductCard: null }; conversations.set(buyerUid, c); }
    return c;
  }
  function addToHistory(buyerUid, role, text) {
    const c = getConv(buyerUid);
    c.history.push({ role, text, ts: Date.now() });
    while (c.history.length > CFG.historyLimit) c.history.shift();
  }

  // ===========================================================================
  // 解析进线帧 → 业务事件
  // ===========================================================================
  function classifyIncoming(parsed) {
    if (parsed.kind !== 'json' || parsed.data?.subCmd !== 'send_notify') return null;
    let pc; try { pc = JSON.parse(parsed.data.protocolContent); } catch { return null; }
    if (pc.fromSourceType !== 5008) return null;   // 5008 = 买家发出；过滤掉卖家自己的回显
    const buyerUid = pc.fromUid;

    if (pc.msgMediaType === 8) {
      let detail = {}; try { detail = JSON.parse(pc.detail); } catch {}
      return {
        kind: 'product_card', buyerUid,
        title: detail.text || pc.msgData,
        price: detail.data?.subTitle,
        itemId: detail.message_source?.id,
        picUrl: detail.pic_url,
        jumpUrl: detail.jump_url,
      };
    }
    if (pc.msgMediaType === 1) {
      let buyerName = null;
      try { buyerName = JSON.parse(pc.userData || '{}')?.fromUserInfo?.name; } catch {}
      return { kind: 'text', buyerUid, buyerName, text: pc.msgData };
    }
    return { kind: 'unsupported_media', buyerUid, msgMediaType: pc.msgMediaType };
  }

  // ===========================================================================
  // 组装 prompt + 调 DeepSeek
  // ===========================================================================
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

    const res = await new Promise((resolve) => {
      try {
        GM_xmlhttpRequest({
          method: 'POST',
          url: CFG.qywxWebhookUrl,
          headers: { 'Content-Type': 'application/json' },
          data: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
          onload:    (r) => resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, text: r.responseText }),
          onerror:   (e) => resolve({ ok: false, status: 0, text: 'network: ' + (e?.error || e?.statusText || 'unknown') }),
          ontimeout: () => resolve({ ok: false, status: 0, text: 'timeout' }),
        });
      } catch (e) {
        resolve({ ok: false, status: 0, text: 'sync: ' + e.message });
      }
    });
    if (!res.ok) {
      console.error(TAG, '❌ 企微推送 HTTP', res.status, (res.text || '').slice(0, 200));
      return;
    }
    let json = {};
    try { json = JSON.parse(res.text); } catch {}
    if (json.errcode && json.errcode !== 0) {
      console.error(TAG, '❌ 企微推送 errcode:', json.errcode, json.errmsg);
    } else {
      console.log(TAG, '✅ 企微推送成功');
    }
  }

  // ===========================================================================
  // UI 驱动发送（Phase 4b）
  // ===========================================================================
  function findEditor() {
    // 微店 IM 输入框：class 含 textInput 的容器下 contenteditable 的 .editor
    const el = document.querySelector('.textInput .editor[contenteditable="true"]');
    if (el) return el;
    // fallback: 任何 contenteditable 在页面下半部（Phase 2 探针逻辑）
    for (const c of document.querySelectorAll('[contenteditable="true"]')) {
      const r = c.getBoundingClientRect();
      if (r.width > 100 && r.height > 20 && r.top > window.innerHeight / 2) return c;
    }
    return null;
  }

  async function sendReply(text) {
    const editor = findEditor();
    if (!editor) {
      console.error(TAG, '❌ 找不到输入框 (.textInput .editor)');
      return false;
    }
    editor.focus();
    // 清空已有内容
    document.execCommand('selectAll', false);
    document.execCommand('delete', false);
    // 写入 AI 回复
    document.execCommand('insertText', false, text);
    // 等一帧让框架同步状态
    await new Promise(r => setTimeout(r, 50));
    // 按 Enter 发送
    for (const evType of ['keydown', 'keypress', 'keyup']) {
      editor.dispatchEvent(new KeyboardEvent(evType, {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
      }));
    }
    console.log(TAG, '📤 已发送:', text.slice(0, 60));
    return true;
  }

  // ===========================================================================
  // 控制器
  // ===========================================================================
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

    // 自动答 ✓
    if (CFG.autoreplyEnabled) {
      const ok = await sendReply(aiResult.draft);
      if (!ok) console.error(TAG, '❌ 发送失败（输入框未找到），草稿:', aiResult.draft);
    }
  }

  // ===========================================================================
  // WebSocket 劫持
  // ===========================================================================
  const NativeWS = pageWindow.WebSocket;
  const sockets = [];

  function HookedWebSocket(url, protocols) {
    const ws = protocols !== undefined ? new NativeWS(url, protocols) : new NativeWS(url);
    const id = sockets.length;
    sockets.push(ws);
    console.log(`${TAG} WS[${id}] OPEN`, url.split('?')[0]);

    ws.addEventListener('message', (ev) => {
      const parsed = tryParse(ev.data);
      pageWindow.__wd_lastIncoming = parsed;
      // fire-and-forget；handleIncoming 内部已 try/catch
      handleIncoming(parsed).catch(e => console.error(TAG, e));
    });
    ws.addEventListener('close', (ev) => console.warn(`${TAG} WS[${id}] CLOSE`, ev.code));
    ws.addEventListener('error', (ev) => console.error(`${TAG} WS[${id}] ERROR`, ev));

    const origSend = ws.send.bind(ws);
    ws.send = function (payload) {
      pageWindow.__wd_lastOutgoing = tryParse(payload);
      return origSend(payload);
    };
    return ws;
  }
  HookedWebSocket.prototype = NativeWS.prototype;
  for (const k of ['CONNECTING','OPEN','CLOSING','CLOSED']) HookedWebSocket[k] = NativeWS[k];
  pageWindow.WebSocket = HookedWebSocket;

  // ===========================================================================
  // 调试入口
  // ===========================================================================
  pageWindow.__wd = {
    sockets: () => sockets,
    config: () => CFG,
    setKey: (k) => {
      CFG.deepseekApiKey = k;
      lsSet('deepseekApiKey', k);
      console.log(TAG, 'key 已更新（已持久化）');
    },
    setWebhook: (url) => {
      CFG.qywxWebhookUrl = url;
      lsSet('qywxWebhookUrl', url);
      console.log(TAG, 'webhook 已更新（已持久化）');
    },
    toggle: () => {
      CFG.autoreplyEnabled = !CFG.autoreplyEnabled;
      lsSet('autoreplyEnabled', String(CFG.autoreplyEnabled));
      console.log(TAG, `autoreply ${CFG.autoreplyEnabled ? '✅ 已开启' : '⏸️ 已关闭'}（已持久化）`);
      return CFG.autoreplyEnabled;
    },
    send: async (text) => {
      const ok = await sendReply(text);
      console.log(TAG, ok ? '✅ 手动发送成功' : '❌ 手动发送失败');
      return ok;
    },
    conversations: () => Array.from(conversations.entries()).map(([uid, c]) => ({
      uid, history: c.history, lastProductCard: c.lastProductCard
    })),
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
    help: () => console.log(`
${TAG} Phase 4b — 自动发送 + 配置持久化
  __wd.setKey('sk-xxx')        设置 DeepSeek key（持久化到 localStorage）
  __wd.setWebhook('https://...key=xxx')  设置企微 webhook（持久化）
  __wd.toggle()                开/关自动发送（持久化）  当前: ${CFG.autoreplyEnabled ? 'ON' : 'OFF'}
  __wd.send('测试文字')        手动发送到当前会话（验证输入框能否驱动）
  __wd.testAI('问题','商品','￥价格')  本地测 AI 草稿（不发送）
  __wd.conversations()         查看会话状态
  __wd.config()                查看完整配置
    `.trim()),
  };

  const status = [
    CFG.autoreplyEnabled ? '🟢 自动发送 ON' : '🔴 自动发送 OFF',
    CFG.deepseekApiKey.includes('PLACEHOLDER') ? '⚠️ key 未设置' : '✅ key 已配置',
    CFG.qywxWebhookUrl ? '✅ webhook 已配置' : '⚠️ webhook 未设置',
  ].join(' | ');
  console.log(`${TAG} Phase 4b 已加载. ${status}  调 __wd.help() 看用法`);
})();
