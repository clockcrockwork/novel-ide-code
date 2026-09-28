import test from 'node:test';
import assert from 'node:assert/strict';

import { aggregateFindings, findingIdNumber } from '../scripts/agent/review-findings-aggregate.js';
import { validateAndNormalizeFinding } from '../scripts/agent/review-findings-normalize.js';

function finding(overrides = {}) {
  return {
    file: 'src/a.js',
    line: 10,
    summary: 'summary',
    failure_scenario: 'failure',
    scope_relation: 'introduced',
    severity: 'med',
    evidence: 'strong',
    provenance: { angle: 'adversarial', anchor_class: 'attack-surface' },
    ...overrides,
  };
}

function normalizedRecord(id, findingOverrides = {}) {
  return {
    finding_id: id,
    status: 'normalized',
    finding: { finding_id: id, ...finding(findingOverrides) },
  };
}

function invalidRecord(id, errors) {
  return { finding_id: id, status: 'invalid', errors };
}

test('空配列: すべての counts が0で、配列系フィールドも空になる', () => {
  const result = aggregateFindings([]);
  assert.deepEqual(result.canonicalFindings, []);
  assert.deepEqual(result.candidateGroups, []);
  assert.deepEqual(result.invalid, []);
  assert.equal(result.counts.totalIngested, 0);
  assert.equal(result.counts.normalized, 0);
  assert.equal(result.counts.invalid, 0);
  assert.equal(result.counts.canonical, 0);
  assert.equal(result.counts.exactDuplicates, 0);
  assert.equal(result.counts.actionable, 0);
  assert.equal(result.counts.validMedPlus, 0);
  assert.equal(result.counts.duplicateClusterParticipation, 0);
  assert.equal(result.counts.candidateGroupCount, 0);
  for (const v of Object.values(result.counts.bySeverity)) assert.equal(v, 0);
  for (const v of Object.values(result.counts.byScopeRelation)) assert.equal(v, 0);
  for (const v of Object.values(result.counts.byEvidence)) assert.equal(v, 0);
});

test('finding が1件だけなら canonical 1件・sources は自分自身のみ・candidateGroups は空', () => {
  const result = aggregateFindings([normalizedRecord('f-0001')]);
  assert.equal(result.canonicalFindings.length, 1);
  assert.deepEqual(result.canonicalFindings[0].sources, ['f-0001']);
  assert.equal(result.canonicalFindings[0].duplicateCount, 1);
  assert.deepEqual(result.candidateGroups, []);
});

test('内容が完全一致し provenance だけ異なる2件は1つの canonical entry へ統合される（sourcesはどちらも保持）', () => {
  const r1 = normalizedRecord('f-0005', {
    provenance: { angle: 'adversarial', anchor_class: 'a' },
  });
  const r2 = normalizedRecord('f-0001', { provenance: { angle: 'quality', anchor_class: 'b' } });
  const result = aggregateFindings([r1, r2]);
  assert.equal(result.canonicalFindings.length, 1);
  assert.deepEqual(result.canonicalFindings[0].sources, ['f-0001', 'f-0005']);
  assert.equal(result.canonicalFindings[0].duplicateCount, 2);
  assert.equal(
    result.canonicalFindings[0].finding_id,
    'f-0001',
    '数値として最小の id が代表になる',
  );
});

test('file+line が同じで failure_scenario/summary が異なる場合、2つの canonical entry になり same-location グループが1つできる', () => {
  const r1 = normalizedRecord('f-0001', { summary: 'summary A', failure_scenario: 'failure A' });
  const r2 = normalizedRecord('f-0002', { summary: 'summary B', failure_scenario: 'failure B' });
  const result = aggregateFindings([r1, r2]);
  assert.equal(result.canonicalFindings.length, 2);
  assert.equal(result.candidateGroups.length, 1);
  assert.equal(result.candidateGroups[0].reason, 'same-location');
  assert.deepEqual(result.candidateGroups[0].members, ['f-0001', 'f-0002']);
});

test('summary が同じで file/line/provenance が異なる場合、2つの canonical entry になり same-summary グループが1つできる', () => {
  const r1 = normalizedRecord('f-0001', {
    file: 'src/a.js',
    line: 1,
    summary: 'shared summary',
    failure_scenario: 'fail A',
  });
  const r2 = normalizedRecord('f-0002', {
    file: 'src/b.js',
    line: 2,
    summary: 'shared summary',
    failure_scenario: 'fail B',
  });
  const result = aggregateFindings([r1, r2]);
  assert.equal(result.canonicalFindings.length, 2);
  const sameSummaryGroups = result.candidateGroups.filter((g) => g.reason === 'same-summary');
  assert.equal(sameSummaryGroups.length, 1);
  assert.deepEqual(sameSummaryGroups[0].members, ['f-0001', 'f-0002']);
});

test('同一内容を3つの provenance が独立に報告した場合、1つの canonical entry に duplicateCount:3 で統合される', () => {
  const records = [
    normalizedRecord('f-0003', { provenance: { angle: 'a', anchor_class: 'x' } }),
    normalizedRecord('f-0001', { provenance: { angle: 'b', anchor_class: 'y' } }),
    normalizedRecord('f-0002', { provenance: { angle: 'c', anchor_class: 'z' } }),
  ];
  const result = aggregateFindings(records);
  assert.equal(result.canonicalFindings.length, 1);
  assert.equal(result.canonicalFindings[0].duplicateCount, 3);
  assert.equal(result.canonicalFindings[0].sources.length, 3);
  assert.deepEqual(
    result.canonicalFindings[0].reportedBy,
    ['a', 'b', 'c'],
    'reportedBy は報告した angle の重複排除済み・ソート済み一覧',
  );
  assert.deepEqual(
    result.canonicalFindings[0].anchorClasses,
    ['x', 'y', 'z'],
    'anchorClasses は同様に anchor_class の一覧',
  );
  assert.equal(
    result.canonicalFindings[0].agreement,
    true,
    'この3件は severity/evidence も完全一致しているため agreement は true になる',
  );
});

// 修正1の回帰テスト（review-spec F3）: severity/evidence は identity から除外されたため、
// file/line/summary/failure_scenario/scope_relation が一致すれば severity/evidence が異なる
// record も1つの canonical finding へ統合される。本ケースでは strongRecord 自身が唯一の
// actionable member であり、その実際の (severity, evidence) の組（high/strong）がそのまま
// 採用される（severity/evidence を別々に独立最大化した場合と偶然同じ値になるが、採用元は
// あくまで実在する1 member の組である。独立最大化が実在しない組を合成するケースは
// 「severity/evidenceは独立に最大化されない」テストで検証する）。
test('severity/evidence だけが異なる2件は1つの canonical finding へ統合され、agreement:false・severity/evidenceはactionableなmember自身の組になり、actionable はロールアップ後の値で判定される', () => {
  const weakRecord = normalizedRecord('f-0001', {
    summary: 'shared problem',
    failure_scenario: 'shared failure',
    scope_relation: 'introduced',
    severity: 'low',
    evidence: 'weak',
    provenance: { angle: 'adversarial', anchor_class: 'attack-surface' },
  });
  const strongRecord = normalizedRecord('f-0002', {
    summary: 'shared problem',
    failure_scenario: 'shared failure',
    scope_relation: 'introduced',
    severity: 'high',
    evidence: 'strong',
    provenance: { angle: 'quality', anchor_class: 'code-health' },
  });

  const result = aggregateFindings([weakRecord, strongRecord]);

  assert.equal(
    result.canonicalFindings.length,
    1,
    'severity/evidence の違いだけでは別々の canonical finding に分裂しない',
  );
  const canonical = result.canonicalFindings[0];
  assert.deepEqual(canonical.sources, ['f-0001', 'f-0002']);
  assert.equal(
    canonical.finding.severity,
    'high',
    'severity は唯一の actionable member（strongRecord）自身の値になる',
  );
  assert.equal(
    canonical.finding.evidence,
    'strong',
    'evidence は唯一の actionable member（strongRecord）自身の値になる',
  );
  assert.equal(
    canonical.agreement,
    false,
    'severity/evidence が member 間で一致しないため agreement は false',
  );
  assert.equal(
    canonical.actionable,
    true,
    '代表（数値最小 id である f-0001）単体の評価は not-actionable（low/weak）だが、' +
      'strongRecord が actionable であるため cluster 全体としては actionable と判定される',
  );
});

// 修正1の回帰テスト（review-spec F1）: severity と evidence を member ごとに独立に最大化すると、
// どちらの member も単独では actionable でないのに、実在しない組み合わせ（high/verified）が
// 合成されて actionable になってしまっていた（実行検証済み）。severity/evidence は必ず
// 同じ member の組のまま扱われるべきで、実在しない組み合わせを合成してはならない。
test('severity/evidence は独立に最大化されない: 両方 non-actionable な member から実在しない組み合わせを合成せず、actionable:false のままになる', () => {
  const highSeverityWeakEvidence = normalizedRecord('f-0001', {
    summary: 'shared problem 2',
    failure_scenario: 'shared failure 2',
    scope_relation: 'introduced',
    severity: 'high',
    evidence: 'weak',
    provenance: { angle: 'adversarial', anchor_class: 'attack-surface' },
  });
  const lowSeverityVerifiedEvidence = normalizedRecord('f-0002', {
    summary: 'shared problem 2',
    failure_scenario: 'shared failure 2',
    scope_relation: 'introduced',
    severity: 'low',
    evidence: 'verified',
    provenance: { angle: 'quality', anchor_class: 'code-health' },
  });

  const result = aggregateFindings([highSeverityWeakEvidence, lowSeverityVerifiedEvidence]);

  assert.equal(result.canonicalFindings.length, 1);
  const canonical = result.canonicalFindings[0];
  assert.equal(
    canonical.actionable,
    false,
    '両方の member が単独で non-actionable（high/weak・low/verified）なため、cluster も actionable にならない',
  );
  const isRealMemberPair =
    (canonical.finding.severity === 'high' && canonical.finding.evidence === 'weak') ||
    (canonical.finding.severity === 'low' && canonical.finding.evidence === 'verified');
  assert.ok(
    isRealMemberPair,
    `severity/evidence はどちらかの実在する member の組のままであるべき` +
      `（実際: ${canonical.finding.severity}/${canonical.finding.evidence}）`,
  );
  assert.ok(
    !(canonical.finding.severity === 'high' && canonical.finding.evidence === 'verified'),
    'high(severity) と verified(evidence) という、どちらの member も持たない組み合わせを合成していない',
  );
});

// 修正1の回帰テスト（review-spec F1）: cluster 内に1件でも actionable な member があれば、
// その member 自身の (severity, evidence) の組が採用される——他の non-actionable な member の
// severity がより高くても（本ケースでは blocker）、actionable member の評価を上書きしない。
test('cluster内に1件でもactionableなmemberがあれば actionable:true になり、そのactionableなmember自身の組が採用される', () => {
  const nonActionableMember = normalizedRecord('f-0001', {
    summary: 'shared problem 3',
    failure_scenario: 'shared failure 3',
    scope_relation: 'introduced',
    severity: 'blocker',
    evidence: 'weak',
    provenance: { angle: 'adversarial', anchor_class: 'attack-surface' },
  });
  const actionableMember = normalizedRecord('f-0002', {
    summary: 'shared problem 3',
    failure_scenario: 'shared failure 3',
    scope_relation: 'introduced',
    severity: 'med',
    evidence: 'verified',
    provenance: { angle: 'quality', anchor_class: 'code-health' },
  });

  const result = aggregateFindings([nonActionableMember, actionableMember]);

  assert.equal(result.canonicalFindings.length, 1);
  const canonical = result.canonicalFindings[0];
  assert.equal(
    canonical.actionable,
    true,
    '1件でも actionable な member（med/verified）があれば cluster は actionable になる',
  );
  assert.equal(
    canonical.finding.severity,
    'med',
    'actionable な member（med/verified）自身の severity が採用される。' +
      'non-actionable な member の severity（blocker）が高くても上書きしない',
  );
  assert.equal(
    canonical.finding.evidence,
    'verified',
    'actionable な member（med/verified）自身の evidence が採用される',
  );
});

// 修正B の回帰テスト（review-adversarial A-4: 実行検証済み）: SEVERITY_RANK に存在しない
// 未知の severity 値（artifact の事後改変由来。通常の ingest では validateAndNormalizeFinding が
// enum 検証するため発生しない）を持つ member が同一クラスタの最初の要素であっても、
// reduce の初期アキュムレータとして居座り続けず、既知の severity を持つ他の member
// （例: blocker）が正しく canonical の severity として採用されることを確認する。
// aggregateFindings へ直接手で構築した record 配列を渡す（ingest のバリデーションを経由しない）。
test('未知のseverity値を持つmemberが同一クラスタの最初の要素でも、既知のseverityを持つ他のmemberが正しくcanonicalのseverityとして採用される', () => {
  // 両 member とも evidence を 'weak' にし、isActionable が両方とも false になるようにする
  // （assessmentPool が actionableMembers ではなく group＝両方の member になることを保証する。
  // どちらかが個別に actionable だと assessmentPool がそちらだけに絞られ、未知の severity を
  // 持つ member がそもそも比較対象に残らないため、この修正の効果を検証できない）。
  const unknownSeverityFirst = normalizedRecord('f-0001', {
    summary: 'tampered cluster',
    failure_scenario: 'shared failure',
    scope_relation: 'introduced',
    severity: 'bogus-severity', // SEVERITY_RANK に存在しない未知値
    evidence: 'weak',
    provenance: { angle: 'adversarial', anchor_class: 'attack-surface' },
  });
  const knownBlockerSecond = normalizedRecord('f-0002', {
    summary: 'tampered cluster',
    failure_scenario: 'shared failure',
    scope_relation: 'introduced',
    severity: 'blocker',
    evidence: 'weak',
    provenance: { angle: 'quality', anchor_class: 'code-health' },
  });

  const result = aggregateFindings([unknownSeverityFirst, knownBlockerSecond]);

  assert.equal(result.canonicalFindings.length, 1, '同一箇所を指すため1つのクラスタへ統合される');
  const canonical = result.canonicalFindings[0];
  assert.equal(
    canonical.finding.severity,
    'blocker',
    '未知のseverity値を持つ member が最初の要素でも、既知のseverityを持つ他のmemberの評価に' +
      '正しく置き換わる（修正前は SEVERITY_RANK[未知値]=undefined との比較が常に false になり、' +
      '最初の要素に居座り続けていた）',
  );
  assert.equal(
    canonical.finding.evidence,
    'weak',
    'severity を採用したのと同じ member（knownBlockerSecond）の evidence が組で採用される',
  );
});

// 修正2の回帰テスト（review-spec 所見2(d): 実行検証済み）: severity が同値の場合に
// 「配列内で先に見つかった方」が勝つ実装だと、同じmember集合でも入力順序次第で
// canonical finding の evidence が変わってしまい、このモジュール冒頭が明示する
// 「入力配列の順序に依存しない」契約に反する。severity が同値なら evidence
// （EVIDENCE_LEVELS の既存順序で強い方）で決定的に選ぶことを確認する。
test('assessmentSource選定は入力順序に依存しない: severityが同値でevidenceが異なる2memberの場合、常にevidenceが強い方が採用される', () => {
  const verifiedMember = normalizedRecord('f-0001', {
    summary: 'order independence check',
    failure_scenario: 'shared failure',
    scope_relation: 'introduced',
    severity: 'high',
    evidence: 'verified',
    provenance: { angle: 'adversarial', anchor_class: 'attack-surface' },
  });
  const strongMember = normalizedRecord('f-0002', {
    summary: 'order independence check',
    failure_scenario: 'shared failure',
    scope_relation: 'introduced',
    severity: 'high',
    evidence: 'strong',
    provenance: { angle: 'quality', anchor_class: 'code-health' },
  });

  const forward = aggregateFindings([verifiedMember, strongMember]);
  const reversed = aggregateFindings([strongMember, verifiedMember]);

  assert.deepEqual(
    forward.canonicalFindings[0].finding,
    reversed.canonicalFindings[0].finding,
    'severity が同値の場合、配列の入力順序を入れ替えても canonical finding の内容は変わらない',
  );
  assert.equal(
    forward.canonicalFindings[0].assessmentSourceFindingId,
    reversed.canonicalFindings[0].assessmentSourceFindingId,
    'assessmentSourceFindingId も入力順序に依存せず同じ member を指す',
  );
  assert.equal(
    forward.canonicalFindings[0].finding.evidence,
    'verified',
    'severity が同値の場合、evidence がより強い（verified）member 自身の評価が採用される',
  );
  assert.equal(
    forward.canonicalFindings[0].assessmentSourceFindingId,
    'f-0001',
    'assessmentSourceFindingId は、採用元となった member（evidence=verified の f-0001）の' +
      'finding_id と一致する',
  );
});

// 修正2の回帰テスト（review-spec 所見2(d)）: severity・evidence が両方同値の場合の最終的な
// tie-break は finding_id が数値として小さい方であり、これも入力配列の順序に依存しない。
test('assessmentSource選定は入力順序に依存しない: severity・evidenceが両方同値の2memberの場合、常にfinding_idが小さい方が採用される', () => {
  const smallerId = normalizedRecord('f-0001', {
    summary: 'full tie check',
    failure_scenario: 'shared failure',
    scope_relation: 'introduced',
    severity: 'high',
    evidence: 'verified',
    provenance: { angle: 'adversarial', anchor_class: 'attack-surface' },
  });
  const largerId = normalizedRecord('f-0002', {
    summary: 'full tie check',
    failure_scenario: 'shared failure',
    scope_relation: 'introduced',
    severity: 'high',
    evidence: 'verified',
    provenance: { angle: 'quality', anchor_class: 'code-health' },
  });

  const forward = aggregateFindings([smallerId, largerId]);
  const reversed = aggregateFindings([largerId, smallerId]);

  assert.equal(
    forward.canonicalFindings[0].assessmentSourceFindingId,
    'f-0001',
    'severity・evidence が両方同値なら、finding_id が数値として小さい方（f-0001）が採用される',
  );
  assert.equal(
    reversed.canonicalFindings[0].assessmentSourceFindingId,
    'f-0001',
    '入力配列の順序を入れ替えても同じ member（f-0001）が採用される',
  );
});

// 修正2の回帰テスト（review-spec 所見2）: assessmentSourceFindingId は、canonical finding の
// identity 代表（finding_id = sources[0]）とは限らない——実際に severity/evidence の採用元と
// なった member の finding_id を指す。これが無いと、identity 代表の finding_id で
// structured-findings.json を引いたときに、元の（別の）評価と食い違う。
test('assessmentSourceFindingIdは、identity代表（finding_id）とは異なりうる、実際の採用元memberのfinding_idと一致する', () => {
  const representativeButWeak = normalizedRecord('f-0001', {
    summary: 'join key check',
    failure_scenario: 'shared failure',
    scope_relation: 'introduced',
    severity: 'low',
    evidence: 'weak',
    provenance: { angle: 'adversarial', anchor_class: 'attack-surface' },
  });
  const nonRepresentativeButActionable = normalizedRecord('f-0002', {
    summary: 'join key check',
    failure_scenario: 'shared failure',
    scope_relation: 'introduced',
    severity: 'high',
    evidence: 'verified',
    provenance: { angle: 'quality', anchor_class: 'code-health' },
  });

  const result = aggregateFindings([representativeButWeak, nonRepresentativeButActionable]);
  const canonical = result.canonicalFindings[0];

  assert.equal(canonical.finding_id, 'f-0001', '前提: identity 代表（sources[0]）は f-0001');
  assert.equal(
    canonical.assessmentSourceFindingId,
    'f-0002',
    'assessmentSourceFindingId は、severity/evidence の実際の採用元 member（f-0002）を指す。' +
      'identity 代表（f-0001）とは異なる——f-0001 自身の評価は low/weak であり、canonical.finding' +
      '（high/verified）とは食い違う',
  );
  assert.equal(canonical.finding.severity, 'high');
  assert.equal(canonical.finding.evidence, 'verified');
});

test('records の順序に依存しない: 並び替えても同じクラスタリング・件数になる', () => {
  const a = normalizedRecord('f-0001', { summary: 'dup summary', failure_scenario: 'dup failure' });
  const b = normalizedRecord('f-0002', { summary: 'dup summary', failure_scenario: 'dup failure' });
  const c = normalizedRecord('f-0003', {
    summary: 'unique summary',
    failure_scenario: 'unique failure',
    file: 'src/other.js',
    line: 99,
  });

  const result1 = aggregateFindings([a, b, c]);
  const result2 = aggregateFindings([c, a, b]);

  assert.equal(result1.canonicalFindings.length, result2.canonicalFindings.length);
  assert.equal(result1.counts.canonical, result2.counts.canonical);
  assert.equal(result1.counts.exactDuplicates, result2.counts.exactDuplicates);
  assert.deepEqual(result1.counts, result2.counts);

  const clusterSetsOf = (result) =>
    new Set(result.canonicalFindings.map((entry) => [...entry.sources].sort().join(',')));
  assert.deepEqual(clusterSetsOf(result1), clusterSetsOf(result2));
  assert.ok(clusterSetsOf(result1).has('f-0001,f-0002'));
  assert.ok(clusterSetsOf(result1).has('f-0003'));
});

test('actionable 由来の counts（actionable/validMedPlus/duplicateClusterParticipation）が計算式どおりになる', () => {
  // actionable な exact-dup クラスタ（2件: introduced/high/verified は Actionable 条件を満たす）。
  // 異なる観点（angle）が独立に報告したことを表すため provenance を変える——
  // validMedPlus/duplicateClusterParticipation は reportedBy.length（観点の重複排除件数）を
  // 数えるため、同一観点からの重複だと1件に潰れてしまう（修正3の回帰対象は別テストで扱う）。
  const actionableDup1 = normalizedRecord('f-0001', {
    summary: 'actionable dup',
    failure_scenario: 'x',
    scope_relation: 'introduced',
    severity: 'high',
    evidence: 'verified',
    provenance: { angle: 'adversarial', anchor_class: 'attack-surface' },
  });
  const actionableDup2 = normalizedRecord('f-0002', {
    summary: 'actionable dup',
    failure_scenario: 'x',
    scope_relation: 'introduced',
    severity: 'high',
    evidence: 'verified',
    provenance: { angle: 'quality', anchor_class: 'code-health' },
  });
  // actionable ではない単独 finding（scope_relation が対象集合外）
  const notActionable = normalizedRecord('f-0003', {
    file: 'src/other.js',
    line: 1,
    summary: 'not actionable',
    failure_scenario: 'y',
    scope_relation: 'pre_existing',
    severity: 'blocker',
    evidence: 'verified',
  });
  const result = aggregateFindings([actionableDup1, actionableDup2, notActionable]);

  assert.equal(result.canonicalFindings.length, 2);
  assert.equal(result.counts.actionable, 1, 'actionable な canonical entry は1件');
  assert.equal(
    result.counts.validMedPlus,
    2,
    'actionable canonical の reportedBy 件数合計（異なる2観点が独立到達したため2）',
  );
  assert.equal(
    result.counts.duplicateClusterParticipation,
    2,
    'reportedBy.length>1 の canonical の reportedBy 件数合計（actionable を問わない）',
  );
});

// 修正3の回帰テスト（review-spec F2 / review-adversarial N3）: 同一観点による自己重複
// （再実行・operational error）は、複数レビュアーの独立到達と同じ重みで計上されてはならない。
test('同一観点が同じ finding を2回報告しても、duplicateClusterParticipation は0のままで、validMedPlus は重複前と同じ値のまま増えない', () => {
  const singleRecord = normalizedRecord('f-0001', {
    summary: 'actionable single',
    scope_relation: 'introduced',
    severity: 'high',
    evidence: 'verified',
    provenance: { angle: 'adversarial', anchor_class: 'attack-surface' },
  });
  const duplicatedRecord = normalizedRecord('f-0002', {
    summary: 'actionable single',
    scope_relation: 'introduced',
    severity: 'high',
    evidence: 'verified',
    provenance: { angle: 'adversarial', anchor_class: 'attack-surface' },
  });

  const single = aggregateFindings([singleRecord]);
  const duplicated = aggregateFindings([singleRecord, duplicatedRecord]);

  assert.equal(
    duplicated.canonicalFindings.length,
    1,
    '同一観点による自己重複は1つの canonical entry へ統合される',
  );
  assert.equal(
    duplicated.counts.validMedPlus,
    single.counts.validMedPlus,
    '同一観点の自己重複は複数レビュアーの独立到達と同じ重みで計上されない',
  );
  assert.equal(
    duplicated.counts.duplicateClusterParticipation,
    0,
    '観点が1つしか無いクラスタは duplicateClusterParticipation に計上されない',
  );
});

// 修正3の回帰テスト: 異なる観点が独立に到達した場合は、従来どおり duplicate として計上される。
test('異なる2つの観点が独立に同じ finding を報告した場合は、duplicateClusterParticipation に反映され validMedPlus が2件分カウントされる', () => {
  const result = aggregateFindings([
    normalizedRecord('f-0001', {
      summary: 'actionable shared',
      scope_relation: 'introduced',
      severity: 'high',
      evidence: 'verified',
      provenance: { angle: 'adversarial', anchor_class: 'attack-surface' },
    }),
    normalizedRecord('f-0002', {
      summary: 'actionable shared',
      scope_relation: 'introduced',
      severity: 'high',
      evidence: 'verified',
      provenance: { angle: 'quality', anchor_class: 'code-health' },
    }),
  ]);

  assert.equal(result.canonicalFindings.length, 1);
  assert.equal(result.counts.validMedPlus, 2, '異なる2観点が独立到達したため2件分カウントされる');
  assert.equal(
    result.counts.duplicateClusterParticipation,
    2,
    '2観点の独立到達は duplicateClusterParticipation に反映される',
  );
});

// 修正1の回帰テスト（review-spec 所見1: 実行検証済み）: cluster全体のactionable判定
// （1件でもactionableなmemberがあればtrue）を使うと、非actionableな評価しか出していない
// 観点にまでvalidMedPlusが誤って計上される。actionableReporters（自分自身の評価が独立に
// actionableだった観点だけの一覧）を基準にすることで、observedByは両観点を含んだまま
// （収束の追跡は維持しつつ）、validMedPlusはactionableな観点の分だけに正しく限定される。
test('同一クラスタに非actionableな観点とactionableな観点が混在する場合、actionableReportersにはactionableな観点だけが含まれ、validMedPlusはその数だけ計上される', () => {
  const qualityWeak = normalizedRecord('f-0001', {
    summary: 'mixed actionable cluster',
    failure_scenario: 'shared failure',
    scope_relation: 'introduced',
    severity: 'low',
    evidence: 'weak',
    provenance: { angle: 'quality', anchor_class: 'code-health' },
  });
  const specStrong = normalizedRecord('f-0002', {
    summary: 'mixed actionable cluster',
    failure_scenario: 'shared failure',
    scope_relation: 'introduced',
    severity: 'high',
    evidence: 'verified',
    provenance: { angle: 'spec', anchor_class: 'contract' },
  });

  const result = aggregateFindings([qualityWeak, specStrong]);

  assert.equal(result.canonicalFindings.length, 1);
  const canonical = result.canonicalFindings[0];
  assert.equal(canonical.actionable, true, '前提: strongRecord により cluster 全体は actionable');
  assert.deepEqual(
    canonical.reportedBy,
    ['quality', 'spec'],
    '前提: reportedBy には両観点とも含まれる（収束の追跡は維持される）',
  );
  assert.deepEqual(
    canonical.actionableReporters,
    ['spec'],
    'actionableReporters には、自分自身の評価が独立に actionable だった spec だけが含まれ、' +
      '非actionable（low/weak）な quality は含まれない',
  );
  assert.equal(
    result.counts.validMedPlus,
    1,
    'validMedPlus は actionableReporters の合計であり、非actionable な quality の分は計上' +
      'されない（reportedBy 基準だと誤って2になっていた）',
  );
});

test('invalid record はそのまま invalid[]/counts.invalid へ通過し、正規化系の集計から除外される', () => {
  const okRecord = normalizedRecord('f-0001');
  const badRecord = invalidRecord('f-0002', ['file が不正です']);
  const result = aggregateFindings([okRecord, badRecord]);
  assert.equal(result.counts.totalIngested, 2);
  assert.equal(result.counts.normalized, 1);
  assert.equal(result.counts.invalid, 1);
  assert.deepEqual(result.invalid, [{ finding_id: 'f-0002', errors: ['file が不正です'] }]);
  assert.equal(result.counts.canonical, 1);
});

test('status が normalized/invalid のどちらでもない record は unrecognized として分離され、消えない', () => {
  const okRecord = normalizedRecord('f-0001');
  const badRecord = invalidRecord('f-0002', ['x が不正です']);
  const pendingRecord = { finding_id: 'f-0003', status: 'pending' };
  const result = aggregateFindings([okRecord, badRecord, pendingRecord]);
  assert.equal(result.counts.totalIngested, 3);
  assert.equal(result.counts.normalized, 1);
  assert.equal(result.counts.invalid, 1);
  assert.equal(result.counts.unrecognized, 1);
  assert.deepEqual(result.unrecognized, [{ finding_id: 'f-0003', status: 'pending' }]);
});

test('finding.severity が __proto__ でも throw せず、bySeverity は既知4キーのみで汚染も起きない', () => {
  const tampered = {
    finding_id: 'f-0001',
    status: 'normalized',
    finding: { finding_id: 'f-0001', ...finding({ severity: '__proto__' }) },
  };
  let result;
  assert.doesNotThrow(() => {
    result = aggregateFindings([tampered]);
  });
  assert.deepEqual(Object.keys(result.counts.bySeverity).sort(), ['blocker', 'high', 'low', 'med']);
  assert.equal(Object.getPrototypeOf(result.counts.bySeverity), null);
  assert.equal(
    Object.hasOwn(result.counts.bySeverity, 'constructor'),
    false,
    'bySeverity に __proto__/constructor 等の余分なキーが増えていない',
  );
});

test('finding_id が唯一の record でも不正な形式（f-<数字> でない）なら throw する', () => {
  const malformed = normalizedRecord('X-1');
  assert.throws(() => aggregateFindings([malformed]), /不正な finding_id 形式/);
});

test('invalid record が1件だけでも finding_id の形式が不正なら即座に throw する（status を問わない）', () => {
  const malformedInvalid = invalidRecord('BOGUS-ID', ['x が不正です']);
  assert.throws(() => aggregateFindings([malformedInvalid]), /不正な finding_id 形式/);
});

// 修正8の回帰テスト（review-quality 所見1 / review-adversarial R6）: findingIdNumber は
// export され、review-findings.js の nextSeq 計算と共有される。安全整数を超える finding_id は
// Number.parseInt の精度飽和でソートが崩れうるため、ここで throw する。
test('findingIdNumber: 安全な整数範囲を超える finding_id は throw する', () => {
  assert.throws(() => findingIdNumber('f-99999999999999999999'), /安全な整数範囲を超えています/);
});

test('finding_id が安全な整数範囲を超える record が1件でも、aggregateFindings は fail-loud する', () => {
  const huge = normalizedRecord('f-99999999999999999999');
  assert.throws(() => aggregateFindings([huge]), /安全な整数範囲を超えています/);
});

// 修正4の回帰テスト（chatgpt-codex-connector 所見。review-pr #650、実行検証済み）:
// `f-1` と `f-0001` はどちらも数値 `1` にパースされ「同じ finding_id」として扱われてしまうが、
// 実際の採番ロジック（ingestFindings）は常に `f-${String(nextSeq).padStart(4, '0')}` という
// 正準形しか生成しない。非正準形（手編集・移行由来の artifact にのみ出現しうる）が混在すると
// 代表選択やソートが入力順に依存してしまうため、正準形でない finding_id は fail-loud する。
test('findingIdNumber: ゼロ埋め桁数が異なる非正準形（f-1 等）は正準形ではないとして throw する', () => {
  assert.throws(() => findingIdNumber('f-1'), /finding_id が正準形ではありません/);
  assert.throws(() => findingIdNumber('f-1'), /`f-0001`/);
});

test('findingIdNumber: 先頭にゼロを含むが4桁ちょうどでない非正準形（f-01 等）も正準形ではないとして throw する', () => {
  assert.throws(() => findingIdNumber('f-01'), /finding_id が正準形ではありません/);
});

test('findingIdNumber: 5桁超で正しく桁が広がっている正準形（f-10000 等）は throw しない', () => {
  assert.equal(findingIdNumber('f-10000'), 10000);
  assert.equal(findingIdNumber('f-0001'), 1);
  assert.equal(findingIdNumber('f-9999'), 9999);
});

test('aggregateFindings: 非正準形の finding_id（f-1）を持つ record が1件でもあれば fail-loud する', () => {
  const nonCanonical = normalizedRecord('f-1');
  assert.throws(() => aggregateFindings([nonCanonical]), /finding_id が正準形ではありません/);
});

// 修正9の回帰テスト（review-quality 所見2 / review-adversarial R1）: unrecognized のソートは
// byFindingIdAscending（数値比較）を使う。文字列辞書順だと f-10000 が f-2000 より先に来て
// しまう。
test('unrecognized は数値順にソートされる（f-2000 が f-10000 より先に来る）', () => {
  const a = { finding_id: 'f-10000', status: 'pending' };
  const b = { finding_id: 'f-2000', status: 'pending' };
  const result = aggregateFindings([a, b]);
  assert.deepEqual(
    result.unrecognized.map((r) => r.finding_id),
    ['f-2000', 'f-10000'],
  );
});

// 修正7の統合テスト（review-spec F1）: 絶対パスと相対パスで同じ箇所を報告した2件は、
// validateAndNormalizeFinding の file 正規化により同じ file 文字列になり、
// aggregateFindings で1つの exact-duplicate クラスタへ統合される。
test('絶対パスと相対パスで同じ箇所を報告した2件は、file の正規化により exact-duplicate クラスタとして統合される', () => {
  const cwd = '/repo/root';
  const rawFinding = (file) => ({
    file,
    line: 10,
    summary: 'summary',
    failure_scenario: 'failure',
    scope_relation: 'introduced',
    severity: 'med',
    evidence: 'strong',
    provenance: { angle: 'adversarial', anchor_class: 'attack-surface' },
  });

  const absoluteResult = validateAndNormalizeFinding(rawFinding('/repo/root/src/a.js'), { cwd });
  const relativeResult = validateAndNormalizeFinding(rawFinding('src/a.js'), { cwd });
  assert.equal(absoluteResult.status, 'normalized');
  assert.equal(relativeResult.status, 'normalized');
  assert.equal(
    absoluteResult.finding.file,
    relativeResult.finding.file,
    '絶対パス・相対パスとも正規化後は同じ file 文字列になる',
  );

  const records = [
    {
      finding_id: 'f-0001',
      status: 'normalized',
      finding: { finding_id: 'f-0001', ...absoluteResult.finding },
    },
    {
      finding_id: 'f-0002',
      status: 'normalized',
      finding: { finding_id: 'f-0002', ...relativeResult.finding },
    },
  ];

  const result = aggregateFindings(records);
  assert.equal(
    result.canonicalFindings.length,
    1,
    '絶対/相対パス表記の違いだけの2件は1つの canonical へ統合される',
  );
  assert.deepEqual(result.canonicalFindings[0].sources, ['f-0001', 'f-0002']);
});
