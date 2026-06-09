import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keywordCheck } from '../src/lib.mjs';

const BL = ['投诉', '12315', '差评', '退款'];

test('keywordCheck: 命中第一个词', () => {
  assert.deepEqual(keywordCheck('我要投诉你们', BL), { hit: true, term: '投诉' });
});

test('keywordCheck: 命中夹在中间的词', () => {
  assert.deepEqual(keywordCheck('再不处理我打 12315 啊', BL), { hit: true, term: '12315' });
});

test('keywordCheck: 没命中', () => {
  assert.deepEqual(keywordCheck('你好，多久发货', BL), { hit: false });
});

test('keywordCheck: 空黑名单', () => {
  assert.deepEqual(keywordCheck('投诉', []), { hit: false });
});

test('keywordCheck: 空文本', () => {
  assert.deepEqual(keywordCheck('', BL), { hit: false });
});

test('keywordCheck: 返回首个命中（按 blacklist 顺序）', () => {
  const r = keywordCheck('投诉和差评', BL);
  assert.equal(r.term, '投诉');
});
