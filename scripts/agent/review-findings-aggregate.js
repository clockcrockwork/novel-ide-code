// 正規化済み finding（structured-findings.json の records[]）の決定論的な集約。
//
// このモジュールが行うのはこの2つだけ:
//   1. 完全一致（file/line/summary(trim)/failure_scenario(trim)/scope_relation が全て一致）に
//      よる重複クラスタリング（severity/evidence は reviewer ごとの評価であり identity には
//      含めない。canonical finding の severity/evidence は、severity と evidence を member ごとに
//      独立に最大化して組み合わせることはしない——それでは、どの reviewer も下していない評価が
//      合成されうる（review-spec F1で実証）。actionable な member があればその中で・無ければ
//      全member中で severity が最も強いものを選び、その member 自身の (severity, evidence) の組を
//      そのまま canonical finding へ採用する。member 間で一致しない場合は agreement:false として
//      記録する）
//   2. 内容の明示的な一致（同一 file+line、または同一 summary）に基づく候補グルーピング
// LLM 呼び出し・embedding 計算・意味的類似性判定は一切行わない。あいまいな重複の意味的な
// 裁定は、このモジュールの外側（issue #647: aggregation は semantic adjudication の代わりに
// はならない — 意味的な重複判定は将来の人間/モデルによる検証工程に委ねる）に意図的に残す。
// false-merge（無関係な finding を誤って1つに畳む）は、重複を畳み損ねるより有害という判断で、
// あいまいな一致は候補（candidateGroups）止まりにし、確定的な統合はしない。
//
// 入力配列の順序に依存しない: 同じ内容の records を任意の順序で渡しても同じクラスタリング・
// 候補グループ・counts を返す（最終出力は常に明示的に finding_id 昇順等でソートする）。

import {
  EVIDENCE_LEVELS,
  SCOPE_RELATIONS,
  SEVERITIES,
  SEVERITY_RANK,
} from './review-finding-contract.js';
import { isActionable } from './review-findings-normalize.js';

// finding_id（`f-<数字>`。#9999 を超えると桁が広がる）の数値部分だけを取り出して比較する。
// 文字列としての辞書順比較では `f-10000` が `f-2000` より小さく見えてしまう
// （'1' < '2' のため）ので、常にこの数値比較を使う。
// review-findings.js（ingest 側の nextSeq 計算）と重複実装しないよう export する
// （review-quality 所見1）。安全整数チェックも併せて行う——チェックしないと
// `Number.parseInt` の精度飽和により、finding_id が安全な整数範囲を超える record を含む
// 場合に決定論的ソートが崩れる（review-adversarial R6: 実行検証済み）。
export function findingIdNumber(id) {
  const m = /^f-(\d+)$/.exec(id);
  if (!m) throw new Error(`不正な finding_id 形式です（f-<数字> である必要があります）: ${id}`);
  const parsed = Number.parseInt(m[1], 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`finding_id が安全な整数範囲を超えています: ${id}`);
  }
  // ingest 側の採番ロジック（review-findings.js の nextSeq 計算）は常に
  // `f-${String(nextSeq).padStart(4, '0')}`（4桁未満はゼロ埋め、4桁超は桁を広げる。折り返し・
  // 切り詰めなし）という正準形しか生成しない。`f-1` と `f-0001` のような非正準形（手編集・移行
  // 由来の artifact にのみ出現しうる）を同じ数値として扱うと、aggregateFindings の代表選択や
  // ソートが入力順に依存してしまい、このモジュール冒頭が掲げる「入力配列の順序に依存しない」
  // 契約に反する。パースした数値を採番ロジックと同じ規則で再構成し、元の文字列と一致しない
  // 場合は正準形でないとして fail-loud する。
  const canonical = String(parsed).padStart(4, '0');
  if (canonical !== m[1]) {
    throw new Error(
      `finding_id が正準形ではありません（\`f-${canonical}\` である必要があります）: ${id}`,
    );
  }
  return parsed;
}

function byFindingIdAscending(a, b) {
  return findingIdNumber(a) - findingIdNumber(b);
}

function sortIdsNumerically(ids) {
  return [...ids].sort(byFindingIdAscending);
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    const bucket = map.get(key);
    if (bucket) bucket.push(item);
    else map.set(key, [item]);
  }
  return map;
}

// 重複クラスタリングの完全一致キー。identity（何を報告しているか）だけを使う。
// severity/evidence は「同じ問題に対する reviewer ごとの評価」であり、reviewer間で
// 正当に異なりうるため identity に含めない —— 含めると、同じ問題を独立に発見した
// 複数観点が severity/evidence の違いだけで別々の canonical finding に分裂し、
// 収束の検出（duplicateClusterParticipation・agreement）が機能しなくなる
// （review-spec F3で実証。実行検証済み）。scope_relation は診断結果というより
// 「diffがこの問題を持ち込んだか」という識別上の判断のため identity に残す。
// provenance / angle_fields も意図的に除外する（複数レビュアーが同じ問題を報告した場合に
// 1つの canonical entry へ畳むため）。fuzzy / 大文字小文字無視 / 空白の正規化は `.trim()`
// 以外一切行わない（byte-for-byte-after-trim の一致だけを「完全一致」と扱う）。
function exactDuplicateKey(finding) {
  return JSON.stringify([
    finding.file,
    finding.line,
    finding.summary.trim(),
    finding.failure_scenario.trim(),
    finding.scope_relation,
  ]);
}

// クラスタの member から重複排除済み・ソート済みの provenance 値一覧を取り出す
// （reportedBy/anchorClasses で共有する）。
function sortedDistinct(values) {
  return [...new Set(values)].sort();
}

// severity → evidence（EVIDENCE_LEVELSの既存順序）→ finding_id（数値小さい方）の順で
// 完全に決定的な比較にする。severityが同値の場合に「配列内で先に見つかった方」が勝つ
// 実装だと、同じmember集合でも入力順序次第でcanonical findingの evidence が変わってしまい、
// このモジュール冒頭が明示する「入力配列の順序に依存しない」契約に反する
// （review-spec 所見2(d)で実証。実行検証済み）。
function isStrongerAssessment(candidate, current) {
  const severityDiff =
    SEVERITY_RANK[candidate.finding.severity] - SEVERITY_RANK[current.finding.severity];
  if (severityDiff !== 0) return severityDiff > 0;
  // EVIDENCE_LEVELS は強い順（verified > strong > weak）に並んでいるため、index が
  // 小さいほど強い。
  const evidenceDiff =
    EVIDENCE_LEVELS.indexOf(candidate.finding.evidence) -
    EVIDENCE_LEVELS.indexOf(current.finding.evidence);
  if (evidenceDiff !== 0) return evidenceDiff < 0;
  // 完全に同点の場合は finding_id が小さい方で決定的にする（配列の並び順に依存しない）。
  return findingIdNumber(candidate.finding_id) < findingIdNumber(current.finding_id);
}

function buildCanonicalFindings(normalized) {
  const groups = groupBy(normalized, (record) => exactDuplicateKey(record.finding));
  const canonical = [];
  for (const group of groups.values()) {
    const sources = sortIdsNumerically(group.map((record) => record.finding_id));
    const representative = group.find((record) => record.finding_id === sources[0]);
    const severities = group.map((record) => record.finding.severity);
    const evidenceValues = group.map((record) => record.finding.evidence);
    // severity/evidence は必ず同じ member の組のまま扱う。個別に最大化して組み合わせると、
    // どの reviewer も下していない評価が合成されうる（review-spec F1で実証。実行検証済み:
    // severity=high/evidence=weak の member と severity=low/evidence=verified の member から
    // 独立最大化で high/verified を合成すると、どちらの member も単独では actionable でないのに
    // cluster が actionable になってしまう）。actionable な member があればその中で severity が
    // 最も強いものを、無ければ全member中で severity が最も強いものを、その member 自身の
    // (severity, evidence) の組ごと採用する。
    const actionableMembers = group.filter((record) => isActionable(record.finding));
    const assessmentPool = actionableMembers.length > 0 ? actionableMembers : group;
    // SEVERITY_RANK に存在しない severity 値（artifact の事後改変由来）が reduce の初期
    // アキュムレータになると、実数との比較は常に false になるため正規の severity に置き
    // 換わらない（review-adversarial A-4: 実行検証済み）。既知の severity を持つ member
    // だけを比較対象にし、1件も無ければ representative（identity キー内で finding_id が
    // 最小の member）へ安全側にフォールバックする。
    const knownSeverityPool = assessmentPool.filter((record) =>
      Object.hasOwn(SEVERITY_RANK, record.finding.severity),
    );
    const assessmentSource =
      knownSeverityPool.length > 0
        ? knownSeverityPool.reduce((best, record) =>
            isStrongerAssessment(record, best) ? record : best,
          )
        : representative;
    const rolledUpFinding = {
      ...representative.finding,
      severity: assessmentSource.finding.severity,
      evidence: assessmentSource.finding.evidence,
    };
    canonical.push({
      finding_id: sources[0],
      finding: rolledUpFinding,
      // rolledUpFinding.severity/evidence がどの member（finding_id）の実際の評価かを記録する。
      // これが無いと、identity代表（finding_id）でstructured-findings.jsonを引いたときに、
      // 元の（別かもしれない）評価と食い違い、finding_idがjoin keyとして機能しなくなる
      // （review-spec 所見2で実証）。
      assessmentSourceFindingId: assessmentSource.finding_id,
      sources,
      duplicateCount: sources.length,
      actionable: actionableMembers.length > 0,
      // このクラスタ内で、自分自身の評価が独立にactionableだった観点の一覧（重複排除・ソート済み）。
      // cluster全体のactionable判定（1件でもactionableなmemberがあればtrue）とは別に、観点ごとの
      // metrics帰属（validMedPlus等）が「その観点自身がactionableと評価したか」を正しく区別できる
      // ようにする（review-spec 所見1: 実行検証済み。低evidence/低severityの観点が、同じクラスタに
      // 別の観点のactionableな評価が同居しているというだけでvalid Med+を誤って計上されるのを防ぐ）。
      actionableReporters: sortedDistinct(
        actionableMembers.map((record) => record.finding.provenance.angle),
      ),
      reportedBy: sortedDistinct(group.map((record) => record.finding.provenance.angle)),
      anchorClasses: sortedDistinct(group.map((record) => record.finding.provenance.anchor_class)),
      // severity/evidence が identity に含まれないため、同一クラスタの member 間で一致しない
      // ことがありうる。全 member の severity・evidence がそれぞれ1種類しかない場合のみ true。
      agreement: new Set(severities).size === 1 && new Set(evidenceValues).size === 1,
    });
  }
  canonical.sort((a, b) => byFindingIdAscending(a.finding_id, b.finding_id));
  return canonical;
}

// 候補グルーピングは重複排除済みの canonicalFindings に対して行う（同一クラスタのメンバー同士が
// 自明に「同じ場所/summary」でグループ化されるのを避けるため）。overlay 注釈にすぎず、
// canonicalFindings 自体を統合・削除しない（1つの canonical finding が0個・1個・両方の
// グループへ属してよい）。
function buildCandidateGroups(canonicalFindings) {
  const byLocation = groupBy(
    canonicalFindings.filter((c) => c.finding.line !== null),
    (c) => JSON.stringify([c.finding.file, c.finding.line]),
  );
  const bySummary = groupBy(canonicalFindings, (c) => c.finding.summary.trim());

  const groups = [];
  for (const members of byLocation.values()) {
    if (members.length < 2) continue;
    groups.push({
      reason: 'same-location',
      file: members[0].finding.file,
      line: members[0].finding.line,
      members: sortIdsNumerically(members.map((m) => m.finding_id)),
    });
  }
  for (const members of bySummary.values()) {
    if (members.length < 2) continue;
    groups.push({
      reason: 'same-summary',
      summary: members[0].finding.summary.trim(),
      members: sortIdsNumerically(members.map((m) => m.finding_id)),
    });
  }

  // (reason asc, numeric-min-member-id asc) でソートしてから groupId を割り当てる。
  groups.sort((a, b) => {
    if (a.reason !== b.reason) return a.reason < b.reason ? -1 : 1;
    return findingIdNumber(a.members[0]) - findingIdNumber(b.members[0]);
  });
  return groups.map((g, i) => ({ groupId: `g-${String(i + 1).padStart(4, '0')}`, ...g }));
}

// INVARIANTS.md #11: データ由来の文字列をキーにする辞書は Object.create(null) を基底にする。
function zeroCounts(keys) {
  return Object.assign(Object.create(null), Object.fromEntries(keys.map((k) => [k, 0])));
}

/**
 * ingest-log（structured-findings.json の records[]）を集約する純粋関数。
 * 副作用（fs・Date.now・乱数）を持たず、同じ入力に対して常に同じ出力を返す。
 */
export function aggregateFindings(records) {
  // finding_id の形式検証を、後続のソート比較（byFindingIdAscending は2件以上でしか
  // 呼ばれない）にも、record の status にも依存させない。normalized だけでなく
  // invalid/unrecognized も含めた全 record を、他の処理を行う前に検証する — status ごとに
  // フィルタしてから検証すると、対象外の status・件数（2件未満）では素通りしてしまう。
  for (const r of records) {
    findingIdNumber(r.finding_id);
  }

  const normalized = records.filter((r) => r.status === 'normalized');
  const invalidRecords = records.filter((r) => r.status === 'invalid');
  // status が 'normalized'/'invalid' のどちらでもない record（手で壊された/汚染された
  // artifact 由来）を黙って両方のフィルタからすり抜けさせない。ここで独立の第三バケツへ集める
  // （totalIngested === normalized + invalid + unrecognized を常に保つ）。
  const unrecognizedRecords = records.filter(
    (r) => r.status !== 'normalized' && r.status !== 'invalid',
  );

  const canonicalFindings = buildCanonicalFindings(normalized);
  const candidateGroups = buildCandidateGroups(canonicalFindings);
  const invalid = [...invalidRecords]
    .sort((a, b) => byFindingIdAscending(a.finding_id, b.finding_id))
    .map((r) => ({ finding_id: r.finding_id, errors: r.errors }));
  const unrecognized = unrecognizedRecords
    .map((r) => ({ finding_id: r.finding_id, status: r.status }))
    .sort((a, b) => byFindingIdAscending(a.finding_id, b.finding_id));

  const bySeverity = zeroCounts(SEVERITIES);
  const byScopeRelation = zeroCounts(SCOPE_RELATIONS);
  const byEvidence = zeroCounts(EVIDENCE_LEVELS);
  for (const r of normalized) {
    // ここへ到達する record は status === 'normalized'（= 一度は validateAndNormalizeFinding を
    // 通過済み）なので、値が既知集合に無いのは artifact が事後に手で改変された場合に限る。
    // その場合も `bySeverity[...]='...'` のような未知キーへのブラケット代入はせず
    // （INVARIANTS.md #11）、単にそのバケツへ加算しない（fail-loud にはしない — 既に
    // unrecognized 等で「artifact がおかしい」ことは別途表面化できるため、ここでは黙って
    // 二重計上・汚染をしないことだけを保証する）。
    if (Object.hasOwn(bySeverity, r.finding.severity)) bySeverity[r.finding.severity] += 1;
    if (Object.hasOwn(byScopeRelation, r.finding.scope_relation)) {
      byScopeRelation[r.finding.scope_relation] += 1;
    }
    if (Object.hasOwn(byEvidence, r.finding.evidence)) byEvidence[r.finding.evidence] += 1;
  }

  const actionableCanonical = canonicalFindings.filter((c) => c.actionable);
  // 「各レビュアーの出現」を数える——ただし、その観点自身の評価が独立にactionableだった
  // 場合だけを数える（cluster全体のactionable判定〔1件でもactionableなmemberがあればtrue〕を
  // 使うと、非actionableな評価しか出していない観点にまでvalidMedPlusが誤って計上される。
  // review-spec 所見1で実証）。
  const validMedPlus = canonicalFindings.reduce((sum, c) => sum + c.actionableReporters.length, 0);
  const duplicateClusterParticipation = canonicalFindings
    .filter((c) => c.reportedBy.length > 1)
    .reduce((sum, c) => sum + c.reportedBy.length, 0);

  return {
    canonicalFindings,
    candidateGroups,
    invalid,
    unrecognized,
    counts: {
      totalIngested: records.length,
      normalized: normalized.length,
      invalid: invalidRecords.length,
      unrecognized: unrecognized.length,
      canonical: canonicalFindings.length,
      exactDuplicates: normalized.length - canonicalFindings.length,
      actionable: actionableCanonical.length,
      validMedPlus,
      duplicateClusterParticipation,
      bySeverity,
      byScopeRelation,
      byEvidence,
      candidateGroupCount: candidateGroups.length,
    },
  };
}
