import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAIOutput } from '../src/lib.mjs';

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
  assert.match(r.error, /JSON parse/);
});

test('parseAIOutput: 接受外层带空白', () => {
  const r = parseAIOutput('  \n{"should_escalate":false,"draft":"x"}\n');
  assert.equal(r.ok, true);
});
