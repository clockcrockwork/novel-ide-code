import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  STRUCTURED_FINDINGS_VERIFICATION_FILE,
  STRUCTURED_FINDINGS_VERIFICATION_SCHEMA_VERSION,
  buildVerificationMetrics,
  buildVerificationPrompt,
  deriveVerificationView,
  formatVerificationReport,
  recordHumanAdjudication,
  recordVerification,
  resolveVerificationTarget,
} from '../scripts/agent/review-finding-verifier.js';
import {
  STRUCTURED_FINDINGS_SCHEMA_VERSION,
  assertArtifactBinding,
  ingestFindings,
} from '../scripts/agent/review-findings.js';
import { createSnapshot } from '../scripts/agent/review-snapshot.js';
import { ANGLE_TOKENS } from '../scripts/agent/review-angle-tokens.js';
import { makeTmpGitRepo, sh, write } from './helpers/tmpGitRepo.js';

function makeRepo() {
  const dir = makeTmpGitRepo('review-finding-verifier-');
  write(dir, 'a.txt', 'a\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'init']);
  return dir;
}

function baseFinding(overrides = {}) {
  return {
    file: 'src/a.js',
    line: 1,
    summary: 'summary',
    failure_scenario: 'failure',
    scope_relation: 'introduced',
    severity: 'high',
    evidence: 'strong',
    provenance: { angle: 'adversarial', anchor_class: 'attack-surface' },
    ...overrides,
  };
}

function validVerdict(findingId, overrides = {}) {
  return {
    finding_id: findingId,
    verdict: 'confirmed',
    rationale: 'independently traced and reproduced the failure scenario',
    evidence: [{ source: 'test', locator: 'tests/x.test.js:1', detail: 'reproduced' }],
    ...overrides,
  };
}

function seedSnapshot(dir, findings) {
  const { snapshotId } = createSnapshot({ cwd: dir });
  const res = ingestFindings({ snapshotId, rawFindings: findings, cwd: dir });
  return { snapshotId, ingestResult: res };
}

test('resolveVerificationTarget: 正常な normalized finding を解決できる', () => {
  const dir = makeRepo();
  const { snapshotId } = seedSnapshot(dir, [baseFinding()]);
  const target = resolveVerificationTarget({ snapshotId, findingId: 'f-0001', cwd: dir });
  assert.equal(target.finding.summary, 'summary');
  assert.equal(typeof target.findingDigest, 'string');
  assert.ok(target.findingDigest.length > 0);
});

test('resolveVerificationTarget: 未知の finding_id は fail-loud', () => {
  const dir = makeRepo();
  const { snapshotId } = seedSnapshot(dir, [baseFinding()]);
  assert.throws(
    () => resolveVerificationTarget({ snapshotId, findingId: 'f-9999', cwd: dir }),
    /存在しません/,
  );
});

test('resolveVerificationTarget: invalid record（status=invalid）は対象にできない', () => {
  const dir = makeRepo();
  // scope_relation を不正値にして invalid record を作る
  const { snapshotId } = seedSnapshot(dir, [baseFinding({ scope_relation: 'not-a-real-value' })]);
  assert.throws(
    () => resolveVerificationTarget({ snapshotId, findingId: 'f-0001', cwd: dir }),
    /normalized finding のみ/,
  );
});

test('resolveVerificationTarget: 重複 finding_id（手編集・破損）は fail-loud（曖昧なまま attach しない）', () => {
  const dir = makeRepo();
  const { snapshotId } = seedSnapshot(dir, [baseFinding()]);
  const target = resolveVerificationTarget({ snapshotId, findingId: 'f-0001', cwd: dir });
  const artifactPath = join(target.findingsFile);
  // 直接 artifact を壊す: 2件目の record に同じ finding_id を手で複製する
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf-8'));
  artifact.records.push({ ...artifact.records[0] });
  writeFileSync(artifactPath, JSON.stringify(artifact));
  assert.throws(
    () => resolveVerificationTarget({ snapshotId, findingId: 'f-0001', cwd: dir }),
    /重複しています/,
  );
});

test('resolveVerificationTarget: 別 snapshot からコピーされた artifact は binding 検証で拒否される', () => {
  const dir = makeRepo();
  const { snapshotId: snap1 } = seedSnapshot(dir, [baseFinding()]);
  write(dir, 'b.txt', 'b\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'second']);
  const { snapshotId: snap2 } = seedSnapshot(dir, [baseFinding({ file: 'src/b.js' })]);

  // snap1 の structured-findings.json を snap2 のディレクトリへコピーする（snapshotId 混入）。
  const root = join(dir, '.git', 'agent-review');
  const src = join(root, snap1, 'structured-findings.json');
  const dst = join(root, snap2, 'structured-findings.json');
  writeFileSync(dst, readFileSync(src));

  assert.throws(
    () => resolveVerificationTarget({ snapshotId: snap2, findingId: 'f-0001', cwd: dir }),
    /snapshotId が一致しません/,
  );
});

test('buildVerificationPrompt: finder の結論を ground truth として提示しない独立検証の指示を含む', () => {
  const dir = makeRepo();
  const { snapshotId } = seedSnapshot(dir, [baseFinding()]);
  const payload = buildVerificationPrompt({ snapshotId, findingId: 'f-0001', cwd: dir });
  assert.equal(payload.finding_id, 'f-0001');
  assert.equal(payload.finding.summary, 'summary');
  assert.match(payload.instructions, /独立/);
});

test('recordVerification: confirmed/refuted_evidence/unresolved_concern を受理する', () => {
  const dir = makeRepo();
  const { snapshotId } = seedSnapshot(dir, [
    baseFinding({ file: 'src/a.js', summary: 's1', failure_scenario: 'f1' }),
    baseFinding({ file: 'src/b.js', summary: 's2', failure_scenario: 'f2', severity: 'med' }),
    baseFinding({ file: 'src/c.js', summary: 's3', failure_scenario: 'f3', evidence: 'weak' }),
  ]);
  const t1 = resolveVerificationTarget({ snapshotId, findingId: 'f-0001', cwd: dir });
  const a1 = recordVerification({
    snapshotId,
    findingId: 'f-0001',
    findingDigest: t1.findingDigest,
    rawResult: validVerdict('f-0001', { verdict: 'confirmed' }),
    cwd: dir,
  });
  assert.equal(a1.outcome, 'accepted');
  assert.equal(a1.result.verdict, 'confirmed');

  const t2 = resolveVerificationTarget({ snapshotId, findingId: 'f-0002', cwd: dir });
  const a2 = recordVerification({
    snapshotId,
    findingId: 'f-0002',
    findingDigest: t2.findingDigest,
    rawResult: validVerdict('f-0002', {
      verdict: 'refuted_evidence',
      rationale: 'existing guard already rejects this before it can occur',
    }),
    cwd: dir,
  });
  assert.equal(a2.result.verdict, 'refuted_evidence');

  const t3 = resolveVerificationTarget({ snapshotId, findingId: 'f-0003', cwd: dir });
  const a3 = recordVerification({
    snapshotId,
    findingId: 'f-0003',
    findingDigest: t3.findingDigest,
    rawResult: validVerdict('f-0003', {
      verdict: 'unresolved_concern',
      rationale: 'could not execute within the bounded budget',
    }),
    cwd: dir,
  });
  assert.equal(a3.result.verdict, 'unresolved_concern');

  const metrics = buildVerificationMetrics({ snapshotId, cwd: dir });
  assert.equal(metrics.verifiedTotal, 3);
  assert.equal(metrics.confirmed, 1);
  assert.equal(metrics.refutedEvidence, 1);
  assert.equal(metrics.unresolvedConcern, 1);
});

test('recordVerification: 未知の finding_id への verification は拒否される', () => {
  const dir = makeRepo();
  const { snapshotId } = seedSnapshot(dir, [baseFinding()]);
  assert.throws(
    () =>
      recordVerification({
        snapshotId,
        findingId: 'f-9999',
        findingDigest: 'whatever',
        rawResult: validVerdict('f-9999'),
        cwd: dir,
      }),
    /存在しません/,
  );
});

test('recordVerification: verdict 内の finding_id が対象と食い違う場合は rejected（wrong/injected finding_id）', () => {
  const dir = makeRepo();
  const { snapshotId } = seedSnapshot(dir, [
    baseFinding({ file: 'src/a.js' }),
    baseFinding({ file: 'src/b.js', summary: 's2', failure_scenario: 'f2' }),
  ]);
  const t1 = resolveVerificationTarget({ snapshotId, findingId: 'f-0001', cwd: dir });
  const attempt = recordVerification({
    snapshotId,
    findingId: 'f-0001',
    findingDigest: t1.findingDigest,
    // evidence を別 finding (f-0002) から借用したかのような verdict
    rawResult: validVerdict('f-0002'),
    cwd: dir,
  });
  assert.equal(attempt.outcome, 'rejected');
  assert.ok(attempt.errors.some((e) => e.includes('finding_id')));
});

test('recordVerification: 無関係な finding の追加 ingest は false staleness を起こさない（finding 単位のダイジェストのため）', () => {
  const dir = makeRepo();
  const { snapshotId } = seedSnapshot(dir, [baseFinding()]);
  const t1 = resolveVerificationTarget({ snapshotId, findingId: 'f-0001', cwd: dir });
  // f-0001 とは無関係な finding を追加 ingest しても、f-0001 自身の内容は不変なので
  // findingDigest は変わらない（通常の反復レビュー運用で偽陽性の stale を起こさないための
  // 設計。whole-array hash 方式だとここで誤って rejected になっていた）。
  ingestFindings({
    snapshotId,
    rawFindings: [baseFinding({ file: 'src/d.js', summary: 's4', failure_scenario: 'f4' })],
    cwd: dir,
  });
  const attempt = recordVerification({
    snapshotId,
    findingId: 'f-0001',
    findingDigest: t1.findingDigest,
    rawResult: validVerdict('f-0001'),
    cwd: dir,
  });
  assert.equal(attempt.outcome, 'accepted');
});

test('recordVerification: この finding_id の内容が再 ingest で変わった場合（手編集復旧の疑似再現）は rejected になり current として扱われない', () => {
  const dir = makeRepo();
  const { snapshotId } = seedSnapshot(dir, [baseFinding()]);
  const t1 = resolveVerificationTarget({ snapshotId, findingId: 'f-0001', cwd: dir });
  // f-0001 の内容そのものを直接書き換える（#647 既知 Low residual: 破損 artifact の削除＋
  // 同一 finding_id への再 ingest を模した状況。ingest は本来 append-only で個々の finding を
  // 書き換えないため、これは直接ファイルを操作した異常系の再現）。
  const artifactPath = t1.findingsFile;
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf-8'));
  artifact.records[0].finding.summary = 'completely different content now';
  writeFileSync(artifactPath, JSON.stringify(artifact));
  const attempt = recordVerification({
    snapshotId,
    findingId: 'f-0001',
    findingDigest: t1.findingDigest, // stale: 書き換え前のダイジェスト
    rawResult: validVerdict('f-0001'),
    cwd: dir,
  });
  assert.equal(attempt.outcome, 'rejected');
  assert.ok(attempt.errors.some((e) => e.includes('findingDigest')));
});

test('report / metrics: write 時点で accepted だった verification でも、finding 内容が事後に変わっていれば stale として除外し current 扱いしない（read 時鮮度再検証）', () => {
  const dir = makeRepo();
  const { snapshotId } = seedSnapshot(dir, [baseFinding()]);
  const t1 = resolveVerificationTarget({ snapshotId, findingId: 'f-0001', cwd: dir });
  recordVerification({
    snapshotId,
    findingId: 'f-0001',
    findingDigest: t1.findingDigest,
    rawResult: validVerdict('f-0001', { verdict: 'confirmed' }),
    cwd: dir,
  });
  // report/metrics 直後はまだ fresh
  let metrics = buildVerificationMetrics({ snapshotId, cwd: dir });
  assert.equal(metrics.confirmed, 1);
  assert.equal(metrics.staleSelected, 0);

  // f-0001 の内容を事後に書き換える（write 時点の accepted attempt はそのまま残る）
  const artifact = JSON.parse(readFileSync(t1.findingsFile, 'utf-8'));
  artifact.records[0].finding.summary = 'content changed after verification was recorded';
  writeFileSync(t1.findingsFile, JSON.stringify(artifact));

  metrics = buildVerificationMetrics({ snapshotId, cwd: dir });
  // stale になった accepted attempt は confirmed/refuted/unresolved のいずれにも計上されず、
  // silent に消えるのでもなく staleSelected として可視化される
  assert.equal(metrics.confirmed, 0);
  assert.equal(metrics.verifiedTotal, 0);
  assert.equal(metrics.staleSelected, 1);

  const report = formatVerificationReport({ snapshotId, cwd: dir });
  assert.doesNotMatch(report, /confirmed:/); // fresh な selected 一覧には現れない
  assert.match(report, /stale な verification/);
  assert.match(report, /f-0001/);
});

test('recordVerification: malformed / 空 / rejected な verification は verdict へ変換されない（critical safety invariant）', () => {
  const dir = makeRepo();
  const { snapshotId } = seedSnapshot(dir, [baseFinding()]);
  const t1 = resolveVerificationTarget({ snapshotId, findingId: 'f-0001', cwd: dir });

  const malformed = recordVerification({
    snapshotId,
    findingId: 'f-0001',
    findingDigest: t1.findingDigest,
    rawResult: { finding_id: 'f-0001', verdict: 'confirmed' }, // rationale/evidence 欠落
    cwd: dir,
  });
  assert.equal(malformed.outcome, 'rejected');

  const execError = recordVerification({
    snapshotId,
    findingId: 'f-0001',
    findingDigest: t1.findingDigest,
    executionError: { status: 'timeout', detail: 'maxTurns reached' },
    cwd: dir,
  });
  assert.equal(execError.outcome, 'execution_error');
  assert.equal(execError.executionStatus, 'timeout');

  const metrics = buildVerificationMetrics({ snapshotId, cwd: dir });
  // rejected/execution_error のどちらも confirmed/refuted/unresolved のいずれにも計上されない
  assert.equal(metrics.verifiedTotal, 0);
  assert.equal(metrics.confirmed, 0);
  assert.equal(metrics.refutedEvidence, 0);
  assert.equal(metrics.unresolvedConcern, 0);
  assert.equal(metrics.rejectedTotal, 1);
  assert.equal(metrics.executionErrorTotal, 1);
});

test('recordVerification: 未知の executionStatus は unknown へ丸められる（閉じた語彙）', () => {
  const dir = makeRepo();
  const { snapshotId } = seedSnapshot(dir, [baseFinding()]);
  const t1 = resolveVerificationTarget({ snapshotId, findingId: 'f-0001', cwd: dir });
  const attempt = recordVerification({
    snapshotId,
    findingId: 'f-0001',
    findingDigest: t1.findingDigest,
    executionError: { status: 'totally-made-up-status', detail: 'x' },
    cwd: dir,
  });
  assert.equal(attempt.executionStatus, 'unknown');
});

test('duplicate verifier result: 複数回の verify は silent overwrite せず、最新 accepted が selected になる', () => {
  const dir = makeRepo();
  const { snapshotId } = seedSnapshot(dir, [baseFinding()]);
  const t1 = resolveVerificationTarget({ snapshotId, findingId: 'f-0001', cwd: dir });
  const first = recordVerification({
    snapshotId,
    findingId: 'f-0001',
    findingDigest: t1.findingDigest,
    rawResult: validVerdict('f-0001', {
      verdict: 'unresolved_concern',
      rationale: 'first pass unresolved',
    }),
    cwd: dir,
  });
  const t1b = resolveVerificationTarget({ snapshotId, findingId: 'f-0001', cwd: dir });
  const second = recordVerification({
    snapshotId,
    findingId: 'f-0001',
    findingDigest: t1b.findingDigest,
    rawResult: validVerdict('f-0001', {
      verdict: 'confirmed',
      rationale: 'second pass confirmed it',
    }),
    cwd: dir,
  });
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);

  const artifact = JSON.parse(
    readFileSync(join(t1.snap.dir, STRUCTURED_FINDINGS_VERIFICATION_FILE), 'utf-8'),
  );
  assert.equal(artifact.attempts.length, 2); // 両方とも append され、上書きされていない

  const { selected } = deriveVerificationView(artifact.attempts);
  assert.equal(selected.get('f-0001').result.verdict, 'confirmed'); // 最新 accepted が採用される

  const metrics = buildVerificationMetrics({ snapshotId, cwd: dir });
  assert.equal(metrics.verifiedTotal, 1); // 重複は多数決ではなく1件として数える
  assert.equal(metrics.confirmed, 1);
});

test('metrics: --angle 指定で観点別の内訳になる（finder provenance との紐付け）', () => {
  const dir = makeRepo();
  const { snapshotId } = seedSnapshot(dir, [
    baseFinding({ file: 'src/a.js', provenance: { angle: 'adversarial', anchor_class: 'x' } }),
    baseFinding({
      file: 'src/b.js',
      summary: 's2',
      failure_scenario: 'f2',
      provenance: { angle: 'spec', anchor_class: 'y' },
    }),
  ]);
  const t1 = resolveVerificationTarget({ snapshotId, findingId: 'f-0001', cwd: dir });
  recordVerification({
    snapshotId,
    findingId: 'f-0001',
    findingDigest: t1.findingDigest,
    rawResult: validVerdict('f-0001', { verdict: 'confirmed' }),
    cwd: dir,
  });
  const t2 = resolveVerificationTarget({ snapshotId, findingId: 'f-0002', cwd: dir });
  recordVerification({
    snapshotId,
    findingId: 'f-0002',
    findingDigest: t2.findingDigest,
    rawResult: validVerdict('f-0002', {
      verdict: 'refuted_evidence',
      rationale: 'the scenario cannot occur because of an existing check',
    }),
    cwd: dir,
  });

  const adversarialMetrics = buildVerificationMetrics({
    snapshotId,
    cwd: dir,
    angle: 'adversarial',
  });
  assert.equal(adversarialMetrics.confirmed, 1);
  assert.equal(adversarialMetrics.refutedEvidence, 0);

  const specMetrics = buildVerificationMetrics({ snapshotId, cwd: dir, angle: 'spec' });
  assert.equal(specMetrics.refutedEvidence, 1);
  assert.equal(specMetrics.confirmed, 0);
});

test('human adjudication comparison: agreement / disagreement を最小限に導出する', () => {
  const dir = makeRepo();
  const { snapshotId } = seedSnapshot(dir, [
    baseFinding({ file: 'src/a.js' }),
    baseFinding({ file: 'src/b.js', summary: 's2', failure_scenario: 'f2' }),
  ]);
  const t1 = resolveVerificationTarget({ snapshotId, findingId: 'f-0001', cwd: dir });
  recordVerification({
    snapshotId,
    findingId: 'f-0001',
    findingDigest: t1.findingDigest,
    rawResult: validVerdict('f-0001', { verdict: 'confirmed' }),
    cwd: dir,
  });
  const t2 = resolveVerificationTarget({ snapshotId, findingId: 'f-0002', cwd: dir });
  recordVerification({
    snapshotId,
    findingId: 'f-0002',
    findingDigest: t2.findingDigest,
    rawResult: validVerdict('f-0002', {
      verdict: 'refuted_evidence',
      rationale: 'an existing guard already prevents this scenario',
    }),
    cwd: dir,
  });
  recordHumanAdjudication({ snapshotId, findingId: 'f-0001', adjudication: 'valid', cwd: dir });
  // 人間は f-0002 を「実は valid」と裁定 → verifier の refuted_evidence と食い違う
  recordHumanAdjudication({ snapshotId, findingId: 'f-0002', adjudication: 'valid', cwd: dir });

  const metrics = buildVerificationMetrics({ snapshotId, cwd: dir });
  assert.equal(metrics.humanComparison.compared, 2);
  assert.equal(metrics.humanComparison.agreement, 1);
  assert.equal(metrics.humanComparison.disagreement, 1);
});

test('authority regression: verification の記録は finder の finding（severity/scope_relation/evidence）を書き換えない', () => {
  const dir = makeRepo();
  const { snapshotId } = seedSnapshot(dir, [
    baseFinding({ severity: 'high', scope_relation: 'introduced', evidence: 'strong' }),
  ]);
  const t1 = resolveVerificationTarget({ snapshotId, findingId: 'f-0001', cwd: dir });
  recordVerification({
    snapshotId,
    findingId: 'f-0001',
    findingDigest: t1.findingDigest,
    rawResult: validVerdict('f-0001', {
      verdict: 'refuted_evidence',
      rationale: 'the failure scenario premise does not hold under current guards',
    }),
    cwd: dir,
  });
  const after = resolveVerificationTarget({ snapshotId, findingId: 'f-0001', cwd: dir });
  assert.equal(after.finding.severity, 'high');
  assert.equal(after.finding.scope_relation, 'introduced');
  assert.equal(after.finding.evidence, 'strong'); // Actionable + refuted_evidence でも finder evidence は不変
});

test('authority regression: verifier は ANGLE_TOKENS へ登録されない（新しい review angle ではない）', () => {
  assert.equal(Object.hasOwn(ANGLE_TOKENS, 'verifier'), false);
  assert.equal(Object.hasOwn(ANGLE_TOKENS, 'verify'), false);
});

test('report: accepted が1件も無い finding_id を警告として表示する', () => {
  const dir = makeRepo();
  const { snapshotId } = seedSnapshot(dir, [baseFinding()]);
  const t1 = resolveVerificationTarget({ snapshotId, findingId: 'f-0001', cwd: dir });
  recordVerification({
    snapshotId,
    findingId: 'f-0001',
    findingDigest: t1.findingDigest,
    executionError: { status: 'model_failure', detail: 'crash' },
    cwd: dir,
  });
  const report = formatVerificationReport({ snapshotId, cwd: dir });
  assert.match(report, /accepted な verification が1件も無い/);
  assert.match(report, /f-0001/);
});

// 回帰テスト（レビューループ発見）: assertArtifactBinding は元々
// STRUCTURED_FINDINGS_SCHEMA_VERSION（findings artifact 専用の定数）へ内部的に固定されており、
// verification artifact（別の schemaVersion 系列を持つ）へそのまま再利用すると、findings 側の
// schemaVersion が将来変わった場合に無関係の verification artifact まで誤って
// 「schemaVersion 不一致」と判定される（逆に、値がたまたま一致している間は誤って検証を
// すり抜ける）取り違えがあった。`expectedSchemaVersion` パラメータを明示できるように修正した。
test('assertArtifactBinding: expectedSchemaVersion を明示できる（findings と verification の取り違え回帰）', () => {
  const artifact = { schemaVersion: 7, contractVersion: 1, snapshotId: 's1' };
  // findings 側の既定値（1）とは一致しないが、明示した期待値（7）とは一致する場合に通ること
  assert.doesNotThrow(() =>
    assertArtifactBinding(artifact, {
      file: 'x.json',
      expectedSnapshotId: 's1',
      expectedSchemaVersion: 7,
    }),
  );
  // 明示しない場合は引き続き findings 側の既定値で検証される（既存呼び出し側の後方互換）
  assert.throws(
    () => assertArtifactBinding(artifact, { file: 'x.json', expectedSnapshotId: 's1' }),
    new RegExp(`期待値=${STRUCTURED_FINDINGS_SCHEMA_VERSION}`),
  );
});

test('recordVerification: verification artifact の schemaVersion 不一致は verification 専用の期待値で検出される（findings の schemaVersion とは独立）', () => {
  const dir = makeRepo();
  const { snapshotId } = seedSnapshot(dir, [baseFinding()]);
  const t1 = resolveVerificationTarget({ snapshotId, findingId: 'f-0001', cwd: dir });
  recordVerification({
    snapshotId,
    findingId: 'f-0001',
    findingDigest: t1.findingDigest,
    rawResult: validVerdict('f-0001', { verdict: 'confirmed' }),
    cwd: dir,
  });
  const verificationFile = join(t1.snap.dir, STRUCTURED_FINDINGS_VERIFICATION_FILE);
  const corrupted = JSON.parse(readFileSync(verificationFile, 'utf-8'));
  corrupted.schemaVersion = 999; // findings 側の値でも verification 側の正当な値でもない
  writeFileSync(verificationFile, JSON.stringify(corrupted));
  assert.throws(
    () =>
      recordVerification({
        snapshotId,
        findingId: 'f-0001',
        findingDigest: t1.findingDigest,
        rawResult: validVerdict('f-0001', { verdict: 'confirmed' }),
        cwd: dir,
      }),
    new RegExp(`期待値=${STRUCTURED_FINDINGS_VERIFICATION_SCHEMA_VERSION}`),
  );
});
