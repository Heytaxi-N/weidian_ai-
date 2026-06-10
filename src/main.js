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
    deepseekMaxTokens: 800,

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

    // 测试白名单：非空时只自动回复这些 uid，其他买家仍走草稿模式
    testOnlyUids: JSON.parse(lsGet('testOnlyUids') || '[]'),

    // 忽略名单：供货商等不需要自动回复的 uid
    ignoreUids: JSON.parse(lsGet('ignoreUids') || JSON.stringify([
      '7825662987032461371',  // 王麻子
      '8179235360781593369',  // wxy
      '7787185689990988027',  // 草帽出品【八点开拍】🎩
      '8263229450404666038',  // 西瓜汁
    ])),

    // 未读扫描
    sweepOnLoad: lsGet('sweepOnLoad') !== 'false',   // 页面加载后自动扫描未读
    sweepDelayMs:    1500,  // hash 变化后等多久再拉历史
    sweepIntervalMs: 3000,  // 扫描时两个会话之间的间隔
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
  // 消息去重：WS 实时路径和扫描路径共用，防止重复处理
  // ===========================================================================
  const processedMsgIds = new Set();
  const PROCESSED_MAX = 500;
  function markProcessed(msgId) {
    if (!msgId) return;
    processedMsgIds.add(msgId);
    if (processedMsgIds.size > PROCESSED_MAX) {
      const first = processedMsgIds.values().next().value;
      processedMsgIds.delete(first);
    }
  }

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
    if (pc.fromSourceType !== 5008) {
      // 非买家进线（系统提示、卖家回显、其他来源）；只在 debug 时打印
      if (pageWindow.__wd_debug) {
        console.log(TAG, '🔍 skip non-buyer:', pc.fromSourceType, 'mediaType:', pc.msgMediaType, 'fromUid:', pc.fromUid);
      }
      return null;
    }
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
      return { kind: 'text', buyerUid, buyerName, text: pc.msgData, msgId: pc.servMsgid || null };
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    let res;
    try {
      res = await fetch(CFG.deepseekUrl, {
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
        signal: controller.signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('DeepSeek 请求超时 (30s)');
      throw e;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`DeepSeek HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    const raw = (json.choices?.[0]?.message?.content || '').trim();
    const finishReason = json.choices?.[0]?.finish_reason;
    const parsed = parseAIOutput(raw);
    if (!parsed.ok) {
      // 安全默认：JSON 失败视为 escalate；附 finish_reason 帮助定位（length=被 max_tokens 截断）
      console.error(TAG, '❌ JSON 解析失败 finish=', finishReason, '原文:', raw);
      return {
        should_escalate: true,
        reason: `JSON 解析失败 (finish=${finishReason}): ${parsed.error} | 原文: ${raw.slice(0, 200)}`,
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
  // HTTP API 辅助（thor.weidian.com，复用页面 cookie）
  // ===========================================================================
  async function thorGet(path, params) {
    const url = `https://thor.weidian.com${path}?param=${encodeURIComponent(JSON.stringify(params))}`;
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`thor ${path} → ${res.status}`);
    return res.json();
  }

  async function fetchRecentMessages(targetUid, limit = 5) {
    return thorGet('/immessage/history.getMessage/1.0', {
      targetUid, startMsgId: '9223372036854775807', limit, direction: 0,
      fromSourceType: 1001, isLimitTag: true, searchType: 1,
    });
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

  function getCurrentHashUid() {
    const m = location.hash.match(/#\/session\/recent\/(\d+)/);
    return m ? m[1] : null;
  }

  // 全局发送串行锁：编辑器是单例 DOM 资源，必须保证同时只有一个 send 流程在动 hash 和编辑器
  let sendLock = Promise.resolve();
  function withSendLock(fn) {
    const next = sendLock.then(fn, fn);
    sendLock = next.catch(() => {});
    return next;
  }

  /**
   * 验证：Enter 后是否真的有一条 send 帧出去到目标 uid。
   * 微店页面切会话后，编辑器 DOM 存在但 React 内部 state 可能还指向旧会话，
   * execCommand+Enter 会静默失败（前端无报错，但 WS 没发出 send 帧）。
   * 必须通过 WS 出口帧确认。
   */
  async function verifyOutgoingSend(targetUid, beforeSnapshot, timeoutMs = 2000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const out = pageWindow.__wd_lastOutgoing;
      if (out && out !== beforeSnapshot && out.kind === 'json') {
        const d = out.data;
        if (d?.cmd === 'msg' && d?.sub === 'send' && String(d?.body?.toUid) === String(targetUid)) {
          return d;
        }
      }
      await new Promise(r => setTimeout(r, 100));
    }
    return null;
  }

  /**
   * 发送回复给指定买家。
   * targetUid 必填（防止串发）：会先把 hash 切到目标会话、等编辑器对齐再写入。
   * 编辑器里有非空草稿时直接放弃发送（避免覆盖人工输入），调用方应走 escalation。
   * 发送后通过 WS 出口帧验证；未观察到 send 帧 → 返 false（让调用方推草稿）。
   */
  async function sendReply(text, targetUid) {
    return withSendLock(async () => {
      // 1. hash 对齐：不匹配则切换（waitFor 在 Phase 4d 区块声明，函数提升后可用）
      if (targetUid) {
        const currentUid = getCurrentHashUid();
        if (currentUid !== targetUid) {
          console.log(TAG, '🔀 切换会话:', currentUid || '(none)', '→', targetUid);
          location.hash = '#/session/recent/' + targetUid;
          const hashOk = await waitFor(() => getCurrentHashUid() === targetUid, 3000, 100);
          if (!hashOk) {
            console.error(TAG, '❌ hash 切换超时，目标:', targetUid);
            return false;
          }
          const editorReady = await waitFor(findEditor, 3000, 100);
          if (!editorReady) {
            console.error(TAG, '❌ 切换后编辑器未出现:', targetUid);
            return false;
          }
          // React state / WS 订阅切到新会话需要 ~1.5s；之前 200ms 太短导致 Enter 静默失败
          await new Promise(r => setTimeout(r, 1500));
        }
      }

      // 2. 拿编辑器
      const editor = findEditor();
      if (!editor) {
        console.error(TAG, '❌ 找不到输入框 (.textInput .editor)');
        return false;
      }

      // 3. 内容守卫：有任何内容都不覆盖（可能是卖家正在打字）
      if (editor.textContent.trim().length > 0) {
        console.warn(TAG, '⚠️ 编辑器有内容，放弃发送（避免覆盖人工输入）:', targetUid || '(unknown)');
        return false;
      }

      // 4. 写入 + Enter，并捕获 Enter 前的最后一帧 outgoing 作为基线
      const beforeOut = pageWindow.__wd_lastOutgoing;
      editor.focus();
      document.execCommand('selectAll', false);
      document.execCommand('delete', false);
      document.execCommand('insertText', false, text);
      await new Promise(r => setTimeout(r, 50));
      for (const evType of ['keydown', 'keypress', 'keyup']) {
        editor.dispatchEvent(new KeyboardEvent(evType, {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
        }));
      }

      // 5. 验证 WS 出口帧 —— 这是判断是否真的发出去的唯一可靠信号
      const verifyTarget = targetUid || getCurrentHashUid();
      if (!verifyTarget) {
        console.warn(TAG, '⚠️ 无 targetUid 且 hash 无 uid，跳过验证');
        return true;
      }
      const sentFrame = await verifyOutgoingSend(verifyTarget, beforeOut, 2000);
      if (!sentFrame) {
        console.error(TAG, '❌ Enter 后未观察到 send 帧（页面 state 未对齐？）→', verifyTarget, ':', text.slice(0, 60));
        return false;
      }
      console.log(TAG, '📤 已发送（已验证 WS 帧）→', verifyTarget, ':', text.slice(0, 60));
      return true;
    });
  }

  // ===========================================================================
  // 控制器
  // ===========================================================================
  const buyerLocks = new Map();

  async function processText(ev, text) {
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
      await pushEscalation({
        buyerUid: ev.buyerUid, buyerName: ev.buyerName,
        draft: CFG.fallbackText,
        reason: 'LLM 调用失败: ' + e.message,
        currentText: text,
      });
      return;
    }

    if (aiResult.should_escalate) {
      addToHistory(ev.buyerUid, 'assistant', aiResult.draft);
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
      const whitelisted = CFG.testOnlyUids.length === 0
        || CFG.testOnlyUids.includes(ev.buyerUid);
      if (whitelisted) {
        const ok = await sendReply(aiResult.draft, ev.buyerUid);
        if (ok) {
          addToHistory(ev.buyerUid, 'assistant', aiResult.draft);
        } else {
          console.error(TAG, '❌ 发送失败 → 推草稿到企微:', aiResult.draft);
          await pushEscalation({
            buyerUid: ev.buyerUid, buyerName: ev.buyerName,
            draft: aiResult.draft,
            reason: 'sendReply 失败（会话切换超时 / 编辑器有内容 / 找不到编辑器）',
            currentText: text,
          });
        }
      } else {
        addToHistory(ev.buyerUid, 'assistant', aiResult.draft);
        console.log(TAG, '⏭️ 白名单外，仅草稿:', ev.buyerUid);
      }
    } else {
      addToHistory(ev.buyerUid, 'assistant', aiResult.draft);
    }
  }

  async function handleIncoming(parsed) {
    const ev = classifyIncoming(parsed);
    if (!ev) return;

    if (ev.kind === 'product_card') {
      const conv = getConv(ev.buyerUid);
      conv.lastProductCard = { ...ev, ts: Date.now() };
      console.log(TAG, '🛍️ 商品卡片', ev.buyerUid, ev.title, ev.price || '');
      return;
    }
    if (ev.kind !== 'text') {
      console.log(TAG, '⏭️ 非文本消息，不处理:', ev.buyerUid, 'kind=', ev.kind, 'mediaType=', ev.msgMediaType);
      return;
    }

    // 忽略名单（供货商等）
    if (CFG.ignoreUids.includes(ev.buyerUid)) {
      console.log(TAG, '⏭️ 忽略名单:', ev.buyerUid);
      return;
    }

    const text = safeDecode(ev.text || '');

    // 去重：同一条消息不处理两次（WS + 扫描路径可能重叠）
    if (ev.msgId && processedMsgIds.has(ev.msgId)) {
      console.log(TAG, '⏭️ 已处理过:', ev.msgId);
      return;
    }
    if (ev.msgId) markProcessed(ev.msgId);

    console.log(TAG, '👤', ev.buyerName || ev.buyerUid, '→', text);
    addToHistory(ev.buyerUid, 'user', text);

    // per-buyer 串行锁：上一条还在处理时排队，避免并发调 API
    const prev = buyerLocks.get(ev.buyerUid) || Promise.resolve();
    const current = prev.then(() => processText(ev, text)).catch(e => console.error(TAG, e));
    buyerLocks.set(ev.buyerUid, current);
  }

  // ===========================================================================
  // 会话切换监听 + 未读扫描（Phase 4d）
  // ===========================================================================

  // 轮询等待某个条件成立，最长 maxMs 毫秒
  function waitFor(fn, maxMs = 3000, interval = 200) {
    return new Promise(resolve => {
      const t0 = Date.now();
      const check = () => {
        const r = fn();
        if (r) return resolve(r);
        if (Date.now() - t0 > maxMs) return resolve(null);
        setTimeout(check, interval);
      };
      check();
    });
  }

  let sweepInProgress = false;    // 防止多次并发 sweep
  let switchHandlerBusy = false;  // 当前是否正在处理一个会话切换
  let switchBusySince = 0;        // busy 开始时间，用于超时保护

  /**
   * 会话切换处理：拉历史 → 找最新买家消息 → 走 AI 流程
   * 由 hashchange 或 sweep 点击触发
   */
  async function onConversationSwitch(buyerUid) {
    if (switchHandlerBusy) {
      if (Date.now() - switchBusySince > 60000) {
        console.warn(TAG, '⚠️ switchHandler 超时 60s，强制重置');
        switchHandlerBusy = false;
      } else {
        return;
      }
    }
    if (buyerUid === CFG.sellerUid) return;
    if (CFG.ignoreUids.includes(buyerUid)) return;
    switchHandlerBusy = true;
    switchBusySince = Date.now();
    try {
      console.log(TAG, '🔄 会话切换:', buyerUid);

      // 等页面加载会话（编辑器出现 = 会话已渲染）
      await new Promise(r => setTimeout(r, CFG.sweepDelayMs));
      const editor = await waitFor(findEditor, 3000);
      if (!editor) {
        console.warn(TAG, '⚠️ 编辑器未出现，跳过:', buyerUid);
        return;
      }

      // 检查编辑器是否有卖家正在输入的内容
      if (editor.textContent.trim().length > 0) {
        console.log(TAG, '⏭️ 编辑器有内容，跳过（避免覆盖）:', buyerUid);
        return;
      }

      // 拉历史消息
      let histResp;
      try {
        histResp = await fetchRecentMessages(buyerUid, 10);
      } catch (e) {
        console.error(TAG, '❌ 拉历史失败:', e.message);
        return;
      }
      const msgs = histResp?.result?.msgs;
      if (!msgs || msgs.length === 0) {
        console.log(TAG, '⏭️ 无历史消息:', buyerUid);
        return;
      }

      // 最后一条不是买家发的 → 无需再回（已回复 / 系统消息 / 其他客服）
      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg.fromUid !== buyerUid) {
        console.log(TAG, '⏭️ 最后一条非买家消息，跳过:', buyerUid);
        return;
      }

      // 从最新往旧找第一条买家文本消息（精确匹配 buyerUid，排除系统消息）
      let lastBuyerMsg = null;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.fromUid === buyerUid && m.msgMediaType === 1) {
          lastBuyerMsg = m;
          break;
        }
      }
      if (!lastBuyerMsg) {
        console.log(TAG, '⏭️ 无买家文本消息:', buyerUid);
        return;
      }

      // 去重
      const msgId = lastBuyerMsg.servMsgid;
      if (msgId && processedMsgIds.has(msgId)) {
        console.log(TAG, '⏭️ 已处理过:', msgId);
        return;
      }
      if (msgId) markProcessed(msgId);

      // 用历史预填 conversations Map（让 AI 有多轮上下文）
      // 只收买家消息和卖家回复，排除系统消息和其他客服
      const conv = getConv(buyerUid);
      if (conv.history.length === 0) {
        for (const m of msgs) {
          if (m.msgMediaType !== 1) continue;
          let role;
          if (m.fromUid === buyerUid) role = 'user';
          else if (m.fromUid === CFG.sellerUid) role = 'assistant';
          else continue;  // 系统消息、其他客服 → 不进历史
          const text = safeDecode(m.msgData || '');
          conv.history.push({ role, text, ts: parseInt(m.time) || Date.now() });
        }
        while (conv.history.length > CFG.historyLimit) conv.history.shift();
        // 移除最后一条（即将作为 currentText 传入 processText）
        if (conv.history.length > 0 && conv.history[conv.history.length - 1].role === 'user') {
          conv.history.pop();
        }
      }

      // 提取商品卡片上下文
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].msgMediaType === 8) {
          try {
            const detail = JSON.parse(msgs[i].detail || '{}');
            conv.lastProductCard = {
              title: detail.text || msgs[i].msgData,
              price: detail.data?.subTitle,
              itemId: detail.message_source?.id,
              ts: parseInt(msgs[i].time) || Date.now(),
            };
          } catch {}
          break;
        }
      }

      const text = safeDecode(lastBuyerMsg.msgData || '');
      let buyerName = null;
      try { buyerName = JSON.parse(lastBuyerMsg.userData || '{}')?.fromUserInfo?.name; } catch {}

      console.log(TAG, '📬 未读处理:', buyerName || buyerUid, '→', text);
      addToHistory(buyerUid, 'user', text);

      const ev = { buyerUid, buyerName };
      const prev = buyerLocks.get(buyerUid) || Promise.resolve();
      const current = prev.then(() => processText(ev, text)).catch(e => console.error(TAG, e));
      buyerLocks.set(buyerUid, current);
      await current;

    } finally {
      switchHandlerBusy = false;
    }
  }

  // hashchange 监听
  function setupHashChangeListener() {
    pageWindow.addEventListener('hashchange', () => {
      const match = location.hash.match(/#\/session\/recent\/(\d+)/);
      if (!match) return;
      const uid = match[1];
      onConversationSwitch(uid).catch(e => console.error(TAG, '会话切换处理失败:', e));
    });
    console.log(TAG, '🔗 hashchange 监听已注册');
  }

  /**
   * 发现侧边栏中有未读角标的会话项
   * 返回 DOM 元素数组（点击后触发 hash 导航）
   */
  function discoverUnreadItems() {
    const badges = document.querySelectorAll('.session-item-box .unread-hot-tag');
    const items = [];
    for (const badge of badges) {
      const count = parseInt(badge.textContent);
      if (!(count > 0)) continue;
      const box = badge.closest('.session-item-box');
      if (box) items.push(box);
    }
    return items;
  }

  /**
   * 扫描所有未读会话并依次处理
   */
  async function sweep() {
    if (!CFG.autoreplyEnabled) {
      console.log(TAG, '⏸️ sweep 跳过：autoreply 未开启');
      return { total: 0, processed: 0, skipped: 0 };
    }
    if (sweepInProgress) {
      console.log(TAG, '⏳ sweep 已在进行中');
      return null;
    }
    sweepInProgress = true;
    const stats = { total: 0, processed: 0, skipped: 0, errors: 0 };
    try {
      const items = discoverUnreadItems();
      stats.total = items.length;
      console.log(TAG, `🧹 sweep 开始：发现 ${items.length} 个未读会话`);

      for (const item of items) {
        try {
          // 点击会话项，触发 hash 导航
          item.click();
          // 等待 hash 变化
          await new Promise(r => setTimeout(r, 500));

          const match = location.hash.match(/#\/session\/recent\/(\d+)/);
          if (!match) {
            console.warn(TAG, '⚠️ 点击后 hash 未变化');
            stats.skipped++;
            continue;
          }
          const uid = match[1];

          // 白名单检查
          if (CFG.testOnlyUids.length > 0 && !CFG.testOnlyUids.includes(uid)) {
            console.log(TAG, '⏭️ sweep 白名单外:', uid);
            stats.skipped++;
            await new Promise(r => setTimeout(r, 500));
            continue;
          }

          await onConversationSwitch(uid);
          stats.processed++;
        } catch (e) {
          console.error(TAG, '❌ sweep 单项失败:', e.message);
          stats.errors++;
        }
        // 人性化间隔
        await new Promise(r => setTimeout(r, CFG.sweepIntervalMs));
      }

      console.log(TAG, `🧹 sweep 完成：${stats.total} 个未读，处理 ${stats.processed}，跳过 ${stats.skipped}，失败 ${stats.errors}`);
      return stats;
    } finally {
      sweepInProgress = false;
    }
  }

  /**
   * 清理过期的 Map 条目（30 分钟无活动）
   */
  function cleanupMaps() {
    const cutoff = Date.now() - 30 * 60 * 1000;
    let cleaned = 0;
    for (const [uid, conv] of conversations) {
      const lastTs = conv.history.length ? conv.history[conv.history.length - 1].ts : 0;
      if (lastTs < cutoff) {
        conversations.delete(uid);
        buyerLocks.delete(uid);
        cleaned++;
      }
    }
    if (cleaned > 0) console.log(TAG, `🧹 清理 ${cleaned} 个过期会话`);
  }

  /**
   * 页面加载后启动周期性扫描（首次 + 每 5 分钟）
   */
  let lastWsMessageAt = Date.now();

  async function startPeriodicSweep() {
    if (!CFG.sweepOnLoad) return;
    console.log(TAG, '⏳ 等待侧边栏加载...');
    const sidebar = await waitFor(
      () => document.querySelector('.sessions-list-box'),
      15000, 500
    );
    if (!sidebar) {
      console.warn(TAG, '⚠️ 侧边栏未加载，放弃自动扫描');
      return;
    }
    await new Promise(r => setTimeout(r, 3000));

    // 首次扫描
    if (CFG.autoreplyEnabled) {
      console.log(TAG, '🚀 启动首次自动扫描未读...');
      await sweep().catch(e => console.error(TAG, '首次扫描失败:', e));
    }

    // 之后每 5 分钟
    setInterval(() => {
      // WS 心跳检测
      if (Date.now() - lastWsMessageAt > 5 * 60 * 1000) {
        console.warn(TAG, '⚠️ 超过 5 分钟未收到 WS 消息，可能断连');
      }
      // 清理过期 Map
      cleanupMaps();
      // 周期性扫描
      if (CFG.autoreplyEnabled && CFG.sweepOnLoad && !sweepInProgress) {
        console.log(TAG, '🔄 周期性扫描...');
        sweep().catch(e => console.error(TAG, '周期扫描失败:', e));
      }
    }, 5 * 60 * 1000);
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
      lastWsMessageAt = Date.now();
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
    send: async (text, targetUid) => {
      const ok = await sendReply(text, targetUid);
      console.log(TAG, ok ? '✅ 手动发送成功' : '❌ 手动发送失败');
      return ok;
    },
    debug: (on = true) => {
      pageWindow.__wd_debug = on;
      console.log(TAG, on ? '🔍 debug 模式开（打印所有 WS 进线 + 跳过原因）' : '🔍 debug 模式关');
    },
    addTestUid: (uid) => {
      if (!CFG.testOnlyUids.includes(uid)) CFG.testOnlyUids.push(uid);
      lsSet('testOnlyUids', JSON.stringify(CFG.testOnlyUids));
      console.log(TAG, '白名单:', CFG.testOnlyUids);
    },
    clearTestUids: () => {
      CFG.testOnlyUids = [];
      lsSet('testOnlyUids', '[]');
      console.log(TAG, '白名单已清空（全量模式）');
    },
    addIgnoreUid: (uid, name) => {
      if (!CFG.ignoreUids.includes(uid)) CFG.ignoreUids.push(uid);
      lsSet('ignoreUids', JSON.stringify(CFG.ignoreUids));
      console.log(TAG, `忽略名单${name ? '('+name+')' : ''}:`, CFG.ignoreUids);
    },
    clearIgnoreUids: () => {
      CFG.ignoreUids = [];
      lsSet('ignoreUids', '[]');
      console.log(TAG, '忽略名单已清空');
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
    testHistory: async (uid) => {
      const r = await fetchRecentMessages(uid || CFG.sellerUid);
      console.log(TAG, '📜 history API 响应:', JSON.stringify(r, null, 2));
      return r;
    },
    sweep: () => sweep(),
    sweepToggle: () => {
      CFG.sweepOnLoad = !CFG.sweepOnLoad;
      lsSet('sweepOnLoad', String(CFG.sweepOnLoad));
      console.log(TAG, `sweepOnLoad ${CFG.sweepOnLoad ? '✅ 已开启' : '⏸️ 已关闭'}（已持久化）`);
      return CFG.sweepOnLoad;
    },
    help: () => console.log(`
${TAG} Phase 4d — 自动发送 + 未读扫描
  __wd.setKey('sk-xxx')        设置 DeepSeek key（持久化）
  __wd.setWebhook('https://...key=xxx')  设置企微 webhook（持久化）
  __wd.toggle()                开/关自动发送（持久化）  当前: ${CFG.autoreplyEnabled ? 'ON' : 'OFF'}
  __wd.addTestUid('uid')       加买家到白名单（持久化）  白名单非空时只回复白名单内的人
  __wd.clearTestUids()         清空白名单（= 全量模式）
  __wd.addIgnoreUid('uid')     加到忽略名单（持久化）  供货商等永不自动回复
  __wd.clearIgnoreUids()       清空忽略名单
  __wd.sweep()                 手动扫描未读会话
  __wd.sweepToggle()           开/关页面加载自动扫描  当前: ${CFG.sweepOnLoad ? 'ON' : 'OFF'}
  __wd.send('测试文字')        手动发送到当前会话
  __wd.testAI('问题','商品','￥价格')  本地测 AI 草稿（不发送）
  __wd.testHistory('uid')      探测 history API 响应格式
  __wd.conversations()         查看会话状态
  __wd.config()                查看完整配置
    `.trim()),
  };

  // 启动：注册 hashchange 监听 + 自动扫描
  setupHashChangeListener();

  const status = [
    CFG.autoreplyEnabled ? '🟢 自动发送 ON' : '🔴 自动发送 OFF',
    CFG.deepseekApiKey.includes('PLACEHOLDER') ? '⚠️ key 未设置' : '✅ key',
    CFG.qywxWebhookUrl ? '✅ webhook' : '⚠️ webhook 未设置',
    CFG.testOnlyUids.length > 0 ? `🧪 白名单: ${CFG.testOnlyUids.length} 人` : '',
    CFG.sweepOnLoad ? '🧹 自动扫描 ON' : '',
    CFG.ignoreUids.length > 0 ? `🚫 忽略: ${CFG.ignoreUids.length} 人` : '',
  ].filter(Boolean).join(' | ');
  console.log(`${TAG} Phase 4d 已加载. ${status}  调 __wd.help() 看用法`);

  // 页面加载后启动周期性扫描（首次 + 每 5 分钟）
  if (document.readyState === 'complete') {
    startPeriodicSweep().catch(e => console.error(TAG, '周期扫描启动失败:', e));
  } else {
    window.addEventListener('load', () => {
      startPeriodicSweep().catch(e => console.error(TAG, '周期扫描启动失败:', e));
    });
  }
})();
