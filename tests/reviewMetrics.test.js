import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ESCALATION_SOURCES,
  MISS_TYPES,
  OBTAINABLE_METRICS,
  UNOBTAINABLE_METRICS,
  formatSummary,
  metricsFile,
  readAll,
  record,
  recordExplicitEscalation,
  recordMiss,
  recordRoutingObservation,
  summarize,
} from '../scripts/agent/review-metrics.js';
import { SHADOW_FAILURE_REASONS, SHADOW_FILE } from '../scripts/agent/shadow-routing.js';
import { createSnapshot } from '../scripts/agent/review-snapshot.js';
import { makeTmpGitRepo, sh, write } from './helpers/tmpGitRepo.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// CLI 経路の結合テスト。単体テストは record() を直接呼ぶため、parseArgs が
// `--status`（値なし）を真偽値へ落とす CLI 特有のバグ（敵対的レビュー所見 N2）は
// 単体テストだけでは検出できない（実運用の CLI 呼び出しだけが壊れるクラス）。
function runMetricsCli(dir, args) {
  return execFileSync('node', [join(ROOT, 'scripts/agent/review-metrics.js'), ...args], {
    cwd: dir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function makeRepo() {
  const dir = makeTmpGitRepo('review-metrics-');
  write(dir, 'a.txt', 'a\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'init']);
  return dir;
}

// Phase 5 §15.4 authority switch のテストで routingAuthority/entries/escalations/selection を
// 差し替えたい呼び出しのために optional 引数を追加した（コード品質レビュー所見: 元々 authority
// 系のテスト5箇所がこのヘルパーを再利用せず、ほぼ同型の JSON literal 構築をそれぞれ再実装して
// いた。record 形式が変わったとき一部のテストだけ追従し忘れるドリフトを防ぐ）。
// 引数を渡さない既存呼び出しは全て従来どおりの固定値のまま（デフォルト値で再現）。
function writeRoutingArtifacts(
  dir,
  {
    valid = true,
    failureReason = null,
    routingAuthority = null,
    routingFallbackReason = null,
    routingFallbackDetail = null,
    entries = null,
    escalations = null,
    selection = null,
    skipShadowFile = false,
  } = {},
) {
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  writeFileSync(
    join(snap.dir, 'review-plan.json'),
    `${JSON.stringify({
      version: 1,
      snapshotId: snap.snapshotId,
      ...(routingAuthority != null ? { routingAuthority } : {}),
      ...(routingFallbackReason != null ? { routingFallbackReason } : {}),
      ...(routingFallbackDetail != null ? { routingFallbackDetail } : {}),
      entries: entries ?? [
        { angle: 'subtractive' },
        { angle: 'spec' },
        { angle: 'memory' },
        {
          angle: 'quality',
          budgetOutcome: 'exhausted',
          withheld: { mode: 'diff-explore', fresh: true, reason: 'changed' },
        },
      ],
      escalations: escalations ?? [
        { seq: 2, kind: 'manual-escalation', angles: ['quality'] },
        { seq: 3, kind: 'tier-reclassification', angles: ['adversarial'] },
      ],
    })}\n`,
  );
  if (skipShadowFile) return snap;
  writeFileSync(
    join(snap.dir, SHADOW_FILE),
    `${JSON.stringify(
      valid
        ? {
            version: 1,
            snapshotId: snap.snapshotId,
            valid: true,
            shadowFailure: null,
            selection: selection ?? {
              selectedAngles: ['spec', 'testquality'],
              conditionalAngles: ['memory'],
              escalatedAngles: ['quality'],
              selectedSidecars: ['/security-review'],
            },
          }
        : {
            version: 1,
            snapshotId: snap.snapshotId,
            valid: false,
            shadowFailure: { reason: failureReason, errors: ['failed'] },
            selection: null,
          },
    )}\n`,
  );
  return snap;
}

test('取得可能な指標のみ記録し、未知のキーは落とす', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const row = record(
    {
      snapshotId: '0001-abc',
      angle: 'adversarial',
      mode: 'full-rescan',
      fresh: true,
      model: 'opus',
      effort: 'high',
      maxTurns: 60,
      status: 'complete',
      durationMs: 12000,
      newFindings: 2,
      validMedPlus: 1,
      uniqueValidMedPlus: 1,
      duplicateClusterParticipation: 1,
      falsePositives: 2,
      // 取得不能な指標は記録対象外（独自計測基盤を足さない方針の明示）
      tokens: 12345,
      turns: 7,
    },
    dir,
  );
  assert.equal(row.event, 'invocation');
  assert.equal(row.angle, 'adversarial');
  assert.equal(row.validMedPlus, 1);
  assert.equal(row.duplicateClusterParticipation, 1);
  assert.equal(row.tokens, undefined);
  assert.equal(row.turns, undefined);
  assert.ok(row.at, 'タイムスタンプは常に付ける');
  assert.equal(readAll(dir).length, 1);
  assert.ok(metricsFile(dir).endsWith(join('.git', 'agent-review', 'metrics.jsonl')));
});

test('未知の観点・モードは受理しない（閉じた語彙）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => record({ angle: 'nope', mode: 'full-rescan' }, dir), /未知の観点/);
  assert.throws(() => record({ angle: 'spec', mode: 'nope' }, dir), /未知のレビューモード/);
  assert.throws(
    () => record({ angle: 'toString', mode: 'full-rescan' }, dir),
    /未知の観点/,
    'プロトタイプ鎖キーを in 演算子で誤って既知観点扱いしない（Object.hasOwn で検証する）',
  );
  for (const mode of ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty']) {
    assert.throws(
      () => record({ angle: 'spec', mode }, dir),
      /未知のレビューモード/,
      `mode のプロトタイプ鎖キー ${mode} を既知モード扱いしない（敵対的レビュー所見）`,
    );
  }
  assert.throws(
    () => record({ angle: 'spec', mode: 'full-rescan', status: 'Incomplete' }, dir),
    /未知の status/,
    'status の綴り違いを complete 扱いへ黙って落とさない（敵対的レビュー所見）',
  );
});

test('CLI: --status に値を付け忘れると complete へ黙って倒れず usage error になる', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // 値なし --status（直後が別の --flag、または末尾）は parseArgs が真偽値 true にする。
  // これを complete の既定値と区別できないと、--status incomplete のつもりで打ち忘れた
  // 呼び出しが「完了」として記録される（敵対的レビュー所見 N2）。
  assert.throws(
    () =>
      runMetricsCli(dir, [
        'record',
        '--angle',
        'adversarial',
        '--mode',
        'full-rescan',
        '--status',
        '--escalation',
      ]),
    /--status には値が必要です/,
  );
  assert.throws(
    () =>
      runMetricsCli(dir, ['record', '--angle', 'adversarial', '--mode', 'full-rescan', '--status']),
    /--status には値が必要です/,
  );
  // --status を完全に省略した場合は、従来どおり complete を既定値にする（値なしフラグと
  // 省略は区別する）。
  const out = runMetricsCli(dir, ['record', '--angle', 'adversarial', '--mode', 'full-rescan']);
  assert.equal(JSON.parse(out).status, 'complete');
});

test('条件起動系統（記憶適合）も記録できる', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(record({ angle: 'memory', mode: 'diff-explore' }, dir).angle, 'memory');
});

test('集計: 起動数・裁定指標・incomplete/errorを出し、legacy escalationをexplicitへ混ぜない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  record(
    {
      angle: 'subtractive',
      mode: 'full-rescan',
      fresh: true,
      newFindings: 1,
      validMedPlus: 1,
      uniqueValidMedPlus: 1,
      duplicateClusterParticipation: 1,
      falsePositives: 1,
      durationMs: 1000,
    },
    dir,
  );
  record({ angle: 'subtractive', mode: 'findings-check', fresh: false, confirmedFindings: 1 }, dir);
  record({ angle: 'adversarial', mode: 'full-rescan', fresh: true, status: 'incomplete' }, dir);
  record({ angle: 'quality', mode: 'full-rescan', fresh: true, status: 'error' }, dir);
  record(
    { angle: 'spec', mode: 'full-rescan', fresh: true, externalFindings: 2, escalation: true },
    dir,
  );

  const s = summarize(readAll(dir));
  assert.equal(s.invocations, 5);
  assert.equal(s.fresh, 4);
  assert.equal(s.continued, 1);
  assert.equal(s.byAngle.subtractive, 2);
  assert.equal(s.byMode['full-rescan'], 4);
  assert.equal(s.byMode['findings-check'], 1);
  assert.equal(s.incomplete, 1);
  assert.equal(s.errors, 1);
  assert.equal(s.newFindings, 1);
  assert.equal(s.confirmedFindings, 1);
  assert.equal(s.externalFindings, 2);
  assert.equal(s.validMedPlus, 1);
  assert.equal(s.uniqueValidMedPlus, 1);
  assert.equal(s.duplicateClusterParticipation, 1);
  assert.equal(s.falsePositives, 1);
  assert.equal(s.escalations, 1, '旧 escalation フラグの互換集計は維持する');
  assert.equal(s.explicitEscalations, 0, '旧フラグを explicit escalation とみなさない');
  assert.equal(s.durationMs, 1000);
});

test('routing observation: actual/shadow差分・activation・manual escalation・withheldを既存artifactから射影する', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = writeRoutingArtifacts(dir);

  const row = recordRoutingObservation({ snapshotId: snap.snapshotId }, dir);
  assert.equal(row.event, 'routing');
  assert.equal(row.assessmentOutcome, 'valid');
  assert.deepEqual(row.actualAngles, ['subtractive', 'spec', 'quality']);
  assert.deepEqual(row.actualConditionalAngles, ['memory']);
  assert.deepEqual(row.shadowSelectedAngles, ['spec', 'testquality']);
  assert.deepEqual(row.shadowEscalatedAngles, ['quality']);
  assert.deepEqual(row.shadowAngles, ['spec', 'testquality', 'quality']);
  assert.deepEqual(row.shadowOnlyAngles, ['testquality']);
  assert.deepEqual(row.actualOnlyAngles, ['subtractive']);
  assert.deepEqual(row.shadowOnlyConditionalAngles, []);
  assert.deepEqual(row.actualOnlyConditionalAngles, []);
  assert.deepEqual(row.shadowSidecars, ['/security-review']);
  assert.deepEqual(row.explicitEscalationSeqs, [2]);
  assert.deepEqual(row.withheldAngles, ['quality']);

  const s = summarize(readAll(dir));
  assert.equal(s.invocations, 0, 'routing observation を reviewer invocation に混ぜない');
  assert.equal(s.routingObservations, 1);
  // この差分は subtractive（actual-only の実在する乖離）由来であって testquality ではない
  // （下のテストで testquality だけの場合は差分として数えないことを別途固定する）
  assert.equal(s.routingDiffs, 1);
  assert.equal(s.withheldRechecks, 1);
  assert.equal(s.actualActivationRate.spec, 1);
  assert.equal(s.shadowActivationRate.testquality, 1);
  assert.equal(s.assessment.shadow.valid, 1);
  assert.equal(s.explicitEscalations, 0, 'plan上のprovenanceをイベント数へ重複計上しない');
});

// Phase 5 §15.4 authority switch: --authority 省略時、review-plan.json の routingAuthority
// フィールドの**有無**から era（'shadow' / 'authority'）を自動判定する。フィールドの値
// （'authority' / 'fallback'）をそのまま era として使わない — fallback した plan も
// authority switch 後のコードで生成されたことに変わりはないため era は 'authority' のまま
// （era を誤って 'shadow' に倒すと、assessmentOutcome の authority-mode fallback 分岐が
// 発火せず、観測が shadow の invalid/error 側へ混入する）。
test('--authority 省略時: review-plan.json に routingAuthority フィールドが無ければ era は shadow', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = writeRoutingArtifacts(dir);
  const row = recordRoutingObservation({ snapshotId: snap.snapshotId }, dir);
  assert.equal(row.routingAuthority, 'shadow');
});

test('--authority 省略時: review-plan.json の routingAuthority: "authority" から era を自動判定する', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = writeRoutingArtifacts(dir, {
    routingAuthority: 'authority',
    entries: [{ angle: 'riskmodel' }, { angle: 'testquality' }],
    escalations: [],
    selection: {
      selectedAngles: ['riskmodel', 'testquality'],
      conditionalAngles: [],
      escalatedAngles: [],
      selectedSidecars: [],
    },
  });
  const row = recordRoutingObservation({ snapshotId: snap.snapshotId }, dir);
  assert.equal(
    row.routingAuthority,
    'authority',
    'plan.routingAuthority が存在する（値が "authority"）ので era は authority',
  );
  assert.equal(row.assessmentOutcome, 'valid');
});

test('--authority 省略時: review-plan.json の routingAuthority: "fallback" でも era は shadow に誤判定しない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // shadow-routing.json 自体を書かない（assess 未実施のケースを模す。skipShadowFile）
  const snap = writeRoutingArtifacts(dir, {
    routingAuthority: 'fallback',
    routingFallbackReason: 'missing',
    routingFallbackDetail: 'shadow-routing.json が存在しません',
    entries: [{ angle: 'subtractive' }],
    escalations: [],
    skipShadowFile: true,
  });
  const row = recordRoutingObservation({ snapshotId: snap.snapshotId }, dir);
  assert.equal(
    row.routingAuthority,
    'authority',
    'fallback した plan も authority switch 後のコードで生成されたことに変わりはなく、' +
      'era は authority のまま（"fallback" という値に引きずられて shadow へ倒さない）',
  );
  assert.equal(
    row.assessmentOutcome,
    'fallback',
    'era が authority かつ shadow.valid !== true なので assessmentOutcome は fallback',
  );
});

test('--authority を明示指定した場合は review-plan.json の routingAuthority より優先する', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = writeRoutingArtifacts(dir);
  const row = recordRoutingObservation(
    { snapshotId: snap.snapshotId, authority: 'authority' },
    dir,
  );
  assert.equal(row.routingAuthority, 'authority', '明示指定が自動判定より優先される');
});

// 敵対的レビュー所見 F4: shadow.valid === true でも、resolveRoutingAuthority/buildPlan の追加検証
// （空集合フロア・閉じた語彙外拒否）で plan 自身は fallback していることがある。この場合
// assessmentOutcome は shadow.valid だけを見ると誤って 'valid' に計上してしまう。
// F4 と F-A3（下記）は同一 fixture（buildPlan 自身が空集合フロアで fallback、shadow 自身は
// valid）に対する別々の assertion — 意図して同じ writeRoutingArtifacts 引数を使う
const EMPTY_FLOOR_FALLBACK_FIXTURE = {
  routingAuthority: 'fallback',
  routingFallbackReason: 'invalid',
  routingFallbackDetail: 'semantic selectedAngles が空集合でした',
  entries: [{ angle: 'subtractive' }],
  escalations: [],
  selection: { selectedAngles: [], conditionalAngles: [], escalatedAngles: [], selectedSidecars: [] },
};

test('shadow.valid===true でも plan.routingAuthority==="fallback" なら assessmentOutcome は fallback（shadow.valid だけで判定しない）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = writeRoutingArtifacts(dir, EMPTY_FLOOR_FALLBACK_FIXTURE);
  const row = recordRoutingObservation({ snapshotId: snap.snapshotId }, dir);
  assert.equal(row.routingAuthority, 'authority', 'era 自動判定はフィールドの有無だけを見る');
  assert.equal(
    row.assessmentOutcome,
    'fallback',
    'plan.routingAuthority が正 — shadow.valid===true だけで valid に倒さない',
  );
  assert.equal(row.planRoutingFallbackReason, 'invalid');
});

// 敵対的レビュー2周目所見 F-A3（med・実行確認済み）: F4 の修正で shadow.valid===true でも
// plan 自身が fallback したケースが assessmentOutcome='fallback' として計上されるようになったが、
// その行の assessmentFailureReason は null のままのため、fallbackReasonBreakdown の分類
// （INVALID_ASSESSMENT_REASONS.has(null) === false）で "error"（工程起因）へ誤分類されていた。
// 同じ行が持つ planRoutingFallbackReason: 'invalid' が summarize から一度も参照されていなかった
// ため、本 PR が新設した空集合フロア・閉じた語彙外拒否（いずれも最もモデル起因な失敗）が
// classifier の健全性指標へ一切現れず、代わりに「ファイル欠落・破損」を意味する error が
// 水増しされていた。
test('敵対的レビュー2周目所見 F-A3: shadow.valid===true だが plan が fallback した行は fallbackReasonBreakdown で invalid に計上される（error に水増ししない）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // shadow 自身は valid（dimension スキーマ検証は通っている）— assessmentFailureReason は
  // null になる（shadowFailure が無いため）。
  const snap = writeRoutingArtifacts(dir, EMPTY_FLOOR_FALLBACK_FIXTURE);
  const row = recordRoutingObservation({ snapshotId: snap.snapshotId }, dir);
  assert.equal(row.assessmentOutcome, 'fallback');
  assert.equal(row.assessmentFailureReason, null, '前提: shadow 自身は失敗を記録していない');
  assert.equal(row.planRoutingFallbackReason, 'invalid');

  const s = summarize(readAll(dir));
  assert.deepEqual(
    s.fallbackReasonBreakdown,
    { invalid: 1, error: 0 },
    'assessmentFailureReason が null でも planRoutingFallbackReason から内訳を復元し、' +
      'モデル起因の拒否（空集合フロア・閉じた語彙外）を工程起因の error へ水増ししない',
  );
});

test('shadow-routing.json が未生成（review:shadow 未実行）でも actual 側の指標は記録できる', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  writeFileSync(
    join(snap.dir, 'review-plan.json'),
    `${JSON.stringify({
      version: 1,
      snapshotId: snap.snapshotId,
      entries: [
        { angle: 'subtractive' },
        {
          angle: 'quality',
          budgetOutcome: 'exhausted',
          withheld: { mode: 'diff-explore', fresh: true, reason: 'changed' },
        },
      ],
      escalations: [],
    })}\n`,
  );
  // shadow-routing.json をあえて書かない（npm run review:shadow を一度も実行しなかった場合を模す）

  const row = recordRoutingObservation({ snapshotId: snap.snapshotId }, dir);
  assert.equal(
    row.assessmentOutcome,
    'error',
    '仕様レビュー所見F-2: shadow 未実行は shadow failure（error）として扱う',
  );
  assert.equal(row.assessmentFailureReason, 'shadow-not-assessed');
  assert.deepEqual(row.actualAngles, ['subtractive', 'quality']);
  assert.deepEqual(row.withheldAngles, ['quality']);
  assert.equal(row.shadowSelectedAngles, null);
  assert.equal(row.shadowAngles, null);

  const s = summarize(readAll(dir));
  assert.equal(
    s.actualActivationRate.subtractive,
    1,
    'shadow 未実行でも actual activation rate を記録できる',
  );
  assert.equal(s.withheldRechecks, 1, 'shadow 未実行でも withheld recheck count を記録できる');
  assert.equal(s.assessment.shadow.error, 1);
  assert.equal(
    s.shadowNotAssessed.shadow,
    1,
    '仕様レビュー所見N-1: 「未実行」を classifier の実エラーと区別して集計できる',
  );
  assert.equal(s.shadowNotAssessed.authority, 0);

  // 対照: 実際に shadow を実行した結果としての error（未実行ではない）は shadowNotAssessed に
  // 含めない
  write(dir, 'a.txt', 'b\n');
  const realError = writeRoutingArtifacts(dir, {
    valid: false,
    failureReason: 'unreadable-assessment-file',
  });
  recordRoutingObservation({ snapshotId: realError.snapshotId }, dir);
  const s2 = summarize(readAll(dir));
  assert.equal(s2.assessment.shadow.error, 2);
  assert.equal(
    s2.shadowNotAssessed.shadow,
    1,
    '実行して失敗した error は shadowNotAssessed の内訳に含めない',
  );

  // 仕様レビュー所見N-3: shadow-not-assessed は authority mode でも起きうる（outcome は
  // fallback で authority 側に計上される）。mode を跨いで合算すると shadow 行の内訳が
  // 算術的に破綻する（shadow 合計 0 なのに「うち未実行 N」が出る）ため、authority 側は
  // shadowNotAssessed.authority で別集計する。
  write(dir, 'a.txt', 'c\n');
  const authoritySnap = createSnapshot({ cwd: dir, baseRef: 'main' });
  writeFileSync(
    join(authoritySnap.dir, 'review-plan.json'),
    `${JSON.stringify({
      version: 1,
      snapshotId: authoritySnap.snapshotId,
      entries: [{ angle: 'subtractive' }],
      escalations: [],
    })}\n`,
  );
  recordRoutingObservation({ snapshotId: authoritySnap.snapshotId, authority: 'authority' }, dir);
  const s3 = summarize(readAll(dir));
  assert.equal(s3.shadowNotAssessed.shadow, 1, 'shadow 側の内訳は authority 側の発生で増えない');
  assert.equal(s3.shadowNotAssessed.authority, 1);
  assert.equal(s3.assessment.authority.fallback, 1);
});

// 外部レビュー Codex 指摘 P2: review:plan の resolveRoutingAuthority は shadow-routing.json の
// 不正 JSON・stale snapshotId を fallback として扱い必ず成功するが、record-routing がここで
// readJson の fail-loud に任せていると、まさにこの2失敗モードの観測で record-routing 自体が
// throw し、review-plan.json 側には正しく残っているはずの行が metrics に一切現れない。
test('shadow-routing.json が不正 JSON でも record-routing は throw せず、shadow failure として記録する', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  writeFileSync(
    join(snap.dir, 'review-plan.json'),
    `${JSON.stringify({
      version: 1,
      snapshotId: snap.snapshotId,
      // review:plan 自身は resolveRoutingAuthority のおかげで、この不正 JSON でも
      // fallback/invalid として正常に plan を生成できている（review-plan.js 側で実行確認済み）
      routingAuthority: 'fallback',
      routingFallbackReason: 'invalid',
      routingFallbackDetail: `${SHADOW_FILE} が不正な JSON です`,
      entries: [{ angle: 'subtractive' }],
      escalations: [],
    })}\n`,
  );
  writeFileSync(join(snap.dir, SHADOW_FILE), '{not valid json');

  let row;
  assert.doesNotThrow(() => {
    row = recordRoutingObservation({ snapshotId: snap.snapshotId }, dir);
  });
  assert.equal(row.routingAuthority, 'authority', 'era 自動判定はフィールドの有無だけを見る');
  assert.equal(row.assessmentOutcome, 'fallback');
  assert.equal(row.assessmentFailureReason, 'invalid-assessment-json');
  assert.equal(row.planRoutingFallbackReason, 'invalid');
});

test('shadow-routing.json の snapshotId が現在と不一致（stale）でも record-routing は throw せず記録する', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  writeFileSync(
    join(snap.dir, 'review-plan.json'),
    `${JSON.stringify({
      version: 1,
      snapshotId: snap.snapshotId,
      routingAuthority: 'fallback',
      routingFallbackReason: 'stale',
      routingFallbackDetail: `${SHADOW_FILE} の snapshotId が一致しません`,
      entries: [{ angle: 'subtractive' }],
      escalations: [],
    })}\n`,
  );
  writeFileSync(
    join(snap.dir, SHADOW_FILE),
    `${JSON.stringify({
      version: 1,
      snapshotId: 'old-snapshot-id',
      valid: true,
      shadowFailure: null,
      selection: { selectedAngles: ['riskmodel'], conditionalAngles: [], escalatedAngles: [], selectedSidecars: [] },
    })}\n`,
  );

  const row = recordRoutingObservation({ snapshotId: snap.snapshotId }, dir);
  assert.equal(row.assessmentOutcome, 'fallback');
  assert.equal(row.assessmentFailureReason, 'stale-snapshot');
  assert.equal(row.shadowSelectedAngles, null, 'stale と判定された shadow の selection は信頼しない');

  const s = summarize(readAll(dir));
  assert.equal(
    s.fallbackReasonBreakdown.invalid,
    1,
    'stale-snapshot は INVALID_ASSESSMENT_REASONS に含まれるため invalid 側に計上される',
  );
});

test('未登録 angle のみの shadow-only 差分は routingDiffs に数えない（まだ ANGLE_TOKENS に無い構造的な差）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  writeFileSync(
    join(snap.dir, 'review-plan.json'),
    `${JSON.stringify({
      version: 1,
      snapshotId: snap.snapshotId,
      entries: [{ angle: 'subtractive' }, { angle: 'spec' }],
      escalations: [],
    })}\n`,
  );
  writeFileSync(
    join(snap.dir, SHADOW_FILE),
    `${JSON.stringify({
      version: 1,
      snapshotId: snap.snapshotId,
      valid: true,
      shadowFailure: null,
      selection: {
        // 「future-angle」は ANGLE_TOKENS にまだ存在しない仮想の machine ID
        // （testquality は Phase 5 §15.4 authority switch で ANGLE_TOKENS へ登録済みのため、
        // この構造的免除の実例としてはもう使えない。下のテストを参照）。
        // それ以外は actual（subtractive, spec）と完全一致させる
        selectedAngles: ['subtractive', 'spec', 'future-angle'],
        conditionalAngles: [],
        escalatedAngles: [],
        selectedSidecars: [],
      },
    })}\n`,
  );

  const row = recordRoutingObservation({ snapshotId: snap.snapshotId }, dir);
  assert.deepEqual(
    row.shadowOnlyAngles,
    ['future-angle'],
    '行自体には未登録 angle を含む全量を監査用に残す',
  );
  assert.deepEqual(row.actualOnlyAngles, []);

  const s = summarize(readAll(dir));
  assert.equal(
    s.routingDiffs,
    0,
    'ANGLE_TOKENS に無い machine ID は actual に現れようがない構造的な差なので、それだけでは差分ありとしない（敵対的レビュー所見7）',
  );
});

// Phase 5 §15.4 authority switch: testquality は ANGLE_TOKENS へ登録済みのため、上のテストが
// 免除する「未登録 angle」にはもう当たらない。shadow が selected したのに actual entries に
// 現れない場合、それは authority routing が正しく launch しなかった可能性がある実際の
// routing miss であり、隠さず routingDiffs へ計上する。
test('testquality は ANGLE_TOKENS 登録後、shadow-only 差分が routingDiffs に正しく計上される', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = writeRoutingArtifacts(dir, {
    entries: [{ angle: 'subtractive' }, { angle: 'spec' }],
    escalations: [],
    selection: {
      selectedAngles: ['subtractive', 'spec', 'testquality'],
      conditionalAngles: [],
      escalatedAngles: [],
      selectedSidecars: [],
    },
  });

  const row = recordRoutingObservation({ snapshotId: snap.snapshotId }, dir);
  assert.deepEqual(row.shadowOnlyAngles, ['testquality']);
  assert.deepEqual(row.actualOnlyAngles, []);

  const s = summarize(readAll(dir));
  assert.equal(
    s.routingDiffs,
    1,
    'testquality は ANGLE_TOKENS 登録済みのため、shadow-only 出現は正規の routing miss 候補として計上する',
  );
});

test('actual routing はプロトタイプ鎖キーを既知観点として拾わない', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  writeFileSync(
    join(snap.dir, 'review-plan.json'),
    `${JSON.stringify({
      version: 1,
      snapshotId: snap.snapshotId,
      entries: [{ angle: 'subtractive' }, { angle: 'toString' }, { angle: 'constructor' }],
      escalations: [],
    })}\n`,
  );
  writeFileSync(
    join(snap.dir, SHADOW_FILE),
    `${JSON.stringify({
      version: 1,
      snapshotId: snap.snapshotId,
      valid: true,
      shadowFailure: null,
      selection: {
        selectedAngles: [],
        conditionalAngles: [],
        escalatedAngles: [],
        selectedSidecars: [],
      },
    })}\n`,
  );

  const row = recordRoutingObservation({ snapshotId: snap.snapshotId }, dir);
  assert.deepEqual(row.actualAngles, ['subtractive']);
  assert.deepEqual(row.actualConditionalAngles, []);
});

test('routing assessment failure は shadow で invalid/error を分け、authority では常に fallback になる', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const invalid = writeRoutingArtifacts(dir, { valid: false, failureReason: 'invalid-assessment' });
  recordRoutingObservation({ snapshotId: invalid.snapshotId }, dir);

  write(dir, 'a.txt', 'b\n');
  const failed = writeRoutingArtifacts(dir, {
    valid: false,
    failureReason: 'unreadable-assessment-file',
  });
  recordRoutingObservation({ snapshotId: failed.snapshotId }, dir);

  // authority mode は --fallback のような独立フラグを持たない。invalid-assessment という shadow
  // 視点なら invalid になる理由でも、authority mode では常に fallback として計上される
  // （Phase 5 plan §3.5-8: authority switch 後の assessment 失敗は必ず legacyReviewContract への
  // fallback を伴う）。
  write(dir, 'a.txt', 'c\n');
  const fallback = writeRoutingArtifacts(dir, {
    valid: false,
    failureReason: 'invalid-assessment',
  });
  const fallbackRow = recordRoutingObservation(
    { snapshotId: fallback.snapshotId, authority: 'authority' },
    dir,
  );
  assert.equal(fallbackRow.assessmentOutcome, 'fallback');
  assert.equal(
    fallbackRow.assessmentFailureReason,
    'invalid-assessment',
    'fallback でも失敗理由の粒度は assessmentFailureReason に残す',
  );

  write(dir, 'a.txt', 'd\n');
  const validAuthority = writeRoutingArtifacts(dir);
  assert.equal(
    recordRoutingObservation({ snapshotId: validAuthority.snapshotId, authority: 'authority' }, dir)
      .assessmentOutcome,
    'valid',
    'authority mode でも valid な assessment は fallback にしない',
  );

  // authority mode の fallback がすべて同じ理由とは限らない。invalid 相当（モデル起因）と
  // error 相当（工程起因）を両方作り、fallbackReasonBreakdown で内訳が復元できることを確認する
  // （敵対的レビュー所見 N1: fallback へ畳んだ結果 invalid/error が report 上 0/0 に見えていた）。
  write(dir, 'a.txt', 'e\n');
  const fallbackError = writeRoutingArtifacts(dir, {
    valid: false,
    failureReason: 'unreadable-assessment-file',
  });
  recordRoutingObservation({ snapshotId: fallbackError.snapshotId, authority: 'authority' }, dir);

  const s = summarize(readAll(dir));
  assert.equal(s.assessment.shadow.invalid, 1);
  assert.equal(s.assessment.shadow.error, 1);
  assert.equal(s.assessment.authority.fallback, 2);
  assert.equal(s.assessment.authority.valid, 1);
  assert.deepEqual(
    s.fallbackReasonBreakdown,
    { invalid: 1, error: 1 },
    'assessmentOutcome が fallback へ畳まれても invalid/error の内訳を report から復元できる',
  );
  assert.equal(
    s.routingDiffs,
    1,
    'invalid/error/fallback の4行は selection 差分を捏造しない（差分ありは valid な authority 行のみ）',
  );
  assert.throws(
    () => recordRoutingObservation({ snapshotId: 'ghost-snapshot', authority: 'shadow' }, dir),
    /台帳にありません/,
  );
});

test('miss taxonomy と explicit escalation を別イベントで記録する', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // record-routing と同じく実在 snapshot を要求するようになったため、ここでも実 snapshot を使う
  // （敵対的レビュー所見: 存在しない snapshotId への無制限記録の防止）。
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  recordMiss({ snapshotId: snap.snapshotId, missType: 'routing', target: 'testquality' }, dir);
  recordMiss({ snapshotId: snap.snapshotId, missType: 'detection', target: 'spec' }, dir);
  recordMiss({ snapshotId: snap.snapshotId, missType: 'aggregation', target: 'finding-3' }, dir);
  recordMiss({ snapshotId: snap.snapshotId, missType: 'machine', target: 'secret-scan' }, dir);
  recordExplicitEscalation(
    { snapshotId: snap.snapshotId, angles: ['quality', 'quality'], source: 'routing-miss' },
    dir,
  );
  recordExplicitEscalation(
    { snapshotId: snap.snapshotId, angles: ['adversarial', 'spec'], source: 'other' },
    dir,
  );

  const rows = readAll(dir);
  const routingEscalation = rows.find(
    (row) => row.event === 'explicit-escalation' && row.escalationSource === 'routing-miss',
  );
  assert.deepEqual(routingEscalation.angles, ['quality'], '同一コマンド内の重複angleは1つにする');

  const s = summarize(rows);
  for (const type of MISS_TYPES) assert.equal(s.misses[type], 1);
  assert.equal(
    s.externalEscapedFindings,
    4,
    '分類済みmissは外部/独立レビューのescaped findingでもある',
  );
  assert.equal(s.explicitEscalations, 2, '1 explicit escalate command = 1 event');
  assert.equal(s.routingMissEscalations, 1);
  assert.throws(
    () => recordMiss({ snapshotId: 'x', missType: 'unknown', target: 'x' }, dir),
    /未知の miss taxonomy/,
  );
  assert.throws(
    () => recordExplicitEscalation({ snapshotId: 'x', angles: [] }, dir),
    /--angles が必須/,
  );
  assert.throws(
    () => recordExplicitEscalation({ snapshotId: 'x', angles: ['spec'], source: 'nope' }, dir),
    /未知の escalation source/,
  );
  assert.throws(
    () => recordExplicitEscalation({ snapshotId: 'x', angles: ['not-a-real-angle'] }, dir),
    /未知の観点/,
    'review-plan.js escalate の assertKnownAngle と同じ閉じた語彙で検証する',
  );
  assert.throws(
    () => recordExplicitEscalation({ snapshotId: 'x', angles: ['toString'] }, dir),
    /未知の観点/,
    'プロトタイプ鎖キーを既知観点として通さない',
  );
  assert.equal(
    recordExplicitEscalation({ snapshotId: snap.snapshotId, angles: ['memory'] }, dir).angles[0],
    'memory',
    'memory は escalate --angles の既存契約どおり受理する',
  );
  assert.deepEqual(ESCALATION_SOURCES, ['other', 'routing-miss']);
  assert.throws(
    () => recordMiss({ snapshotId: 'ghost', missType: 'routing', target: 'x' }, dir),
    /台帳にありません/,
    '実在しない snapshot への miss 記録を拒否する（敵対的レビュー所見）',
  );
  assert.throws(
    () => recordExplicitEscalation({ snapshotId: 'ghost', angles: ['quality'] }, dir),
    /台帳にありません/,
    '実在しない snapshot への escalation 記録を拒否する（敵対的レビュー所見）',
  );
});

test('record-miss / record-escalation は同一事実らしき再記録を常に append し、疑わしい行にだけ印を付ける', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });

  // (snapshot, type, target) が同一でも、「曖昧な失敗後の再実行」（運用性レビュー所見2）と
  // 「同じ系統への2件目以降の別の実 escaped finding」（仕様レビュー所見N-2）を machine 側は
  // 区別できない。黙って捨てず常に append し、2件目以降には possibleDuplicate を立てる。
  const miss1 = recordMiss(
    { snapshotId: snap.snapshotId, missType: 'routing', target: 'testquality' },
    dir,
  );
  const miss2 = recordMiss(
    { snapshotId: snap.snapshotId, missType: 'routing', target: 'testquality' },
    dir,
  );
  const miss3 = recordMiss(
    { snapshotId: snap.snapshotId, missType: 'detection', target: 'testquality' },
    dir,
  );
  assert.equal(miss1.possibleDuplicate, undefined, '初回は疑いの印を付けない');
  assert.equal(miss2.possibleDuplicate, true);
  assert.equal(miss3.possibleDuplicate, undefined, '別 missType は別事実');

  const esc1 = recordExplicitEscalation(
    { snapshotId: snap.snapshotId, angles: ['quality'], source: 'routing-miss' },
    dir,
  );
  const esc2 = recordExplicitEscalation(
    { snapshotId: snap.snapshotId, angles: ['quality'], source: 'routing-miss' },
    dir,
  );
  const esc3 = recordExplicitEscalation(
    { snapshotId: snap.snapshotId, angles: ['spec', 'quality'], source: 'other' },
    dir,
  );
  assert.equal(esc1.possibleDuplicate, undefined);
  assert.equal(esc2.possibleDuplicate, true);
  assert.equal(esc3.possibleDuplicate, undefined, '別 angles 集合は別事実');

  const rows = readAll(dir);
  assert.equal(
    rows.filter((r) => r.event === 'miss').length,
    3,
    '疑わしくても件数は落とさない（過小計上しない）',
  );
  assert.equal(rows.filter((r) => r.event === 'explicit-escalation').length, 3);

  const s = summarize(rows);
  assert.equal(s.misses.routing, 2, '重複疑いでも miss taxonomy の計数からは除外しない');
  assert.equal(s.misses.detection, 1);
  assert.equal(s.explicitEscalations, 3);
  assert.equal(s.possibleDuplicateMisses, 1, '重複疑いの件数は別枠で見える');
  assert.equal(s.possibleDuplicateEscalations, 1);
});

test('CLI: --authority / --source に値を付け忘れると既定値へ黙って倒れず usage error になる', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = createSnapshot({ cwd: dir, baseRef: 'main' });
  // 運用性レビュー所見1: --status（N2）と同じクラスのバグが --authority / --source にも
  // 残っていた。値なしフラグは usage error、省略は既定値のまま。
  assert.throws(
    () =>
      runMetricsCli(dir, [
        'record-routing',
        '--snapshot',
        snap.snapshotId,
        '--authority',
        '--escalation',
      ]),
    /--authority には値が必要です/,
  );
  assert.throws(
    () =>
      runMetricsCli(dir, [
        'record-escalation',
        '--snapshot',
        snap.snapshotId,
        '--angles',
        'quality',
        '--source',
      ]),
    /--source には値が必要です/,
  );
});

test('同一 snapshot への複数回の record-routing は最新行だけを集計する（review-plan.json の in-place 上書きへの耐性）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const snap = writeRoutingArtifacts(dir);

  // T0: escalate 前。review:plan を再実行せず同じ snapshot のまま record-routing を叩く運用を模す
  recordRoutingObservation({ snapshotId: snap.snapshotId }, dir);

  // T1: review-plan.json が同じ snapshot ディレクトリへ in-place で上書きされた後（例: escalate 後の
  // 再 plan）に、同じ snapshotId でもう一度 record-routing する。actual 側の entries が増えている。
  writeFileSync(
    join(snap.dir, 'review-plan.json'),
    `${JSON.stringify({
      version: 1,
      snapshotId: snap.snapshotId,
      entries: [
        { angle: 'subtractive' },
        { angle: 'spec' },
        { angle: 'adversarial' },
        { angle: 'memory' },
        {
          angle: 'quality',
          budgetOutcome: 'exhausted',
          withheld: { mode: 'diff-explore', fresh: true, reason: 'changed' },
        },
      ],
      escalations: [
        { seq: 2, kind: 'manual-escalation', angles: ['quality'] },
        { seq: 3, kind: 'tier-reclassification', angles: ['adversarial'] },
      ],
    })}\n`,
  );
  const secondRow = recordRoutingObservation({ snapshotId: snap.snapshotId }, dir);

  const rows = readAll(dir);
  assert.equal(
    rows.filter((r) => r.event === 'routing').length,
    2,
    '生の行は両方とも監査用に metrics.jsonl へ残る',
  );

  const s = summarize(rows);
  assert.equal(
    s.routingObservations,
    1,
    '同一 (snapshot, authority) は最新行だけを1件として数える',
  );
  assert.deepEqual(
    secondRow.actualAngles,
    ['subtractive', 'spec', 'adversarial', 'quality'],
    'T1 時点の review-plan.json を正しく反映する',
  );
  // T0 の actual は subtractive/spec/quality のみだったので、T1 の adversarial が集計に混ざって
  // いれば「同一 snapshot を2回記録した」重複計上のバグが再発している
  assert.deepEqual(
    { ...s.actualActivation },
    { subtractive: 1, spec: 1, adversarial: 1, quality: 1 },
  );
});

test('shadow-routing.js の5種の failure reason すべてが invalid/error のどちらかへ正しく分類される', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // shadow-routing.js が export する閉じた語彙を直接使う（review-metrics.js 側のハードコードが
  // ドリフトしても、ここで使う reason 一覧自体は shadow-routing.js の正本に追従する）。
  const expected = {
    [SHADOW_FAILURE_REASONS.INVALID_ASSESSMENT]: 'invalid',
    [SHADOW_FAILURE_REASONS.STALE_SNAPSHOT]: 'invalid',
    [SHADOW_FAILURE_REASONS.MISSING_ASSESSMENT_FILE]: 'error',
    [SHADOW_FAILURE_REASONS.UNREADABLE_ASSESSMENT_FILE]: 'error',
    [SHADOW_FAILURE_REASONS.INVALID_ASSESSMENT_JSON]: 'error',
  };
  assert.deepEqual(
    Object.keys(expected).sort(),
    Object.values(SHADOW_FAILURE_REASONS).sort(),
    'shadow-routing.js に reason が追加/削除されたら、このテストの期待表を更新するまで気づける',
  );
  let i = 0;
  for (const [reason, outcome] of Object.entries(expected)) {
    i += 1;
    write(dir, 'a.txt', `content-${i}\n`);
    const snap = writeRoutingArtifacts(dir, { valid: false, failureReason: reason });
    const row = recordRoutingObservation({ snapshotId: snap.snapshotId }, dir);
    assert.equal(row.assessmentOutcome, outcome, `reason=${reason} は ${outcome} に分類されるべき`);
  }
});

test('レポートは取得不能な指標を明示する（取れない値を取れたことにしない）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const text = formatSummary(summarize(readAll(dir)));
  assert.match(text, /取得不能な指標/);
  assert.match(text, /miss taxonomy/);
  assert.match(text, /shadow-vs-actual/);
  assert.match(
    text,
    /Tier エスカレーション/,
    'legacy Tier escalation 行を出力から落とさない（仕様レビュー所見F-3）',
  );
  for (const key of Object.keys(UNOBTAINABLE_METRICS)) {
    assert.ok(text.includes(key), `取得不能な指標「${key}」がレポートに出ていない`);
  }
  assert.ok(
    !OBTAINABLE_METRICS.some((k) => k in UNOBTAINABLE_METRICS),
    '取得可否の分類が重複している',
  );
});

test('記録ファイルが無い状態でも集計できる（空レポート）', (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(readAll(dir), []);
  assert.equal(summarize([]).invocations, 0);
  assert.equal(summarize([]).routingObservations, 0);
  assert.equal(summarize([]).explicitEscalations, 0);
});
