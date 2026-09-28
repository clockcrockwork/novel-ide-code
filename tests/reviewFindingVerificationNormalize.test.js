import test from 'node:test';
import assert from 'node:assert/strict';

import { validateAndNormalizeVerification } from '../scripts/agent/review-finding-verification-normalize.js';
import { MAX_SERIALIZED_CHARS } from '../scripts/agent/review-findings-normalize.js';

function validVerdict(overrides = {}) {
  return {
    finding_id: 'f-0001',
    verdict: 'confirmed',
    rationale: 'independently traced the failure scenario and reproduced it',
    evidence: [{ source: 'test', locator: 'tests/x.test.js:12', detail: 'reproduced the failure' }],
    ...overrides,
  };
}

test('validateAndNormalizeVerification: confirmed が valid になる', () => {
  const r = validateAndNormalizeVerification(validVerdict());
  assert.equal(r.status, 'valid');
  assert.equal(r.result.verdict, 'confirmed');
});

test('validateAndNormalizeVerification: refuted_evidence が valid になる', () => {
  const r = validateAndNormalizeVerification(
    validVerdict({
      verdict: 'refuted_evidence',
      rationale: 'the premise does not hold because a guard already rejects this input',
    }),
  );
  assert.equal(r.status, 'valid');
  assert.equal(r.result.verdict, 'refuted_evidence');
});

test('validateAndNormalizeVerification: unresolved_concern が valid になる', () => {
  const r = validateAndNormalizeVerification(
    validVerdict({ verdict: 'unresolved_concern', rationale: 'could not execute within budget' }),
  );
  assert.equal(r.status, 'valid');
  assert.equal(r.result.verdict, 'unresolved_concern');
});

test('validateAndNormalizeVerification: 未知の verdict は invalid', () => {
  const r = validateAndNormalizeVerification(validVerdict({ verdict: 'dismissed' }));
  assert.equal(r.status, 'invalid');
  assert.ok(r.errors.some((e) => e.includes('verdict')));
});

test('validateAndNormalizeVerification: finding_id 欠落は invalid', () => {
  const raw = validVerdict();
  delete raw.finding_id;
  const r = validateAndNormalizeVerification(raw);
  assert.equal(r.status, 'invalid');
  assert.ok(r.errors.some((e) => e.includes('finding_id')));
});

test('validateAndNormalizeVerification: rationale 欠落は invalid', () => {
  const raw = validVerdict();
  delete raw.rationale;
  const r = validateAndNormalizeVerification(raw);
  assert.equal(r.status, 'invalid');
  assert.ok(r.errors.some((e) => e.includes('rationale')));
});

test('validateAndNormalizeVerification: rationale が空白のみは invalid', () => {
  const r = validateAndNormalizeVerification(validVerdict({ rationale: '   ' }));
  assert.equal(r.status, 'invalid');
});

test('validateAndNormalizeVerification: evidence が空配列は invalid', () => {
  const r = validateAndNormalizeVerification(validVerdict({ evidence: [] }));
  assert.equal(r.status, 'invalid');
  assert.ok(r.errors.some((e) => e.includes('evidence')));
});

test('validateAndNormalizeVerification: evidence 欠落は invalid', () => {
  const raw = validVerdict();
  delete raw.evidence;
  const r = validateAndNormalizeVerification(raw);
  assert.equal(r.status, 'invalid');
});

test('validateAndNormalizeVerification: evidence.source 欠落は invalid', () => {
  const r = validateAndNormalizeVerification(
    validVerdict({ evidence: [{ locator: 'a.js:1', detail: 'x' }] }),
  );
  assert.equal(r.status, 'invalid');
  assert.ok(r.errors.some((e) => e.includes('source')));
});

test('validateAndNormalizeVerification: evidence.locator 欠落は invalid（vague evidence を拒否）', () => {
  const r = validateAndNormalizeVerification(
    validVerdict({ evidence: [{ source: 'code', detail: 'looked fine' }] }),
  );
  assert.equal(r.status, 'invalid');
  assert.ok(r.errors.some((e) => e.includes('locator')));
});

test('validateAndNormalizeVerification: evidence.detail 欠落は invalid', () => {
  const r = validateAndNormalizeVerification(
    validVerdict({ evidence: [{ source: 'code', locator: 'a.js:1' }] }),
  );
  assert.equal(r.status, 'invalid');
  assert.ok(r.errors.some((e) => e.includes('detail')));
});

test('validateAndNormalizeVerification: evidence の locator が空白のみは invalid（vague evidence）', () => {
  const r = validateAndNormalizeVerification(
    validVerdict({ evidence: [{ source: 'code', locator: '   ', detail: 'x' }] }),
  );
  assert.equal(r.status, 'invalid');
});

test('validateAndNormalizeVerification: トップレベルの未知フィールドは invalid', () => {
  const r = validateAndNormalizeVerification(validVerdict({ severity: 'high' }));
  assert.equal(r.status, 'invalid');
  assert.ok(r.errors.some((e) => e.includes('severity')));
});

test('validateAndNormalizeVerification: evidence 内の未知フィールドは invalid', () => {
  const r = validateAndNormalizeVerification(
    validVerdict({
      evidence: [{ source: 'code', locator: 'a.js:1', detail: 'x', confidence: 0.9 }],
    }),
  );
  assert.equal(r.status, 'invalid');
  assert.ok(r.errors.some((e) => e.includes('confidence')));
});

test('validateAndNormalizeVerification: object でない raw は invalid', () => {
  assert.equal(validateAndNormalizeVerification(null).status, 'invalid');
  assert.equal(validateAndNormalizeVerification('confirmed').status, 'invalid');
  assert.equal(validateAndNormalizeVerification([1, 2]).status, 'invalid');
});

test('validateAndNormalizeVerification: 巨大な rationale は invalid（huge strings 攻撃）', () => {
  const r = validateAndNormalizeVerification(
    validVerdict({ rationale: 'x'.repeat(MAX_SERIALIZED_CHARS + 1) }),
  );
  assert.equal(r.status, 'invalid');
  assert.ok(r.errors.some((e) => e.includes('大きすぎます')));
});

test('validateAndNormalizeVerification: 複数 evidence を受理する', () => {
  const r = validateAndNormalizeVerification(
    validVerdict({
      evidence: [
        { source: 'code', locator: 'a.js:1', detail: 'x' },
        { source: 'test', locator: 'b.test.js:5', detail: 'y' },
      ],
    }),
  );
  assert.equal(r.status, 'valid');
  assert.equal(r.result.evidence.length, 2);
});

test('validateAndNormalizeVerification: 検証済みフィールドのみを組み立てる（プロトタイプ汚染耐性）', () => {
  const raw = JSON.parse(
    `{"finding_id":"f-0001","verdict":"confirmed","rationale":"r","evidence":[{"source":"code","locator":"a.js:1","detail":"d"}],"__proto__":{"polluted":true}}`,
  );
  const r = validateAndNormalizeVerification(raw);
  // __proto__ は additionalProperties:false の対象外キーとして invalid 扱いになる
  // （REVIEW_VERIFICATION_SCHEMA に無いフィールドとして拒否される）。
  assert.equal(r.status, 'invalid');
  assert.equal({}.polluted, undefined);
});
