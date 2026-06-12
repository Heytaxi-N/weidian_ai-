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

  // Pure, side-effect-free functions. Tested by tests/*.test.mjs.
// Built into dist/ by scripts/build.mjs (which strips the `export ` keywords).

/**
 * 从原始响应里抠出 JSON 对象。处理三种情况：
 * 1. 纯 JSON                   → 原样返回
 * 2. ```json...``` 代码块包裹  → 剥掉围栏
 * 3. JSON 前后有废话           → 用最外层 {...} regex 提取
 * 空字符串 / 找不到 {} → 返回空字符串（上层会判定为 parse 失败）
 */
function extractJSON(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim();
  if (!s) return '';
  // 剥代码块围栏
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  // 已经是 JSON 对象就直接返回
  if (s.startsWith('{') && s.endsWith('}')) return s;
  // 否则用 regex 找最外层大括号
  const m = s.match(/\{[\s\S]*\}/);
  return m ? m[0] : '';
}

function parseAIOutput(raw) {
  const cleaned = extractJSON(raw);
  if (!cleaned) {
    return { ok: false, error: 'empty or no JSON object found' };
  }
  let obj;
  try {
    obj = JSON.parse(cleaned);
  } catch (e) {
    return { ok: false, error: 'JSON parse failed: ' + e.message };
  }
  if (typeof obj.should_escalate !== 'boolean') {
    return { ok: false, error: 'should_escalate missing or wrong type' };
  }
  if (typeof obj.draft !== 'string' || obj.draft.trim() === '') {
    return { ok: false, error: 'draft missing or empty' };
  }
  const reason = typeof obj.reason === 'string' ? obj.reason : '';
  return { ok: true, value: { should_escalate: obj.should_escalate, reason, draft: obj.draft } };
}

function keywordCheck(text, blacklist) {
  for (const kw of blacklist) {
    if (text.includes(kw)) return { hit: true, term: kw };
  }
  return { hit: false };
}

function renderEscalationCard({ sellerName, buyerName, buyerUid, recentTexts, draft, reason }) {
  const url = `https://im.weidian.com/im-team/im-pc-2/#/session/recent/${buyerUid}`;
  const lines = [];
  lines.push(`**🛎 需要人工：${sellerName} 客服**`);
  lines.push('');
  lines.push(`> **客户**：${buyerName || buyerUid}`);
  lines.push(`> **会话**：[点击进入](${url})`);
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

function createDebouncer(intervalMs, nowFn = Date.now) {
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

  const __KB_PROMPT__ = "你是微店\"旷野户外\"的客服助手，不要认为自己是ai，而认为自己是一个真人客服。\n\n目标：\n- 帮助提高下单转化率，促进成交。\n- 根据当前买家最后一条消息，生成一条可直接代填给客服审核的回复。\n- 回复要短、自然、像真人客服，不要解释规则。\n- 你需要表达关心和理解，让客户感到有温度和信任感。\n- 可以适当加emoji，增加活人感，最多加一个emoji\n\n\n语气：\n- 亲切、简洁、不过度热情。\n- 可以使用\"亲\"\"～\"，但不要堆叠。\n- 不要说\"我是 AI\"。\n\nshould_escalate 判断规则（非常重要）：\n- 默认 should_escalate: false。绝大多数情况下你都应该直接回复。\n- should_escalate: true 只用于买家情绪激动、投诉维权、明确要求赔偿这类严重场景。\n- 如果你能生成一条有用的回复（哪怕是安抚、追问、缓冲），就设为 false。\n- \"需要查后台\"不是转人工的理由——先回一句\"帮您核实一下，稍等\"就行。\n- \"消息模糊\"不是转人工的理由——追问一句\"您说的是哪款商品呢？\"就行。\n\n允许直接回复（should_escalate: false）：\n- 快递类型、是否支持指定快递或顺丰。\n- 发货时效的一般说明。\n- 优惠券、包邮、议价规则。\n- 尺码选择建议。\n- 商品的低风险常规咨询，例如版型、软硬、厚薄、搭配、适合季节、是否偏大偏小。回答要保守，可提示买家参考商品详情、尺码表或自身习惯。\n- 退换货基础流程。\n- 售后正在处理这类低风险安抚。\n- 物流查询、订单状态、库存等需要查后台的问题 → 回复\"帮您核实一下，稍等哦～\"。\n- 买家消息模糊不清 → 追问具体需求。例如\"能有吗\"→\"亲，您想问的是哪款商品呢？\"\n- 打招呼、问好、简单寒暄 → 正常回应。\n- 催发货、问物流 → 按话术安抚。\n- 收到部分商品、还有没收到的 → 回复\"帮您看一下，稍等\"。\n\n必须转人工（should_escalate: true）——仅以下几种：\n- 买家明确表达不满、情绪激动、威胁差评/投诉/举报。\n- 要求赔偿、补偿、金额争议。\n- 质量问题：破损、瑕疵、发错货、少发且买家语气不满。\n- 要求立刻退款、拦截快递。\n- 平台介入、12315、工商。\n";
const __KB_FAQ__    = "# 高频可自动回复话术\n\n以下内容或类似语义可以自动回复。回复时尽量使用这里的固定话术，不要额外承诺。\n\n## 多久发货\n\n适用问题：\n- 多久发货\n- 什么时候发货\n- 几天发货\n- 下单多久发\n\n可自动回复：\n下单默认 1-5 天发货，请放心，所有订单我们都会马上安排。但部分商品存在分批拿货、现做现卖、爆款翻单等情况，所以不一定能现货发出，请您理解。如果特别急，可以咨询客服具体发货时效，以免耽误您拿到衣服。\n\n禁止承诺：\n- 不承诺当天一定发\n- 不承诺具体到达日期\n\n## 今天能发吗\n\n适用问题：\n- 今天能发吗\n- 今天可以发吗\n- 今天发得出吗\n\n可自动回复：\n一般 2 天左右发货，仓库有现货的也可以当天发。放心都安排好了～\n\n禁止承诺：\n- 不承诺一定当天发\n- 不承诺一定有现货\n\n## 催发货或等了很久\n\n适用问题：\n- 什么时候发货啊\n- 等了好久了\n- 怎么还没发\n- 还没发货吗\n\n可自动回复：\n一般 1-5 天发货亲，发了晚上会更新单号的，麻烦您再耐心等待下～\n\n禁止承诺：\n- 不承诺当天一定发\n- 不承诺马上出单号\n\n## 物流为什么不更新\n\n适用问题：\n- 物流为什么不更新\n- 物流没动\n- 没有物流信息\n- 单号不更新\n\n可自动回复：\n已经安排好了亲，今明两天会发出。放心～\n\n禁止承诺：\n- 不承诺具体几点更新\n- 不处理异常物流争议\n\n## 发什么快递\n\n适用问题：\n- 发什么快递\n- 默认什么快递\n- 用哪个快递\n\n可自动回复：\n一般圆通或者申通。\n\n禁止承诺：\n- 不承诺一定是圆通\n- 不承诺一定是申通\n\n## 能不能指定快递\n\n适用问题：\n- 能不能指定快递\n- 可以指定快递吗\n- 指定发某个快递\n\n可自动回复：\n不支持指定快递亲。\n\n## 能不能发顺丰\n\n适用问题：\n- 能不能发顺丰\n- 可以顺丰吗\n- 发顺丰多少钱\n- 顺丰补多少钱\n\n可自动回复：\n多件的不支持发顺丰亲，单件可以。只支持寄付，标快补 15，特快补 20。\n\n禁止承诺：\n- 多件不承诺发顺丰\n- 不承诺顺丰到达时间\n\n## 多久能到\n\n适用问题：\n- 多久能到\n- 几天到\n- 什么时候到\n- 到我这里要多久\n\n可自动回复：\n一般青岛发货，您可以看下估计下到达需要多久。\n\n禁止承诺：\n- 不承诺具体到达日期\n\n## 改地址\n\n适用问题：\n- 能不能改地址\n- 地址错了\n- 地址没改\n- 改一下地址\n\n可自动回复：\n可以亲，提供正确的信息就行。如果客服没回，请申请退款重新拍就好～\n\n注意：\n- 只回复流程，不承诺一定修改成功\n\n## 改颜色或尺码\n\n适用问题：\n- 能不能改颜色\n- 能不能改尺码\n- 颜色选错了\n- 尺码选错了\n\n可自动回复：\n可以亲，提供正确的信息就行。如果客服没回，请申请退款重新拍就好。\n\n注意：\n- 只回复流程，不承诺一定修改成功\n\n## 能不能退换\n\n适用问题：\n- 能不能退\n- 能不能换\n- 支持退换吗\n- 不合适可以退吗\n\n可自动回复：\n可以的亲，店铺未标不退不换之类的产品，均支持签收 7 天内寄出退换货。请在签收 7 天内将商品寄出就好，如果觉得不合适请尽快退回～\n\n禁止承诺：\n- 不自动判断某个具体订单是否符合退换\n- 不处理质量争议责任\n\n## 签收后什么时候退款\n\n适用问题：\n- 签收了什么时候退款\n- 退货签收了怎么还没退\n- 什么时候处理退款\n\n可自动回复：\n您好，这边快递站快递比较多，会马上处理的。平台交易，售后无忧的，您放心～\n\n禁止承诺：\n- 不承诺具体退款到账时间\n\n## 退款金额不对\n\n适用问题：\n- 退款金额不对\n- 怎么少退了\n- 少退钱了\n- 退款少了\n\n可自动回复：\n您好，下单的时候应该使用了优惠券，自动扣除优惠券的部分了～\n\n禁止承诺：\n- 不承诺补退款\n- 用户继续争议时转人工\n\n## 申请退款处理\n\n适用问题：\n- 申请退款了处理下\n- 退款申请麻烦处理\n- 帮我处理退款\n\n可自动回复：\n好的亲，一会售后会统一处理的哈～\n\n禁止承诺：\n- 不承诺立即处理\n- 不承诺一定通过\n\n## 还没处理给地址\n\n适用问题：\n- 还没处理呢\n- 给个地址\n- 退货地址\n- 地址发我\n\n可自动回复：\n好嘞，售后正在处理了，您别急～\n\n禁止承诺：\n- 不直接编造退货地址\n\n## 尺码没选对怎么换货\n\n适用问题：\n- 尺码没选对怎么换货\n- 买错码了怎么换\n- 换尺码怎么办\n\n可自动回复：\n换货您直接退款，重新拍就行，这样发货快，也不会乱～\n\n## 身高体重穿什么码\n\n适用问题：\n- 我的身高体重穿什么码\n- 多高多重穿什么码\n- 尺码怎么选\n- XL 会不会大\n\n可自动回复：\n由于每个人的身材差异较大，建议您自行选择。每个产品都有尺码表和建议体重，客服会根据经验进行推荐，您可以参考尺码表进行选择～\n\n禁止承诺：\n- 不保证推荐尺码一定合适\n\n## 有没有优惠\n\n适用问题：\n- 有没有优惠\n- 可以便宜吗\n- 有券吗\n- 能优惠吗\n\n可自动回复：\n小店利润低，不议价哈。新朋友享 15 元优惠券，老朋友复购享 18 元复购券，除此之外还有会员折扣，很优惠的～\n\n## 包邮\n\n适用问题：\n- 包个邮呗\n- 可以包邮吗\n- 能不能包邮\n\n可自动回复：\n小店利润低，不议价哈。新朋友享 15 元优惠券，老朋友复购享 18 元复购券，除此之外还有会员折扣，很优惠的～\n\n禁止承诺：\n- 不自动判断“买的多”的标准\n";

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
    deepseekMaxAttempts: 3,        // 含首次：空响应偶发，多试几次降频
    deepseekRetryDelayMs: 500,     // 重试退避基数（第 n 次重试等 n*这个值）

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
    periodicSweepMs: 120_000,  // 周期性扫描间隔（2 分钟，降低漏消息延迟）
    wsStaleMs:       90_000,   // WS 超过这么久无消息视为可能断连 → 触发补扫

    // 发送重试（瞬时类失败：切会话超时 / 编辑器未出现 / 未观察到 WS 帧）
    sendMaxAttempts: 2,     // 含首次
    sendRetryDelayMs: 800,
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
  const PROCESSED_MAX = 2000;  // 高量长跑下太小会滚动失效导致罕见重处理
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

  async function deepseekOnce(messages, temperature) {
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
          temperature,
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
    const raw = json.choices?.[0]?.message?.content || '';
    const finishReason = json.choices?.[0]?.finish_reason;
    const parsed = parseAIOutput(raw);
    return { parsed, raw, finishReason };
  }

  async function callDeepSeek(messages) {
    if (!CFG.deepseekApiKey || CFG.deepseekApiKey.includes('PLACEHOLDER')) {
      throw new Error('DeepSeek API key 还没填，改 CFG.deepseekApiKey 或调 __wd.setKey(...)');
    }

    // 循环式重试：首次用配置温度，之后用 temp=0（更确定的 JSON），带退避。
    // 空响应是 v4-flash 服务端毛刺，多试几次降频；全失败仍 escalate（红线：不凑合发）。
    const maxAttempts = Math.max(1, CFG.deepseekMaxAttempts);
    let attempt = null;
    let lastError = '(未尝试)';
    for (let i = 0; i < maxAttempts; i++) {
      if (i > 0) {
        await new Promise(r => setTimeout(r, CFG.deepseekRetryDelayMs * i));  // 退避
      }
      const temp = i === 0 ? CFG.deepseekTemperature : 0;
      try {
        attempt = await deepseekOnce(messages, temp);
      } catch (e) {
        // 请求本身抛异常（超时 / HTTP 错误）→ 记真实错误，不让上一轮残留掩盖
        attempt = null;
        lastError = e.message;
        console.error(TAG, `❌ 第 ${i + 1} 次请求失败：`, e.message);
        continue;
      }
      if (attempt.parsed.ok) {
        if (i > 0) console.log(TAG, `✅ 重试成功（第 ${i + 1} 次）`);
        return attempt.parsed.value;
      }
      lastError = attempt.parsed.error;
      console.warn(TAG, `⚠️ 第 ${i + 1} 次 JSON 解析失败：`, attempt.parsed.error, '原文长度:', attempt.raw.length);
    }

    // 全部失败 → escalate（attempt 可能为 null，需兼容）
    const finishReason = attempt?.finishReason;
    const raw = attempt?.raw || '';
    console.error(TAG, `❌ JSON 解析失败（${maxAttempts} 次后）finish=`, finishReason, '原文:', raw);
    return {
      should_escalate: true,
      reason: `JSON 解析失败 (${maxAttempts} 次后, finish=${finishReason}): ${lastError} | 原文: ${raw.slice(0, 200)}`,
      draft: CFG.fallbackText,
    };
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
  // 单次发送尝试。返回 { ok } 或 { ok:false, cause }，
  // cause ∈ 'switch_timeout' | 'no_editor' | 'editor_busy' | 'no_frame'。
  async function attemptSend(text, targetUid) {
    // 1. hash 对齐：不匹配则切换（waitFor 在 Phase 4d 区块声明，函数提升后可用）
    if (targetUid) {
      const currentUid = getCurrentHashUid();
      if (currentUid !== targetUid) {
        console.log(TAG, '🔀 切换会话:', currentUid || '(none)', '→', targetUid);
        location.hash = '#/session/recent/' + targetUid;
        const hashOk = await waitFor(() => getCurrentHashUid() === targetUid, 3000, 100);
        if (!hashOk) {
          console.error(TAG, '❌ hash 切换超时，目标:', targetUid);
          return { ok: false, cause: 'switch_timeout' };
        }
        const editorReady = await waitFor(findEditor, 3000, 100);
        if (!editorReady) {
          console.error(TAG, '❌ 切换后编辑器未出现:', targetUid);
          return { ok: false, cause: 'no_editor' };
        }
        // React state / WS 订阅切到新会话需要 ~1.5s；之前 200ms 太短导致 Enter 静默失败
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    // 2. 拿编辑器
    const editor = findEditor();
    if (!editor) {
      console.error(TAG, '❌ 找不到输入框 (.textInput .editor)');
      return { ok: false, cause: 'no_editor' };
    }

    // 3. 内容守卫：有任何内容都不覆盖（可能是卖家正在打字）
    if (editor.textContent.trim().length > 0) {
      console.warn(TAG, '⚠️ 编辑器有内容，放弃发送（避免覆盖人工输入）:', targetUid || '(unknown)');
      return { ok: false, cause: 'editor_busy' };
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
      return { ok: true };
    }
    const sentFrame = await verifyOutgoingSend(verifyTarget, beforeOut, 2000);
    if (!sentFrame) {
      console.error(TAG, '❌ Enter 后未观察到 send 帧（页面 state 未对齐？）→', verifyTarget, ':', text.slice(0, 60));
      // 清掉 insertText 残留的草稿，否则编辑器单例会卡住后续对任何买家的发送（必中 editor_busy）。
      // 真发出去的情况页面已清空，再清一次也无害。
      const ed = findEditor();
      if (ed && ed.textContent.trim().length > 0) {
        ed.focus();
        document.execCommand('selectAll', false);
        document.execCommand('delete', false);
      }
      return { ok: false, cause: 'no_frame' };
    }
    console.log(TAG, '📤 已发送（已验证 WS 帧）→', verifyTarget, ':', text.slice(0, 60));
    return { ok: true };
  }

  // 瞬时类失败可重试；editor_busy（人工在打字）不重试，直接交还调用方走 escalation。
  const RETRYABLE_SEND_CAUSES = new Set(['switch_timeout', 'no_editor', 'no_frame']);

  /**
   * 发送回复给指定买家。返回 { ok:true } 或 { ok:false, cause }。
   * targetUid 必填（防止串发）：会先把 hash 切到目标会话、等编辑器对齐再写入。
   * 瞬时失败在锁内有限重试；仍失败时返回 cause 让调用方推草稿（红线：不凑合发）。
   */
  async function sendReply(text, targetUid) {
    return withSendLock(async () => {
      const maxAttempts = Math.max(1, CFG.sendMaxAttempts);
      let result = { ok: false, cause: 'switch_timeout' };
      for (let i = 0; i < maxAttempts; i++) {
        if (i > 0) {
          console.warn(TAG, `🔁 发送重试（第 ${i + 1} 次），上次 cause=${result.cause} →`, targetUid);
          await new Promise(r => setTimeout(r, CFG.sendRetryDelayMs));
        }
        result = await attemptSend(text, targetUid);
        if (result.ok) return result;
        if (!RETRYABLE_SEND_CAUSES.has(result.cause)) break;  // editor_busy 等不重试
      }
      return result;
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
        const sent = await sendReply(aiResult.draft, ev.buyerUid);
        if (sent.ok) {
          addToHistory(ev.buyerUid, 'assistant', aiResult.draft);
        } else {
          console.error(TAG, '❌ 发送失败 → 推草稿到企微:', sent.cause, aiResult.draft);
          await pushEscalation({
            buyerUid: ev.buyerUid, buyerName: ev.buyerName,
            draft: aiResult.draft,
            reason: 'sendReply 失败: ' + sent.cause,
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
   * 找侧边栏的可滚动容器。微店侧边栏是虚拟列表，未读项可能在视口外没渲染，
   * 必须滚动才能让 discoverUnreadItems 看到。优先 .sessions-list-box，
   * 不可滚动则找它下面第一个可滚动子节点，回退到自身。
   */
  function getSidebarScroller() {
    const box = document.querySelector('.sessions-list-box');
    if (!box) return null;
    if (box.scrollHeight > box.clientHeight + 5) return box;
    for (const el of box.querySelectorAll('*')) {
      if (el.scrollHeight > el.clientHeight + 5) return el;
    }
    return box;
  }

  /**
   * 「重头扫」遍历未读：每处理一条就回到列表最顶重开一轮，直到某一轮从顶滚到底都
   * 找不到未读才收工。原因：处理一条会话会把它标记已读**并把它顶到列表最前**（重排），
   * 单向往下扫会漏掉扫描位置上方新冒出的未读，故每轮 restart-from-top。
   * seen 去重 + 轮数/滚动次数上限防死循环。
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
    const seen = new Set();
    try {
      const scroller = getSidebarScroller();
      console.log(TAG, '🧹 sweep 开始（重头扫未读）');

      const MAX_ROUNDS = 100;
      const MAX_SCROLL = 100;
      let processedThisRound = true;
      for (let round = 0; round < MAX_ROUNDS && processedThisRound; round++) {
        processedThisRound = false;
        // 每轮都回到最顶重新扫，确保上方新未读不被落下
        if (scroller) {
          scroller.scrollTop = 0;
          await new Promise(r => setTimeout(r, 300));
        }

        for (let s = 0; s < MAX_SCROLL; s++) {
          const items = discoverUnreadItems();
          if (items.length > 0) {
            let handled = false;
            try {
              // 点最靠前的未读项，触发 hash 导航（也会把它标记已读，角标消失）
              items[0].click();
              await new Promise(r => setTimeout(r, 500));

              const match = location.hash.match(/#\/session\/recent\/(\d+)/);
              if (!match) {
                console.warn(TAG, '⚠️ 点击后 hash 未变化');
                stats.skipped++;
              } else {
                const uid = match[1];
                if (!seen.has(uid)) {
                  seen.add(uid);
                  stats.total++;
                  if (CFG.testOnlyUids.length > 0 && !CFG.testOnlyUids.includes(uid)) {
                    console.log(TAG, '⏭️ sweep 白名单外:', uid);
                    stats.skipped++;
                  } else {
                    await onConversationSwitch(uid);
                    stats.processed++;
                  }
                  handled = true;
                }
                // uid 已在 seen（角标未即时清掉/重复）→ handled 保持 false，落到下面往下滚过它
              }
            } catch (e) {
              console.error(TAG, '❌ sweep 单项失败:', e.message);
              stats.errors++;
            }
            if (handled) {
              // 真处理了一条 → 人性化间隔后回到外层重开一轮（从顶再扫）
              await new Promise(r => setTimeout(r, CFG.sweepIntervalMs));
              processedThisRound = true;
              break;
            }
            // 未处理（seen / hash 没变）→ 不重开轮，往下滚过它
          }

          // 当前视口无新未读 → 向下滚一屏继续找；已到底则结束本轮
          if (!scroller) break;
          const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 5;
          if (atBottom) break;
          scroller.scrollTop = Math.min(scroller.scrollTop + scroller.clientHeight, scroller.scrollHeight);
          await new Promise(r => setTimeout(r, 400));
        }
      }

      console.log(TAG, `🧹 sweep 完成：处理 ${stats.processed}，跳过 ${stats.skipped}，失败 ${stats.errors}`);
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
        escalationDebouncer.reset(uid);  // 否则 debouncer 内部 Map 永不清理，长跑泄漏
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

    // 之后每 periodicSweepMs（默认 2 分钟）
    setInterval(() => {
      // WS 心跳检测：超过 wsStaleMs 没消息视为可能断连，除告警外靠本轮 sweep 兜底
      if (Date.now() - lastWsMessageAt > CFG.wsStaleMs) {
        console.warn(TAG, `⚠️ 超过 ${Math.round(CFG.wsStaleMs / 1000)}s 未收到 WS 消息，可能断连 → 补扫`);
      }
      // 清理过期 Map
      cleanupMaps();
      // 周期性扫描
      if (CFG.autoreplyEnabled && CFG.sweepOnLoad && !sweepInProgress) {
        console.log(TAG, '🔄 周期性扫描...');
        sweep().catch(e => console.error(TAG, '周期扫描失败:', e));
      }
    }, CFG.periodicSweepMs);
  }

  // WS 断连后调度一次补扫（页面通常会自动重连，等几秒让它先重连）
  function scheduleReconnectSweep() {
    if (!CFG.autoreplyEnabled || !CFG.sweepOnLoad) return;
    setTimeout(() => {
      if (sweepInProgress) return;
      console.log(TAG, '🔄 WS 断连后补扫...');
      sweep().catch(e => console.error(TAG, '断连补扫失败:', e));
    }, 5000);
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
    ws.addEventListener('close', (ev) => {
      console.warn(`${TAG} WS[${id}] CLOSE`, ev.code);
      // 从 sockets 数组剪掉，避免长跑下重连累积泄漏（id 已在闭包捕获，日志不受影响）
      const idx = sockets.indexOf(ws);
      if (idx >= 0) sockets.splice(idx, 1);
      // 断连后补扫，捞回断连窗口期可能漏收的消息
      scheduleReconnectSweep();
    });
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
      const r = await sendReply(text, targetUid);
      console.log(TAG, r.ok ? '✅ 手动发送成功' : '❌ 手动发送失败: ' + r.cause);
      return r;
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
