import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  extractRuntimeTags,
  runCheck,
  validateClassification,
} from '../scripts/check-e2e-classification.js';

test('extractRuntimeTags は Playwright tag metadata の分類だけを拾う', () => {
  const source = `
    test.describe('x', { tag: ['@heavy', '@perf'] }, () => {});
    test('@perf タイトル文字列は metadata ではない', async () => {});
    const unrelated = '@smoke';
  `;
  assert.deepEqual(extractRuntimeTags(source), ['@heavy', '@perf']);
});

test('未分類 spec と stale manifest path を fail-closed で検出する', () => {
  const errors = validateClassification({
    specPaths: ['e2e/a.spec.js'],
    manifest: {
      version: 1,
      files: {
        'e2e/stale.spec.js': ['all-only'],
      },
    },
    readFile: () => '',
  });
  assert.ok(errors.some((e) => e.includes('未分類の E2E spec: e2e/a.spec.js')));
  assert.ok(errors.some((e) => e.includes('manifest にだけ存在する E2E spec: e2e/stale.spec.js')));
});

test('all-only に runtime tag が混ざると失敗する', () => {
  const errors = validateClassification({
    specPaths: ['e2e/a.spec.js'],
    manifest: { version: 1, files: { 'e2e/a.spec.js': ['all-only'] } },
    readFile: () => "test.describe('x', { tag: ['@smoke'] }, () => {});",
  });
  assert.ok(errors.some((e) => e.includes('runtime tag が manifest と不一致')));
});

test('@smoke / @editor-critical は他分類と重複できない', () => {
  const smoke = validateClassification({
    specPaths: ['e2e/a.spec.js'],
    manifest: { version: 1, files: { 'e2e/a.spec.js': ['@smoke', '@perf'] } },
    readFile: () => "test.describe('x', { tag: ['@smoke', '@perf'] }, () => {});",
  });
  assert.ok(smoke.some((e) => e.includes('@smoke は他分類と重複させません')));

  const critical = validateClassification({
    specPaths: ['e2e/b.spec.js'],
    manifest: { version: 1, files: { 'e2e/b.spec.js': ['@editor-critical', '@ime'] } },
    readFile: () => "test.describe('x', { tag: ['@editor-critical', '@ime'] }, () => {});",
  });
  assert.ok(critical.some((e) => e.includes('@editor-critical は他分類と重複させません')));
});

test('current tracked E2E corpus は classification manifest と一致する', () => {
  const result = runCheck(resolve('.'));
  const manifest = JSON.parse(readFileSync('e2e/classification.json', 'utf8'));
  assert.equal(result.specCount, 25);
  assert.equal(Object.keys(manifest.files).length, 25);
});
