import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDebouncer } from '../src/lib.mjs';

test('createDebouncer: 第一次 shouldFire 必返回 true', () => {
  let now = 1000;
  const d = createDebouncer(60_000, () => now);
  assert.equal(d.shouldFire('user1'), true);
});

test('createDebouncer: 同 key 在 interval 内不再 fire', () => {
  let now = 1000;
  const d = createDebouncer(60_000, () => now);
  d.shouldFire('user1');
  now = 30_000;
  assert.equal(d.shouldFire('user1'), false);
});

test('createDebouncer: 同 key 超过 interval 再次 fire', () => {
  let now = 1000;
  const d = createDebouncer(60_000, () => now);
  d.shouldFire('user1');
  now = 1000 + 60_001;
  assert.equal(d.shouldFire('user1'), true);
});

test('createDebouncer: 不同 key 互不影响', () => {
  let now = 1000;
  const d = createDebouncer(60_000, () => now);
  d.shouldFire('user1');
  assert.equal(d.shouldFire('user2'), true);
});

test('createDebouncer: reset(key) 让该 key 立刻可以再 fire', () => {
  let now = 1000;
  const d = createDebouncer(60_000, () => now);
  d.shouldFire('user1');
  d.reset('user1');
  assert.equal(d.shouldFire('user1'), true);
});

test('createDebouncer: reset() 不带参数清空全部', () => {
  let now = 1000;
  const d = createDebouncer(60_000, () => now);
  d.shouldFire('a');
  d.shouldFire('b');
  d.reset();
  assert.equal(d.shouldFire('a'), true);
  assert.equal(d.shouldFire('b'), true);
});
