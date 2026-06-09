import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderEscalationCard } from '../src/lib.mjs';

test('renderEscalationCard: 完整输入', () => {
  const md = renderEscalationCard({
    sellerName: '旷野户外',
    buyerName: 'Jason',
    buyerUid: '8231960975030111227',
    recentTexts: ['还有货吗', '在吗'],
    draft: '稍等我帮您看下库存哈~',
    reason: 'keyword:12315',
  });
  assert.match(md, /🛎 需要人工：旷野户外 客服/);
  assert.match(md, /客户.*Jason/);
  assert.match(md, /#\/session\/recent\/8231960975030111227/);
  assert.match(md, /1\. 还有货吗/);
  assert.match(md, /2\. 在吗/);
  assert.match(md, /稍等我帮您看下库存哈~/);
  assert.match(md, /keyword:12315/);
});

test('renderEscalationCard: buyerName 缺失退化到 uid', () => {
  const md = renderEscalationCard({
    sellerName: '旷野户外', buyerName: null, buyerUid: '999',
    recentTexts: ['你好'], draft: 'x', reason: 'r',
  });
  assert.match(md, /客户.*999/);
});

test('renderEscalationCard: 只有一条最近消息', () => {
  const md = renderEscalationCard({
    sellerName: 'X', buyerName: 'Y', buyerUid: '1',
    recentTexts: ['一句话'], draft: 'd', reason: 'r',
  });
  assert.match(md, /最近 1 条/);
  assert.match(md, /1\. 一句话/);
});

test('renderEscalationCard: 空 recentTexts', () => {
  const md = renderEscalationCard({
    sellerName: 'X', buyerName: 'Y', buyerUid: '1',
    recentTexts: [], draft: 'd', reason: 'r',
  });
  assert.match(md, /最近 0 条/);
});

test('renderEscalationCard: 会话 URL 用 markdown 链接语法包裹（企微才能渲染成可点击）', () => {
  const md = renderEscalationCard({
    sellerName: 'X', buyerName: 'Y', buyerUid: 'UID42',
    recentTexts: ['t'], draft: 'd', reason: 'r',
  });
  assert.match(md, /\[点击进入\]\(https:\/\/im\.weidian\.com\/im-team\/im-pc-2\/#\/session\/recent\/UID42\)/);
});
