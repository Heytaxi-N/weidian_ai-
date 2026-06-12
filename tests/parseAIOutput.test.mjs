import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAIOutput, extractJSON } from '../src/lib.mjs';

test('parseAIOutput: 合法 JSON 全字段', () => {
  const r = parseAIOutput('{"should_escalate":false,"reason":"命中 FAQ","draft":"稍等~"}');
  assert.deepEqual(r, { ok: true, value: { should_escalate: false, reason: '命中 FAQ', draft: '稍等~' } });
});

test('parseAIOutput: 缺 reason 字段（应允许，置空字符串）', () => {
  const r = parseAIOutput('{"should_escalate":true,"draft":"转人工"}');
  assert.equal(r.ok, true);
  assert.equal(r.value.reason, '');
});

test('parseAIOutput: should_escalate 不是 boolean', () => {
  const r = parseAIOutput('{"should_escalate":"yes","draft":"x"}');
  assert.equal(r.ok, false);
  assert.match(r.error, /should_escalate/);
});

test('parseAIOutput: 缺 draft 字段', () => {
  const r = parseAIOutput('{"should_escalate":false}');
  assert.equal(r.ok, false);
  assert.match(r.error, /draft/);
});

test('parseAIOutput: 不是合法 JSON', () => {
  const r = parseAIOutput('{not json');
  assert.equal(r.ok, false);
  // extractJSON 抠不出闭合 {} → "empty or no JSON object found"
  assert.match(r.error, /JSON|empty/);
});

test('parseAIOutput: 闭合但内部坏掉的 JSON → JSON parse failed', () => {
  const r = parseAIOutput('{"should_escalate":notbool,"draft":"x"}');
  assert.equal(r.ok, false);
  assert.match(r.error, /JSON parse/);
});

test('parseAIOutput: 接受外层带空白', () => {
  const r = parseAIOutput('  \n{"should_escalate":false,"draft":"x"}\n');
  assert.equal(r.ok, true);
});

test('parseAIOutput: 空字符串（DeepSeek 偶发空响应）', () => {
  const r = parseAIOutput('');
  assert.equal(r.ok, false);
  assert.match(r.error, /empty/);
});

test('parseAIOutput: 全空白', () => {
  const r = parseAIOutput('   \n\t  ');
  assert.equal(r.ok, false);
  assert.match(r.error, /empty/);
});

test('parseAIOutput: 空 draft 应拒绝', () => {
  const r = parseAIOutput('{"should_escalate":false,"draft":""}');
  assert.equal(r.ok, false);
  assert.match(r.error, /draft/);
});

test('parseAIOutput: draft 仅空白也拒绝', () => {
  const r = parseAIOutput('{"should_escalate":false,"draft":"   "}');
  assert.equal(r.ok, false);
});

test('parseAIOutput: 包了 ```json``` 围栏也能 parse', () => {
  const r = parseAIOutput('```json\n{"should_escalate":false,"draft":"hi"}\n```');
  assert.equal(r.ok, true);
  assert.equal(r.value.draft, 'hi');
});

test('parseAIOutput: 包了 ``` (无 json) 围栏也能 parse', () => {
  const r = parseAIOutput('```\n{"should_escalate":false,"draft":"hi"}\n```');
  assert.equal(r.ok, true);
});

test('parseAIOutput: JSON 前后有废话能抠出来', () => {
  const r = parseAIOutput('好的，我的判断是 {"should_escalate":false,"draft":"hi"} 谢谢');
  assert.equal(r.ok, true);
  assert.equal(r.value.draft, 'hi');
});

test('extractJSON: 纯 JSON 原样', () => {
  assert.equal(extractJSON('{"a":1}'), '{"a":1}');
});

test('extractJSON: 空 / 非 JSON 返回空串', () => {
  assert.equal(extractJSON(''), '');
  assert.equal(extractJSON('hello world'), '');
  assert.equal(extractJSON(null), '');
});
