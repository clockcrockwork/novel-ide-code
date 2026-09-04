import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDiff,
  coarseFallback,
  normalizeDiffResult,
  createDiffResult,
} from '../src/lib/diffCore.js';

test('空文字同士 — 1行で type:same', () => {
  const { rows, meta } = computeDiff('', '');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'same');
  assert.equal(rows[0].text, '');
  assert.equal(meta.isFallback, false);
});

test('同一文字列 — 全行 type:same', () => {
  const input = 'first\nsecond\nthird';
  const { rows, meta } = computeDiff(input, input);
  assert.ok(rows.every((r) => r.type === 'same'));
  assert.equal(meta.isFallback, false);
});

test('1行追加', () => {
  const { rows, meta } = computeDiff('line1', 'line1\nline2');
  assert.equal(meta.isFallback, false);
  const types = rows.map((r) => r.type);
  assert.ok(types.includes('added'));
  assert.ok(types.includes('same'));
  assert.ok(!types.includes('removed'));
});

test('1行削除', () => {
  const { rows, meta } = computeDiff('line1\nline2', 'line1');
  assert.equal(meta.isFallback, false);
  const types = rows.map((r) => r.type);
  assert.ok(types.includes('removed'));
  assert.ok(types.includes('same'));
  assert.ok(!types.includes('added'));
});

test('1行変更 — removed + added', () => {
  const { rows, meta } = computeDiff('hello', 'world');
  assert.equal(meta.isFallback, false);
  const types = rows.map((r) => r.type);
  assert.ok(types.includes('removed'));
  assert.ok(types.includes('added'));
});

test('複数行追加', () => {
  const { rows } = computeDiff('a', 'a\nb\nc');
  const added = rows.filter((r) => r.type === 'added');
  assert.equal(added.length, 2);
  assert.equal(added[0].text, 'b');
  assert.equal(added[1].text, 'c');
});

test('複数行削除', () => {
  const { rows } = computeDiff('a\nb\nc', 'a');
  const removed = rows.filter((r) => r.type === 'removed');
  assert.equal(removed.length, 2);
});

test('maxEditDistance 超過 — isFallback: true', () => {
  const { meta } = computeDiff('a\nb\nc', 'x\ny\nz', { maxEditDistance: 0 });
  assert.equal(meta.isFallback, true);
});

test('maxTimeMs: -1 — タイムアウトフォールバック', () => {
  const { meta } = computeDiff('aaa', 'bbb', { maxTimeMs: -1 });
  assert.equal(meta.isFallback, true);
});

test('超長文 — maxEditDistance デフォルトで 5001 行全差替えはフォールバック', () => {
  const a = Array.from({ length: 2600 }, (_, i) => `old_line_${i}`).join('\n');
  const b = Array.from({ length: 2600 }, (_, i) => `new_line_${i}`).join('\n');
  const { meta } = computeDiff(a, b);
  assert.equal(meta.isFallback, true);
});

test('coarseFallback — 空配列同士は空結果', () => {
  const rows = coarseFallback([], []);
  assert.equal(rows.length, 0);
});

test('coarseFallback — 結果の各行は type と text を持つ', () => {
  const rows = coarseFallback(['a', 'b'], ['b', 'c']);
  assert.ok(rows.length > 0);
  rows.forEach((r) => {
    assert.ok(['same', 'added', 'removed'].includes(r.type));
    assert.ok('text' in r);
  });
});

test('coarseFallback — 右だけある場合はすべて added', () => {
  const rows = coarseFallback([], ['x', 'y']);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.type === 'added'));
});

test('coarseFallback — 左だけある場合はすべて removed', () => {
  const rows = coarseFallback(['x', 'y'], []);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.type === 'removed'));
});

test('normalizeDiffResult — 正常な結果をそのまま返す', () => {
  const input = { rows: [{ type: 'same', text: 'hi' }], meta: { isFallback: false } };
  const result = normalizeDiffResult(input);
  assert.deepEqual(result.rows, input.rows);
  assert.equal(result.meta.isFallback, false);
});

test('normalizeDiffResult — rows が undefined のとき空配列を返す', () => {
  const result = normalizeDiffResult({ meta: { isFallback: false } });
  assert.deepEqual(result.rows, []);
});

test('normalizeDiffResult — null 入力は空結果', () => {
  const result = normalizeDiffResult(null);
  assert.deepEqual(result.rows, []);
  assert.equal(result.meta.isFallback, true);
});

test('createDiffResult — shape', () => {
  const r = createDiffResult([{ type: 'same', text: 'x' }], { isFallback: false });
  assert.ok(Array.isArray(r.rows));
  assert.equal(r.meta.isFallback, false);
});
