// Pure, side-effect-free functions. Tested by tests/*.test.mjs.
// Built into dist/ by scripts/build.mjs (which strips the `export ` keywords).

/**
 * 从原始响应里抠出 JSON 对象。处理三种情况：
 * 1. 纯 JSON                   → 原样返回
 * 2. ```json...``` 代码块包裹  → 剥掉围栏
 * 3. JSON 前后有废话           → 用最外层 {...} regex 提取
 * 空字符串 / 找不到 {} → 返回空字符串（上层会判定为 parse 失败）
 */
export function extractJSON(raw) {
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

export function parseAIOutput(raw) {
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

export function keywordCheck(text, blacklist) {
  for (const kw of blacklist) {
    if (text.includes(kw)) return { hit: true, term: kw };
  }
  return { hit: false };
}

export function renderEscalationCard({ sellerName, buyerName, buyerUid, recentTexts, draft, reason }) {
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