import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { evaluateGate } from '../scripts/agent/check-required-gate.js';

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../scripts/agent/check-required-gate.js',
);

// テスト用の needs コンテキストを組み立てる。
// results: { 'lint-test': 'success', ... }、outputs: changes job の outputs（既定は code のみ true）
function buildNeeds({ results = {}, outputs, changesResult = 'success' } = {}) {
  const defaultOutputs = { code: 'true', deps: 'false', docs: 'false', bundle: 'false' };
  const needs = {
    changes: { result: changesResult, outputs: outputs === undefined ? defaultOutputs : outputs },
    'lint-test': { result: 'success', outputs: {} },
    'worker-test': { result: 'success', outputs: {} },
    'docs-links': { result: 'skipped', outputs: {} },
    'bundle-check': { result: 'skipped', outputs: {} },
    audit: { result: 'skipped', outputs: {} },
    semgrep: { result: 'success', outputs: {} },
    'secret-scan': { result: 'success', outputs: {} },
  };
  for (const [name, result] of Object.entries(results)) {
    needs[name] = { result, outputs: {} };
  }
  return needs;
}

// --- 正常系マトリクス（想定ケース N1〜N4） ---

test('required-gate: code 変更 PR（lint-test/semgrep/secret-scan success、docs-links/audit skipped）は成功', () => {
  const { ok, violations } = evaluateGate(JSON.stringify(buildNeeds()));
  assert.deepEqual(violations, []);
  assert.equal(ok, true);
});

test('required-gate: docs-only PR（lint-test/semgrep/audit skipped、docs-links/secret-scan success）は成功', () => {
  const needs = buildNeeds({
    outputs: { code: 'false', deps: 'false', docs: 'true', bundle: 'false' },
    results: {
      'lint-test': 'skipped',
      'worker-test': 'skipped',
      semgrep: 'skipped',
      'docs-links': 'success',
    },
  });
  const { ok, violations } = evaluateGate(JSON.stringify(needs));
  assert.deepEqual(violations, []);
  assert.equal(ok, true);
});

test('required-gate: 依存変更 PR（audit success 必須）は成功', () => {
  const needs = buildNeeds({
    outputs: { code: 'true', deps: 'true', docs: 'false', bundle: 'false' },
    results: { audit: 'success' },
  });
  assert.equal(evaluateGate(JSON.stringify(needs)).ok, true);
});

test('required-gate: fail-closed 分類（分類フラグすべて true）は全 job 必須で、全 success なら成功', () => {
  const needs = buildNeeds({
    outputs: { code: 'true', deps: 'true', docs: 'true', bundle: 'true' },
    results: { 'docs-links': 'success', audit: 'success', 'bundle-check': 'success' },
  });
  assert.equal(evaluateGate(JSON.stringify(needs)).ok, true);

  const withSkip = buildNeeds({
    outputs: { code: 'true', deps: 'true', docs: 'true', bundle: 'true' },
    results: { 'docs-links': 'success', audit: 'skipped', 'bundle-check': 'success' },
  });
  assert.equal(evaluateGate(JSON.stringify(withSkip)).ok, false);
});

test('required-gate: bundle=true で bundle-check が skipped なら失敗（#551）', () => {
  const needs = buildNeeds({
    outputs: { code: 'true', deps: 'false', docs: 'false', bundle: 'true' },
    results: { 'bundle-check': 'skipped' },
  });
  const { ok, violations } = evaluateGate(JSON.stringify(needs));
  assert.equal(ok, false);
  assert.match(violations.join('\n'), /bundle-check/);
});

test('required-gate: bundle=true で bundle-check success なら成功（#551）', () => {
  const needs = buildNeeds({
    outputs: { code: 'true', deps: 'false', docs: 'false', bundle: 'true' },
    results: { 'bundle-check': 'success' },
  });
  assert.equal(evaluateGate(JSON.stringify(needs)).ok, true);
});

test('required-gate: bundle=false でも bundle-check が failure なら失敗（走った以上握りつぶさない）', () => {
  const needs = buildNeeds({ results: { 'bundle-check': 'failure' } });
  const { ok, violations } = evaluateGate(JSON.stringify(needs));
  assert.equal(ok, false);
  assert.match(violations.join('\n'), /bundle-check/);
});

// --- 必須 job の result セマンティクス（R1〜R4、I6） ---

for (const badResult of ['failure', 'skipped', 'cancelled', 'timed_out', 'unknown-future-value']) {
  test(`required-gate: 必須 job（lint-test）が ${badResult} なら失敗`, () => {
    const needs = buildNeeds({ results: { 'lint-test': badResult } });
    const { ok, violations } = evaluateGate(JSON.stringify(needs));
    assert.equal(ok, false);
    assert.match(violations.join('\n'), /lint-test/);
  });
}

test('required-gate: code=true で semgrep が skipped なら失敗（意図しない skip の検出）', () => {
  const needs = buildNeeds({ results: { semgrep: 'skipped' } });
  assert.equal(evaluateGate(JSON.stringify(needs)).ok, false);
});

test('required-gate: secret-scan は分類によらず必須（docs-only でも skipped なら失敗）', () => {
  const needs = buildNeeds({
    outputs: { code: 'false', deps: 'false', docs: 'true', bundle: 'false' },
    results: {
      'lint-test': 'skipped',
      semgrep: 'skipped',
      'docs-links': 'success',
      'secret-scan': 'skipped',
    },
  });
  assert.equal(evaluateGate(JSON.stringify(needs)).ok, false);
});

// --- 非必須 job（R5〜R6） ---

test('required-gate: 非必須 job の failure は握りつぶさず失敗（fail-open 防止）', () => {
  const needs = buildNeeds({ results: { audit: 'failure' } });
  const { ok, violations } = evaluateGate(JSON.stringify(needs));
  assert.equal(ok, false);
  assert.match(violations.join('\n'), /audit/);
});

test('required-gate: 非必須 job が走って success でも成功扱い', () => {
  const needs = buildNeeds({ results: { audit: 'success', 'docs-links': 'success' } });
  assert.equal(evaluateGate(JSON.stringify(needs)).ok, true);
});

// --- changes job の検証（I8、R7） ---

for (const badResult of ['failure', 'cancelled', 'skipped']) {
  test(`required-gate: changes が ${badResult} なら outputs を信用せず失敗`, () => {
    const needs = buildNeeds({ changesResult: badResult });
    const { ok, violations } = evaluateGate(JSON.stringify(needs));
    assert.equal(ok, false);
    assert.match(violations.join('\n'), /changes/);
  });
}

// --- 入力の壊れ方（I1〜I5、I7） ---

test('required-gate: NEEDS 未設定（null）は fail-closed', () => {
  const { ok, violations } = evaluateGate(null);
  assert.equal(ok, false);
  assert.match(violations.join('\n'), /未設定/);
});

test('required-gate: NEEDS が文字列以外（数値・オブジェクト）でも例外を投げず fail-closed', () => {
  assert.equal(evaluateGate(42).ok, false);
  assert.equal(evaluateGate({ changes: {} }).ok, false);
});

test('required-gate: NEEDS が空文字なら fail-closed', () => {
  assert.equal(evaluateGate('').ok, false);
  assert.equal(evaluateGate('   ').ok, false);
});

test('required-gate: NEEDS が不正 JSON なら fail-closed', () => {
  assert.equal(evaluateGate('{ broken').ok, false);
});

for (const nonObject of ['null', '[]', '"str"', '42']) {
  test(`required-gate: NEEDS が ${nonObject}（オブジェクト以外）なら fail-closed`, () => {
    assert.equal(evaluateGate(nonObject).ok, false);
  });
}

test('required-gate: needs に job キーが欠けていたら失敗（needs と RULES の不整合）', () => {
  const needs = buildNeeds();
  delete needs.semgrep;
  const { ok, violations } = evaluateGate(JSON.stringify(needs));
  assert.equal(ok, false);
  assert.match(violations.join('\n'), /semgrep/);
});

test('required-gate: needs に未知の job があれば失敗（RULES 更新漏れの検出）', () => {
  const needs = buildNeeds();
  needs['e2e-smoke'] = { result: 'success', outputs: {} };
  const { ok, violations } = evaluateGate(JSON.stringify(needs));
  assert.equal(ok, false);
  assert.match(violations.join('\n'), /e2e-smoke/);
});

test('required-gate: __proto__ キーを含む NEEDS でも汚染されず判定できる（INVARIANTS #11）', () => {
  const json = JSON.stringify(buildNeeds()).replace('{"changes"', '{"__proto__":{"x":1},"changes"');
  const { ok } = evaluateGate(json);
  assert.equal(ok, false); // 未知キーとして失敗（黙って無視しない）
  assert.equal({}.x, undefined);
});

for (const badValue of ['', 'True', '1', undefined]) {
  test(`required-gate: changes outputs の code が ${JSON.stringify(badValue)} なら fail-closed（'true'/'false' 限定）`, () => {
    const outputs = { code: badValue, deps: 'false', docs: 'false', bundle: 'false' };
    if (badValue === undefined) delete outputs.code;
    const needs = buildNeeds({ outputs });
    const { ok, violations } = evaluateGate(JSON.stringify(needs));
    assert.equal(ok, false);
    assert.match(violations.join('\n'), /code/);
  });
}

test('required-gate: changes outputs に未知の分類キーがあれば失敗（CLASSIFICATION_KEYS 更新漏れの検出）', () => {
  const needs = buildNeeds({
    outputs: { code: 'true', deps: 'false', docs: 'false', bundle: 'false', e2e: 'true' },
  });
  const { ok, violations } = evaluateGate(JSON.stringify(needs));
  assert.equal(ok, false);
  assert.match(violations.join('\n'), /e2e/);
});

test('required-gate: changes outputs 自体が null なら fail-closed', () => {
  const needs = buildNeeds({ outputs: null });
  assert.equal(evaluateGate(JSON.stringify(needs)).ok, false);
});

// --- CLI 層（F2: exit code・違反の全件列挙） ---

test('required-gate CLI: NEEDS 未設定は fail-loud（exit 1・エラーメッセージ）', () => {
  const { status, stderr, stdout } = spawnSync('node', [SCRIPT], {
    encoding: 'utf-8',
    env: { PATH: process.env.PATH },
  });
  assert.equal(status, 1);
  assert.match(stderr, /NEEDS/);
  assert.equal(stdout, '');
});

test('required-gate CLI: 違反が複数あれば全件列挙して exit 1', () => {
  const needs = buildNeeds({ results: { 'lint-test': 'skipped', semgrep: 'failure' } });
  const { status, stderr } = spawnSync('node', [SCRIPT], {
    encoding: 'utf-8',
    env: { PATH: process.env.PATH, NEEDS: JSON.stringify(needs) },
  });
  assert.equal(status, 1);
  assert.match(stderr, /lint-test/);
  assert.match(stderr, /semgrep/);
});

test('required-gate CLI: 違反ゼロなら exit 0', () => {
  const { status, stdout } = spawnSync('node', [SCRIPT], {
    encoding: 'utf-8',
    env: { PATH: process.env.PATH, NEEDS: JSON.stringify(buildNeeds()) },
  });
  assert.equal(status, 0);
  assert.match(stdout, /required-gate/);
});

// worker のテストは root の vitest（vite.config.js が worker/** を除外）では走らないため、
// worker-test ジョブが必須ゲートに含まれていないと、worker 側のガードが無検査で通る（#506）。
test('required-gate: code 変更 PR で worker-test が skipped なら失敗する', () => {
  const needs = buildNeeds({ results: { 'worker-test': 'skipped' } });
  const { ok, violations } = evaluateGate(JSON.stringify(needs));
  assert.equal(ok, false);
  assert.ok(violations.some((v) => String(v).includes('worker-test')));
});

test('required-gate: docs-only PR では worker-test の skipped を許容する', () => {
  const needs = buildNeeds({
    outputs: { code: 'false', deps: 'false', docs: 'true', bundle: 'false' },
    results: {
      'lint-test': 'skipped',
      'worker-test': 'skipped',
      semgrep: 'skipped',
      'docs-links': 'success',
    },
  });
  assert.equal(evaluateGate(JSON.stringify(needs)).ok, true);
});
