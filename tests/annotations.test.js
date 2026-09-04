import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeAnnotation } from '../src/lib/annotations.js';

const BASE = {
  id: 'test-id',
  type: 'memo',
  selectedText: 'テスト',
  createdAt: 0,
  occurrenceIdx: 0,
};

test('normalizeAnnotation: selectedText が 2000 字を超える場合は 2000 字に切り捨てる', () => {
  const longText = 'あ'.repeat(2500);
  const result = normalizeAnnotation({ ...BASE, selectedText: longText }, 10000);
  assert.ok(result !== null);
  assert.equal(result.selectedText.length, 2000);
});

test('normalizeAnnotation: note が 5000 字を超える場合は 5000 字に切り捨てる', () => {
  const longNote = 'い'.repeat(6000);
  const result = normalizeAnnotation({ ...BASE, note: longNote }, 10000);
  assert.ok(result !== null);
  assert.equal(result.note.length, 5000);
});

test('normalizeAnnotation: selectedText が 2000 字以内ならそのまま保持', () => {
  const text = 'あ'.repeat(2000);
  const result = normalizeAnnotation({ ...BASE, selectedText: text }, 10000);
  assert.ok(result !== null);
  assert.equal(result.selectedText.length, 2000);
});

test('normalizeAnnotation: note が 5000 字以内ならそのまま保持', () => {
  const note = 'い'.repeat(5000);
  const result = normalizeAnnotation({ ...BASE, note }, 10000);
  assert.ok(result !== null);
  assert.equal(result.note.length, 5000);
});

test('normalizeAnnotation: selectedText が空文字になるくらい切り捨てた場合は null を返す', () => {
  // trim 後に空になるケース（スペースのみで 2000 字を超える）
  const spacesOnly = ' '.repeat(2500);
  const result = normalizeAnnotation({ ...BASE, selectedText: spacesOnly }, 10000);
  // slice(0, 2000) → ' '.repeat(2000) → trim() → '' → null
  assert.equal(result, null);
});
