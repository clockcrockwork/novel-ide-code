// レビュー起動・routing・retrospective の計測。
//
// 目的: レビュー実行の共通化・モード分離・Phase 5 semantic routing で、本当にレビューコストが
// 下がったか・品質が落ちていないかを後から評価できるようにする。**独自の計測基盤は作らない** —
// orchestrator / 既存 runtime がすでに持つ値を JSONL へ追記し、集計するだけに留める。
//
// 出力: `$(git rev-parse --git-path agent-review)/metrics.jsonl`

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ANGLE_TOKENS, CONDITIONAL_ANGLE_TOKENS } from './review-angle-tokens.js';
import { REVIEW_MODES } from './review-exec-config.js';
import { RUN_STATUS_VALUES } from './review-plan.js';
import { reviewRoot, snapshotById } from './review-snapshot.js';
import { SHADOW_FAILURE_REASONS, SHADOW_FILE } from './shadow-routing.js';

const METRICS_FILE = 'metrics.jsonl';
const ACTUAL_PLAN_FILE = 'review-plan.json';
const ROUTING_AUTHORITIES = new Set(['shadow', 'authority']);
// shadow-routing.js を一度も実行していない（shadow-routing.json 自体が無い）ことを表す reason。
// shadow-routing.js 自身が出す reason ではない（そちらは「実行して失敗した」内訳）ため
// SHADOW_FAILURE_REASONS には含めず、ここを正本にする。
const SHADOW_NOT_ASSESSED_REASON = 'shadow-not-assessed';
// shadow-routing.js の SHADOW_FAILURE_REASONS が正本。ここでは「実際に *assessment* が得られたが
// 無効だった」reason だけを invalid とし、それ以外（ファイル自体が無い/読めない/JSON として壊れて
// いる＝assessment を得られなかった）は error とする。将来 shadow-routing.js に reason が増えても
// 未知の値は安全側（error）へ落ちる（敵対的レビュー所見: 2値ハードコードのドリフト）。
const INVALID_ASSESSMENT_REASONS = new Set([
  SHADOW_FAILURE_REASONS.INVALID_ASSESSMENT,
  SHADOW_FAILURE_REASONS.STALE_SNAPSHOT,
]);
// review-plan.js の ROUTING_FALLBACK_REASONS（'missing'/'invalid'/'stale'/'error'）を
// invalid/error の2値へ畳むときの分類。shadow 自身は valid: true を返したが plan
// （resolveRoutingAuthority/buildPlan の追加検証）が fallback したケースで
// assessmentFailureReason が null のときだけ使う（下記 summarize 参照）。
// INVALID_ASSESSMENT_REASONS と同じ二分法: 'stale' は assessment 自体は得られている
// （STALE_SNAPSHOT と同じ扱い）ため invalid、'missing'/'error' はそもそも得られなかったため
// error のまま（安全側デフォルト）。
const INVALID_PLAN_FALLBACK_REASONS = new Set(['invalid', 'stale']);
// status の閉じた語彙（docs/agent-workflows/review-angles/README.md「計測」の complete/incomplete/error
// と一致させる）。ここを検証しないと綴り違いの status が incomplete/error のどちらにも計上されず
// 黙って invocations 数だけに残る（敵対的レビュー所見）。
// review-plan.js の RUN_STATUS_VALUES が正本（起動記録とここで受理集合を共有する）。
const STATUS_VALUES = new Set(RUN_STATUS_VALUES);

export const MISS_TYPES = ['routing', 'detection', 'aggregation', 'machine'];
const MISS_TYPE_SET = new Set(MISS_TYPES);
export const ESCALATION_SOURCES = ['other', 'routing-miss'];
const ESCALATION_SOURCE_SET = new Set(ESCALATION_SOURCES);

// 取得可能: orchestrator が起動時・完了時・裁定時に確定できる値のみ。
export const OBTAINABLE_METRICS = [
  'snapshotId',
  'angle',
  'mode',
  'fresh',
  'model',
  'effort',
  'maxTurns',
  'status', // complete | incomplete | error（incomplete = maxTurns 到達等の未完了）
  'durationMs', // 親セッションが起動→完了で計測する壁時計時間
  'newFindings',
  'confirmedFindings',
  'externalFindings',
  'validMedPlus',
  'uniqueValidMedPlus',
  'duplicateClusterParticipation',
  'falsePositives',
  'escalation',
];

// 取得不能: Claude Code はサブエージェントの内訳（トークン・turn・tool call）を
// 親セッションへ返さない。これらを取るための独自計測基盤は追加しない（非目的）。
// turn 数の近似としては maxTurns 到達の有無（status='incomplete'）のみが観測できる。
export const UNOBTAINABLE_METRICS = {
  tokens: 'サブエージェントのトークン消費は親セッションへ返らない',
  turns: 'turn 数は返らない。近似指標は status=incomplete（maxTurns 到達）の有無のみ',
  toolCalls: 'tool call 数は返らない',
};

export function metricsFile(cwd = process.cwd()) {
  return join(reviewRoot(cwd), METRICS_FILE);
}

function appendRow(row, cwd) {
  const root = reviewRoot(cwd);
  mkdirSync(root, { recursive: true });
  const complete = { at: new Date().toISOString(), ...row };
  appendFileSync(join(root, METRICS_FILE), `${JSON.stringify(complete)}\n`);
  return complete;
}

// review-plan.js の assertKnownAngle と同じ方式（Object.hasOwn）で検証する。`in` はプロトタイプ鎖
// キー（__proto__ / constructor / toString 等）まで真を返すため、ANGLE_TOKENS が素のオブジェクト
// リテラルである以上、素朴な `in` 検証では既知観点を騙る未知入力を通してしまう（減算レビュー所見）。
function isKnownAngle(angle) {
  return Object.hasOwn(ANGLE_TOKENS, angle) || Object.hasOwn(CONDITIONAL_ANGLE_TOKENS, angle);
}

export function record(entry, cwd = process.cwd()) {
  if (entry.angle && !isKnownAngle(entry.angle)) {
    throw new Error(`未知の観点です: ${entry.angle}`);
  }
  // review-plan.js の assertKnownAngle と同じ Object.hasOwn 方式（敵対的レビュー所見: angle は
  // 硬化済みだったが、同じ関数内の mode 検証だけ `in` 相当の素朴なブラケット判定が残っていた）。
  if (entry.mode && !Object.hasOwn(REVIEW_MODES, entry.mode)) {
    throw new Error(`未知のレビューモードです: ${entry.mode}`);
  }
  if (entry.status !== undefined && !STATUS_VALUES.has(entry.status)) {
    throw new Error(`未知の status です: ${entry.status}（${[...STATUS_VALUES].join(' / ')}）`);
  }
  const row = { event: 'invocation' };
  for (const key of OBTAINABLE_METRICS) {
    if (entry[key] !== undefined) row[key] = entry[key];
  }
  return appendRow(row, cwd);
}

function readJson(file, label) {
  if (!existsSync(file)) throw new Error(`${label} がありません: ${file}`);
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch (err) {
    throw new Error(`${label} を JSON として読めません: ${err.message}`, { cause: err });
  }
}

// review:plan の resolveRoutingAuthority（review-plan.js）は shadow-routing.json の読み取り不能・
// 不正 JSON・snapshotId 不一致のいずれでも fallback として扱い、planCommand は必ず成功する
// （§3.5-7,8,9・§14 Q）。record-routing がここで readJson の fail-loud に任せると、まさにこの
// 3失敗モードの観測（それが起きた頻度を可視化するのが §15.3/§15.5 の目的）で record-routing 自体が
// crash し、review-plan.json 側には正しく残っているはずの routingFallbackReason 行が metrics に
// 一切現れない（外部レビュー Codex 指摘 P2）。ファイル不在（既存の分岐）と同じ思想で、
// 読み取り不能・不正 JSON・stale のそれぞれを SHADOW_FAILURE_REASONS の対応する reason を持つ
// 合成の shadow failure object へ変換し、actual 側の記録を継続する（決して throw しない）。
function readShadowFile(shadowFile, snapshotId) {
  const fail = (reason) => ({
    snapshotId,
    valid: false,
    shadowFailure: { reason },
    selection: null,
  });
  let raw;
  try {
    raw = readFileSync(shadowFile, 'utf-8');
  } catch {
    return fail(SHADOW_FAILURE_REASONS.UNREADABLE_ASSESSMENT_FILE);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail(SHADOW_FAILURE_REASONS.INVALID_ASSESSMENT_JSON);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail(SHADOW_FAILURE_REASONS.INVALID_ASSESSMENT_JSON);
  }
  if (parsed.snapshotId !== snapshotId) {
    return fail(SHADOW_FAILURE_REASONS.STALE_SNAPSHOT);
  }
  return parsed;
}

function unique(values) {
  return [...new Set(values)];
}

function difference(left, right) {
  const other = new Set(right);
  return left.filter((value) => !other.has(value));
}

function actualRouting(plan) {
  if (!Array.isArray(plan.entries))
    throw new Error('review-plan.json の entries が配列ではありません');
  const selected = unique(
    plan.entries.map((entry) => entry.angle).filter((angle) => typeof angle === 'string'),
  );
  return {
    angles: selected.filter((angle) => Object.hasOwn(ANGLE_TOKENS, angle)),
    conditionalAngles: selected.filter((angle) => Object.hasOwn(CONDITIONAL_ANGLE_TOKENS, angle)),
  };
}

// Phase 5 plan §3.5-8 / §15.4: authority mode で assessment が missing/invalid/error/stale の
// ときは常に凍結済み legacyReviewContract への fallback が発生し、「fallback しなかった authority
// mode の invalid/error」という状態はプラン上存在しない。したがって fallback は独立入力（CLI
// フラグ）ではなく authority × valid から一意に導出する（敵対的レビュー所見: 従来は --fallback の
// 付け忘れ／付け過ぎで fallback 率を自由に操作できた）。invalid/error の分類自体は
// assessmentFailureReason に残るため、authority mode でも失敗理由の粒度は失わない。
//
// **`plan.routingAuthority` が存在する場合はそれを正とし、`shadow.valid` だけでは判定しない**
// （敵対的レビュー所見 F4）。`resolveRoutingAuthority`/`buildPlan` は shadow 自身の `valid` 判定
// より**厳格な**追加検証（空集合フロア・ANGLE_TOKENS/KNOWN_SIDECARS 閉じた語彙外拒否）を課すため、
// `shadow.valid === true` でも plan が実際には fallback しているケースが存在する。この場合
// `shadow.valid` だけを見ると誤って `valid` に計上され、authority switch の安全監視
// （fallback 率）が過少計上される。
function assessmentOutcome(shadow, plan, { authority }) {
  if (Object.hasOwn(plan, 'routingAuthority')) {
    return plan.routingAuthority === 'authority' ? 'valid' : 'fallback';
  }
  if (shadow.valid === true) return 'valid';
  if (authority === 'authority') return 'fallback';
  const reason = shadow.shadowFailure?.reason;
  return INVALID_ASSESSMENT_REASONS.has(reason) ? 'invalid' : 'error';
}

/**
 * snapshot 内の actual `review-plan.json` と shadow `shadow-routing.json` を読み、Phase 5 §15.3 の
 * routing 観測 row を作る。state を二重保存せず、既存 artifact の事実を射影するだけ。
 */
export function recordRoutingObservation({ snapshotId, authority = null }, cwd = process.cwd()) {
  if (typeof snapshotId !== 'string' || snapshotId === '') {
    throw new Error('record-routing には --snapshot が必須です');
  }
  const snap = snapshotById(cwd, snapshotId);
  const plan = readJson(join(snap.dir, ACTUAL_PLAN_FILE), ACTUAL_PLAN_FILE);
  // Phase 5 §15.4 authority switch: `--authority` の明示指定を優先しつつ、省略時は
  // review-plan.json 自身に `routingAuthority` フィールドが**存在するか**で自動判定する。
  //
  // **`plan.routingAuthority` の値（'authority' / 'fallback'）をそのまま流用しない。**
  // この2値は review-plan.js 側の語彙で「この plan 自身が authority selection を採用したか
  // legacyReviewContract へ fallback したか」という**個別 plan の結果**を表す。
  // 一方 review-metrics.js の authority（'shadow' / 'authority'）は「buildPlan が authority
  // routing を試みるコードだったか」という**era**を表す別の軸 — authority switch 後の
  // plan は、fallback した場合でも「authority 対応コードで生成された」ことに変わりはなく、
  // era としては引き続き 'authority' である（era を 'fallback' 側の値に引きずられて
  // 'shadow' へ誤判定すると、assessmentOutcome の authority-mode 分岐が発火せず、
  // 本来 fallback として計上すべき観測が shadow の invalid/error 側へ混入する）。
  // フィールドの**有無**だけを見る（switch 前の review-plan.json にはこのフィールド自体が無い）。
  const resolvedAuthority = authority ?? (Object.hasOwn(plan, 'routingAuthority') ? 'authority' : 'shadow');
  if (!ROUTING_AUTHORITIES.has(resolvedAuthority)) {
    throw new Error(`未知の routing authority です: ${resolvedAuthority}`);
  }
  // §13 の angle activation rate / withheld recheck count は review-plan.json だけから
  // 導出できる actual 側の指標であり、shadow assess（npm run review:shadow）を一度も
  // 実行していない snapshot でも記録できるべきである。shadow-routing.json の不在を
  // readJson の fail-loud に任せると、shadow を回さなかっただけで actual 側の指標まで
  // 記録不能になる（仕様レビュー所見 F-2）。ファイルが無い場合は「shadow を評価しなかった」
  // という shadow failure（他の shadow 失敗と同じく shadow* フィールドが null になる）として
  // 扱い、actual 側の記録は継続する。
  const shadowFile = join(snap.dir, SHADOW_FILE);
  const shadow = existsSync(shadowFile)
    ? readShadowFile(shadowFile, snapshotId)
    : {
        snapshotId,
        valid: false,
        shadowFailure: { reason: SHADOW_NOT_ASSESSED_REASON },
        selection: null,
      };
  if (plan.snapshotId !== snapshotId) {
    throw new Error(
      `review-plan.json の snapshotId が一致しません: ${plan.snapshotId} / ${snapshotId}`,
    );
  }
  // shadow.snapshotId は readShadowFile が常に snapshotId と一致させて返す（不一致は
  // STALE_SNAPSHOT failure へ変換済み）ため、ここでの再検証は不要。

  const actual = actualRouting(plan);
  const outcome = assessmentOutcome(shadow, plan, { authority: resolvedAuthority });
  const shadowSelectedAngles =
    shadow.valid === true ? unique(shadow.selection?.selectedAngles ?? []) : null;
  const shadowEscalatedAngles =
    shadow.valid === true ? unique(shadow.selection?.escalatedAngles ?? []) : null;
  // explicit escalation は semantic selection を減算できない overlay。actual と比較する shadow の
  // 実効 routing は selectedAngles ∪ escalatedAngles でなければならない。
  const shadowAngles =
    shadowSelectedAngles === null
      ? null
      : unique([...shadowSelectedAngles, ...(shadowEscalatedAngles ?? [])]);
  const shadowConditionalAngles =
    shadow.valid === true ? unique(shadow.selection?.conditionalAngles ?? []) : null;
  const shadowSidecars =
    shadow.valid === true ? unique(shadow.selection?.selectedSidecars ?? []) : null;
  const explicitEscalationSeqs = unique(
    (Array.isArray(plan.escalations) ? plan.escalations : [])
      .filter((entry) => entry?.kind === 'manual-escalation' && Number.isInteger(entry.seq))
      .map((entry) => entry.seq),
  );
  const withheldAngles = unique(
    plan.entries
      .filter((entry) => entry?.budgetOutcome === 'exhausted')
      .map((entry) => entry.angle)
      .filter((angle) => typeof angle === 'string'),
  );

  return appendRow(
    {
      event: 'routing',
      snapshotId,
      routingAuthority: resolvedAuthority,
      assessmentOutcome: outcome,
      assessmentFailureReason: shadow.shadowFailure?.reason ?? null,
      // shadow 自身は valid でも plan（resolveRoutingAuthority/buildPlan の追加検証）が
      // fallback した場合、shadow 側の失敗理由（上記）は null のまま理由が失われる。
      // plan 自身が記録した理由（review-plan.js の ROUTING_FALLBACK_REASONS 語彙。shadow の
      // SHADOW_FAILURE_REASONS とは別の閉じた語彙のため、既存の assessmentFailureReason /
      // fallbackReasonBreakdown の集計へは混ぜず独立フィールドとして残す）
      planRoutingFallbackReason: plan.routingFallbackReason ?? null,
      actualAngles: actual.angles,
      actualConditionalAngles: actual.conditionalAngles,
      shadowSelectedAngles,
      shadowEscalatedAngles,
      shadowAngles,
      shadowConditionalAngles,
      shadowSidecars,
      shadowOnlyAngles: shadowAngles === null ? null : difference(shadowAngles, actual.angles),
      actualOnlyAngles: shadowAngles === null ? null : difference(actual.angles, shadowAngles),
      shadowOnlyConditionalAngles:
        shadowConditionalAngles === null
          ? null
          : difference(shadowConditionalAngles, actual.conditionalAngles),
      actualOnlyConditionalAngles:
        shadowConditionalAngles === null
          ? null
          : difference(actual.conditionalAngles, shadowConditionalAngles),
      explicitEscalationSeqs,
      withheldAngles,
    },
    cwd,
  );
}

/**
 * retrospective で確定した miss taxonomy を記録する。miss の存在・分類は machine が推測せず、
 * orchestrator / 人間が裁定した結果だけを渡す。
 */
export function recordMiss({ snapshotId, missType, target }, cwd = process.cwd()) {
  if (typeof snapshotId !== 'string' || snapshotId === '') {
    throw new Error('record-miss には --snapshot が必須です');
  }
  if (!MISS_TYPE_SET.has(missType)) {
    throw new Error(`未知の miss taxonomy です: ${missType}（${MISS_TYPES.join(' / ')}）`);
  }
  if (typeof target !== 'string' || target.trim() === '') {
    throw new Error('record-miss には --target が必須です');
  }
  // record-routing と同じく実在する snapshot だけを受理する（敵対的レビュー所見: 検証が無いと
  // 存在しない snapshotId へいくらでも miss / escalation を積み、miss taxonomy と無関係に
  // routingMissEscalations だけが増える矛盾した集計を作れる）。入力形状の検証を済ませてから
  // 最後にディスクを見る（typo 系の CLI エラーを snapshot 未検出より先に返す）。
  snapshotById(cwd, snapshotId);
  // (snapshotId, missType, target) が同一の miss は、曖昧な CLI 失敗後の再実行（運用性レビュー
  // 所見2）と、同じ系統を指す2件目以降の**別々の**実 escaped finding（仕様レビュー所見N-2）の
  // どちらもあり得り、machine 側には両者を区別する情報が無い。黙って no-op にすると後者を
  // 恒久的に過小計上し、常に append すると前者で過大計上する。**どちらの方向にも黙って倒さず、
  // 常に append したうえで疑わしい行に印を付ける**（`possibleDuplicate`）。件数は常に正しく残り、
  // report は重複の疑いがある件数を別枠で見せるので、人間が retrospective の実態と突き合わせて
  // 判断できる。
  const isPossibleDuplicate = readAll(cwd).some(
    (row) =>
      row.event === 'miss' &&
      row.snapshotId === snapshotId &&
      row.missType === missType &&
      row.target === target,
  );
  const row = { event: 'miss', snapshotId, missType, target };
  if (isPossibleDuplicate) row.possibleDuplicate = true;
  return appendRow(row, cwd);
}

/**
 * `review-plan.js escalate` に対応する**明示的な**追加budget割当を1イベントとして記録する。
 * legacy Tier再分類や単なる escalated invocation はここへ混ぜない。
 */
export function recordExplicitEscalation(
  { snapshotId, angles, source = 'other' },
  cwd = process.cwd(),
) {
  if (typeof snapshotId !== 'string' || snapshotId === '') {
    throw new Error('record-escalation には --snapshot が必須です');
  }
  const targets = unique(
    (angles ?? [])
      .filter((angle) => typeof angle === 'string')
      .map((angle) => angle.trim())
      .filter(Boolean),
  );
  if (targets.length === 0) throw new Error('record-escalation には --angles が必須です');
  // review-plan.js escalate の assertKnownAngle と同じ閉じた語彙（通常7系統＋memory）で検証する。
  // ここを開いたままにすると、typo や存在しない系統名がそのまま explicit escalation として
  // metrics へ入り、escalatedAngles の provenance と食い違う集計になる。
  for (const angle of targets) {
    if (!isKnownAngle(angle)) throw new Error(`未知の観点です: ${angle}`);
  }
  if (!ESCALATION_SOURCE_SET.has(source)) {
    throw new Error(
      `未知の escalation source です: ${source}（${ESCALATION_SOURCES.join(' / ')}）`,
    );
  }
  // record-miss と同じく、入力形状の検証を済ませてから最後に実在 snapshot を要求する
  // （敵対的レビュー所見: 存在しない snapshotId への無制限記録を防ぐ）。
  snapshotById(cwd, snapshotId);
  // recordMiss と同じ理由（仕様レビュー所見N-2）: 同一 (snapshotId, angles集合, source) の
  // 再記録は「曖昧な失敗後の再実行」と「同じ系統への2件目以降の別の explicit escalation」の
  // どちらもあり得るため、黙って no-op にせず常に append し、疑わしい行にだけ印を付ける。
  const targetSet = new Set(targets);
  const isPossibleDuplicate = readAll(cwd).some(
    (row) =>
      row.event === 'explicit-escalation' &&
      row.snapshotId === snapshotId &&
      row.escalationSource === source &&
      Array.isArray(row.angles) &&
      row.angles.length === targetSet.size &&
      row.angles.every((a) => targetSet.has(a)),
  );
  const row = {
    event: 'explicit-escalation',
    snapshotId,
    angles: targets,
    escalationSource: source,
  };
  if (isPossibleDuplicate) row.possibleDuplicate = true;
  return appendRow(row, cwd);
}

export function readAll(cwd = process.cwd()) {
  const file = metricsFile(cwd);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function zeroAssessmentCounts() {
  return { valid: 0, invalid: 0, error: 0, fallback: 0 };
}

// review-plan.json / shadow-routing.json は同一 snapshot に対して in-place で上書きされ得る
// （例: escalate 後に review:plan を取り直さず同じ snapshot のまま再度 record-routing する）ため、
// 同一 (snapshotId, routingAuthority) を複数回記録した行が同じ PR の同じ観測を重複計上し、
// activation rate 等を無意味な値へ歪める（敵対的レビュー所見）。集計は「その (snapshot, authority)
// の最新行」だけを使う — 生の行自体は metrics.jsonl に監査用として残り、捨てない。
function latestRoutingObservationPerSnapshot(routingRows) {
  const latest = new Map();
  for (const row of routingRows) {
    const authority = ROUTING_AUTHORITIES.has(row.routingAuthority)
      ? row.routingAuthority
      : 'shadow';
    latest.set(`${row.snapshotId}:${authority}`, row);
  }
  return [...latest.values()];
}

export function summarize(rows) {
  const invocations = rows.filter((row) => (row.event ?? 'invocation') === 'invocation');
  const routingRows = latestRoutingObservationPerSnapshot(
    rows.filter((row) => row.event === 'routing'),
  );
  const missRows = rows.filter((row) => row.event === 'miss');
  const escalationRows = rows.filter((row) => row.event === 'explicit-escalation');
  const byAngle = Object.create(null);
  let fresh = 0;
  let cont = 0;
  let incomplete = 0;
  let errors = 0;
  let durationMs = 0;
  let newFindings = 0;
  let confirmed = 0;
  let external = 0;
  let validMedPlus = 0;
  let uniqueValidMedPlus = 0;
  let duplicateClusterParticipation = 0;
  let falsePositives = 0;
  const byMode = Object.create(null);
  for (const m of Object.keys(REVIEW_MODES)) byMode[m] = 0;
  for (const r of invocations) {
    if (r.angle) byAngle[r.angle] = (byAngle[r.angle] ?? 0) + 1;
    if (r.mode) byMode[r.mode] = (byMode[r.mode] ?? 0) + 1;
    if (r.fresh === true) fresh += 1;
    if (r.fresh === false) cont += 1;
    if (r.status === 'incomplete') incomplete += 1;
    if (r.status === 'error') errors += 1;
    durationMs += r.durationMs ?? 0;
    newFindings += r.newFindings ?? 0;
    confirmed += r.confirmedFindings ?? 0;
    external += r.externalFindings ?? 0;
    validMedPlus += r.validMedPlus ?? 0;
    uniqueValidMedPlus += r.uniqueValidMedPlus ?? 0;
    duplicateClusterParticipation += r.duplicateClusterParticipation ?? 0;
    falsePositives += r.falsePositives ?? 0;
  }

  const assessment = { shadow: zeroAssessmentCounts(), authority: zeroAssessmentCounts() };
  // authority mode の失敗は §3.5-8 により常に `fallback` へ畳まれるため、assessment.authority
  // だけを見ると invalid（モデル起因）と error（ファイル欠落・破損等の工程起因）の内訳が消える。
  // assessmentFailureReason（行には残っている）から shadow と同じ分類ロジックで内訳を別途
  // 集計し、`fallback = N` の内側で何が起きているかを report から復元できるようにする
  // （敵対的レビュー所見 N1: fallback へ畳んだ結果 invalid/error が恒久的に0と誤読される）。
  const fallbackReasonBreakdown = { invalid: 0, error: 0 };
  // 「shadow を評価しなかった」（review:shadow 未実行）は classifier の不健全さとは無関係だが、
  // assessmentOutcome では他の error/fallback 系 reason と同じバケツに畳まれる。§14.1/§15.5 が
  // 「invalid/error/fallback が頻発していないか」で authority switch の可否・classifier の
  // 健全性を判断する材料にする以上、「未実施」を「判定に失敗した」と混同できない
  // （仕様レビュー所見 N-1）。fallbackReasonBreakdown と同じ思想で内訳を別集計するが、
  // shadow-not-assessed は authority mode でも起きうる（その場合 outcome は fallback で
  // authority 側に計上される）ため、assessment と同じく shadow/authority 別に数える
  // （仕様レビュー所見 N-3: mode を跨いで合算すると shadow 行の内訳が algebraically 破綻する）。
  const shadowNotAssessed = { shadow: 0, authority: 0 };
  const actualActivation = Object.create(null);
  const shadowActivation = Object.create(null);
  const withheldRechecks = new Set();
  let routingDiffs = 0;
  let validShadowRoutingObservations = 0;
  for (const r of routingRows) {
    const authority = ROUTING_AUTHORITIES.has(r.routingAuthority) ? r.routingAuthority : 'shadow';
    if (Object.hasOwn(assessment[authority], r.assessmentOutcome)) {
      assessment[authority][r.assessmentOutcome] += 1;
    }
    if (r.assessmentFailureReason === SHADOW_NOT_ASSESSED_REASON) shadowNotAssessed[authority] += 1;
    if (authority === 'authority' && r.assessmentOutcome === 'fallback') {
      // shadow 自身が失敗理由を記録している場合はそれを正とする。shadow が valid: true を
      // 返したが plan 自身（resolveRoutingAuthority/buildPlan の追加検証: 空集合フロア・
      // ANGLE_TOKENS/KNOWN_SIDECARS 閉じた語彙外拒否）が fallback した場合は
      // assessmentFailureReason が null のまま残るため、その場合だけ planRoutingFallbackReason
      // から内訳を復元する（敵対的レビュー2周目 F-A3: 参照されず恒久的に error 側へ計上されて
      // いた——空集合フロア・閉じた語彙外拒否は本 PR が新設した最もモデル起因な失敗経路である
      // にもかかわらず、工程起因の error として水増しされていた）。
      const kind =
        r.assessmentFailureReason != null
          ? INVALID_ASSESSMENT_REASONS.has(r.assessmentFailureReason)
            ? 'invalid'
            : 'error'
          : INVALID_PLAN_FALLBACK_REASONS.has(r.planRoutingFallbackReason)
            ? 'invalid'
            : 'error';
      fallbackReasonBreakdown[kind] += 1;
    }
    for (const angle of r.actualAngles ?? []) {
      actualActivation[angle] = (actualActivation[angle] ?? 0) + 1;
    }
    if (Array.isArray(r.shadowAngles)) validShadowRoutingObservations += 1;
    for (const angle of r.shadowAngles ?? []) {
      shadowActivation[angle] = (shadowActivation[angle] ?? 0) + 1;
    }
    // shadow selection は、まだ actual registry（ANGLE_TOKENS）に登録していない machine ID
    // （§15.1「shadow中にFull等の実必須集合を変えない」の期間中の angle）を持ちうる。
    // 未登録 angle は原理的に actual entries 側へ現れようがないため shadowOnlyAngles へ恒常的に
    // 現れる（設計上の意図であって欠陥ではない）。これを毎回「差分」として1カウントすると、
    // 該当 PR の大半で routingDiffs が飽和し「shadow と actual が一致した」を表現できなくなる
    // （敵対的レビュー所見7）。差分判定は actual registry に存在しうる angle だけに絞る。
    // shadowOnlyAngles 自体（未登録 angle を含む全量）は行にそのまま残るので監査情報は失わない。
    // **testquality は Phase 5 §15.4 authority switch で ANGLE_TOKENS へ登録済み** — この時点以降、
    // testquality の shadow-only 出現は他の登録済み angle と同じく正規の routingDiffs 対象になる
    // （authority mode が selected したのに actual entries に現れない、という実際の routing miss を
    // 隠さないため）。
    const comparableShadowOnly = (r.shadowOnlyAngles ?? []).filter((angle) =>
      Object.hasOwn(ANGLE_TOKENS, angle),
    );
    const hasDiff =
      comparableShadowOnly.length > 0 ||
      (r.actualOnlyAngles?.length ?? 0) > 0 ||
      (r.shadowOnlyConditionalAngles?.length ?? 0) > 0 ||
      (r.actualOnlyConditionalAngles?.length ?? 0) > 0;
    if (hasDiff) routingDiffs += 1;
    for (const angle of r.withheldAngles ?? []) withheldRechecks.add(`${r.snapshotId}:${angle}`);
  }

  const misses = Object.fromEntries(MISS_TYPES.map((type) => [type, 0]));
  for (const r of missRows) {
    if (MISS_TYPE_SET.has(r.missType)) misses[r.missType] += 1;
  }
  const routingMissEscalations = escalationRows.filter(
    (row) => row.escalationSource === 'routing-miss',
  ).length;
  // 常に append する代わりに付けた印（仕様レビュー所見N-2）を可視化する。件数そのものは
  // 減らさず、人間が retrospective の実態と突き合わせて判断するための別枠。
  const possibleDuplicateMisses = missRows.filter((r) => r.possibleDuplicate === true).length;
  const possibleDuplicateEscalations = escalationRows.filter(
    (r) => r.possibleDuplicate === true,
  ).length;

  const rate = (counts, denominator) =>
    Object.fromEntries(
      Object.entries(counts).map(([angle, count]) => [
        angle,
        denominator === 0 ? 0 : count / denominator,
      ]),
    );

  return {
    invocations: invocations.length,
    byAngle,
    byMode,
    fresh,
    continued: cont,
    incomplete,
    errors,
    durationMs,
    newFindings,
    confirmedFindings: confirmed,
    externalFindings: external,
    externalEscapedFindings: missRows.length,
    validMedPlus,
    uniqueValidMedPlus,
    duplicateClusterParticipation,
    falsePositives,
    escalations: invocations.filter((r) => r.escalation).length,
    routingObservations: routingRows.length,
    routingDiffs,
    actualActivation,
    shadowActivation,
    actualActivationRate: rate(actualActivation, routingRows.length),
    shadowActivationRate: rate(shadowActivation, validShadowRoutingObservations),
    assessment,
    fallbackReasonBreakdown,
    shadowNotAssessed,
    explicitEscalations: escalationRows.length,
    withheldRechecks: withheldRechecks.size,
    misses,
    routingMissEscalations,
    possibleDuplicateMisses,
    possibleDuplicateEscalations,
  };
}

function formatRates(rates) {
  return (
    Object.entries(rates)
      .map(([key, value]) => `${key} ${(value * 100).toFixed(0)}%`)
      .join(' / ') || '(なし)'
  );
}

function formatCounts(counts) {
  return Object.entries(counts)
    .map(([key, value]) => `${key} ${value}`)
    .join(' / ');
}

export function formatSummary(s) {
  const lines = [];
  lines.push(`レビュアー起動数: ${s.invocations}（fresh ${s.fresh} / 継続 ${s.continued}）`);
  lines.push(
    `モード別: ${Object.entries(s.byMode)
      .map(([k, v]) => `${REVIEW_MODES[k]?.label ?? k} ${v}`)
      .join(' / ')}`,
  );
  lines.push(
    `観点別: ${
      Object.entries(s.byAngle)
        .map(
          ([k, v]) => `${ANGLE_TOKENS[k]?.label ?? CONDITIONAL_ANGLE_TOKENS[k]?.label ?? k} ${v}`,
        )
        .join(' / ') || '(なし)'
    }`,
  );
  lines.push(
    `所見: 新規 ${s.newFindings} / 既出確認 ${s.confirmedFindings} / 外部新規 ${s.externalFindings}`,
  );
  lines.push(
    `裁定: valid Med+ ${s.validMedPlus} / unique valid Med+ ${s.uniqueValidMedPlus} / duplicate cluster participation ${s.duplicateClusterParticipation} / false positive ${s.falsePositives} / external escaped ${s.externalEscapedFindings}`,
  );
  lines.push(`未完了: ${s.incomplete} / error: ${s.errors}`);
  // Phase 5 以前からの互換指標。record --escalation の legacy フラグ集計であり、
  // §13 の explicit escalation（record-escalation event）とは別物（仕様レビュー所見F-3:
  // このPRで出力行が誤って落ちていた。集計自体は summarize() に残っていた）。
  lines.push(`Tier エスカレーション: ${s.escalations}`);
  lines.push(
    `routing: 観測 ${s.routingObservations} / shadow-vs-actual 差分あり ${s.routingDiffs} / explicit escalation ${s.explicitEscalations} / withheld recheck ${s.withheldRechecks}`,
  );
  lines.push(
    `assessment(shadow): ${formatCounts(s.assessment.shadow)}（うち review:shadow 未実行 ${s.shadowNotAssessed.shadow}）`,
  );
  lines.push(
    `assessment(authority): ${formatCounts(s.assessment.authority)}（fallback内訳: ${formatCounts(s.fallbackReasonBreakdown)} / うち review:shadow 未実行 ${s.shadowNotAssessed.authority}）`,
  );
  lines.push(
    `miss taxonomy: ${formatCounts(s.misses)} / routing miss後escalation ${s.routingMissEscalations} / 重複疑いmiss ${s.possibleDuplicateMisses} / 重複疑いescalation ${s.possibleDuplicateEscalations}`,
  );
  lines.push(`actual activation rate: ${formatRates(s.actualActivationRate)}`);
  lines.push(`shadow activation rate: ${formatRates(s.shadowActivationRate)}`);
  lines.push(`合計実行時間: ${Math.round(s.durationMs / 1000)} 秒`);
  lines.push('');
  lines.push('取得不能な指標（独自計測基盤は追加しない）:');
  for (const [k, why] of Object.entries(UNOBTAINABLE_METRICS)) lines.push(`  - ${k}: ${why}`);
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const out = Object.create(null);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
    else {
      out[a.slice(2)] = next;
      i += 1;
    }
  }
  return out;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (cmd === 'record') {
    const num = (v) => (v === undefined ? undefined : Number.parseInt(v, 10));
    // `--status` が値なしで渡されると parseArgs は真偽値 true にする。これを黙って既定値
    // `complete` へ倒すと、maxTurns 到達等で `--status incomplete` を書こうとして値を
    // 付け忘れた呼び出しが「完了」として記録されてしまう（敵対的レビュー所見 N2）。
    // 省略（undefined）だけを complete の既定対象とし、値なしフラグは usage error にする。
    if (args.status === true) {
      throw new Error('--status には値が必要です（complete / incomplete / error）');
    }
    const row = record({
      snapshotId: typeof args.snapshot === 'string' ? args.snapshot : undefined,
      angle: typeof args.angle === 'string' ? args.angle : undefined,
      mode: typeof args.mode === 'string' ? args.mode : undefined,
      fresh:
        args.fresh === true || args.fresh === 'true'
          ? true
          : args.continue === true || args.continue === 'true'
            ? false
            : undefined,
      model: typeof args.model === 'string' ? args.model : undefined,
      effort: typeof args.effort === 'string' ? args.effort : undefined,
      maxTurns: num(args['max-turns']),
      status: typeof args.status === 'string' ? args.status : 'complete',
      durationMs: num(args['duration-ms']),
      newFindings: num(args['new-findings']),
      confirmedFindings: num(args['confirmed-findings']),
      externalFindings: num(args['external-findings']),
      validMedPlus: num(args['valid-med-plus']),
      uniqueValidMedPlus: num(args['unique-valid-med-plus']),
      duplicateClusterParticipation: num(args['duplicate-cluster-participation']),
      falsePositives: num(args['false-positives']),
      escalation: args.escalation === true || args.escalation === 'true',
    });
    process.stdout.write(`${JSON.stringify(row)}\n`);
    return;
  }
  if (cmd === 'record-routing') {
    // --status と同じクラス（運用性レビュー所見1）: 値なしフラグを意味のある既定値へ無検証で
    // 倒すと、書き忘れが誰にも気づかれないまま誤った事実として確定記録される。値なしは
    // usage error、省略（未指定）だけを既定値の対象にする。**省略時は 'shadow' へ固定せず
    // recordRoutingObservation 自身に委ねる**（Phase 5 §15.4 authority switch:
    // review-plan.json が記録した routingAuthority から自動判定する方が、switch 後は
    // 固定既定値より正確。switch 前の review-plan.json にはそのフィールドが無いため、
    // その場合のみ関数側が 'shadow' へ既定する）。
    if (args.authority === true) {
      throw new Error('--authority には値が必要です（shadow / authority）');
    }
    const row = recordRoutingObservation({
      snapshotId: typeof args.snapshot === 'string' ? args.snapshot : '',
      authority: typeof args.authority === 'string' ? args.authority : null,
    });
    process.stdout.write(`${JSON.stringify(row)}\n`);
    return;
  }
  if (cmd === 'record-miss') {
    const row = recordMiss({
      snapshotId: typeof args.snapshot === 'string' ? args.snapshot : '',
      missType: typeof args.type === 'string' ? args.type : '',
      target: typeof args.target === 'string' ? args.target : '',
    });
    process.stdout.write(`${JSON.stringify(row)}\n`);
    return;
  }
  if (cmd === 'record-escalation') {
    // 同上（運用性レビュー所見1）。--source 値なしが 'other' へ黙って倒れると、本来
    // routing-miss 起因のエスカレーションが routingMissEscalations 集計から漏れる。
    if (args.source === true) {
      throw new Error('--source には値が必要です（other / routing-miss）');
    }
    const row = recordExplicitEscalation({
      snapshotId: typeof args.snapshot === 'string' ? args.snapshot : '',
      angles: typeof args.angles === 'string' ? args.angles.split(',') : [],
      source: typeof args.source === 'string' ? args.source : 'other',
    });
    process.stdout.write(`${JSON.stringify(row)}\n`);
    return;
  }
  if (cmd === 'report') {
    process.stdout.write(formatSummary(summarize(readAll())));
    return;
  }
  process.stderr.write(
    'usage: review-metrics.js <record|record-routing|record-miss|record-escalation|report> [options]\n',
  );
  process.exit(1);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  /(^|[/\\])review-metrics\.js$/.test(process.argv[1])
) {
  main();
}
