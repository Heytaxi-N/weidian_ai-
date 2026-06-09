// Pure, side-effect-free functions. Tested by tests/*.test.mjs.
// Built into dist/ by scripts/build.mjs (which strips the `export ` keywords).

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