// Per-finding verification sidecar（issue #648）。
//
// #647（structured-findings.json / structured-findings-aggregate.json）が確立した
// finder → structured finding → deterministic aggregation の**後段**に、
// 「finder 自身の evidence 自己申告（verified/strong/weak）」とは独立に、finding 単位で
// 再検証（confirmed / refuted_evidence / unresolved_concern）を記録するための責務を追加する。
//
// これは新しい review angle ではない（ANGLE_TOKENS / selectedAngles / effectiveAngles /
// TIER_ANGLES のいずれにも登録しない）。観測的・advisory な sidecar であり、verifier の
// verdict は Actionable 判定・merge blocker・severity/scope_relation/evidence の書き換えの
// いずれにもならない（docs/agent-workflows/review-finding-verification-runtime.md 参照）。
//
// 既存の snapshot ライフサイクル（review-snapshot.js の reviewRoot/snapshotById）と
// #647 の artifact（structured-findings.json）をそのまま再利用し、新しい保存領域は作らない。
// 成果物は各 snapshot 自身のディレクトリ（snap.dir）に書く。
//
// 責務の切り分け（1ファイルにまとめるが、関数単位で明確に分離する）:
//   - 対象解決 / 鮮度検証: resolveVerificationTarget
//   - 書き込み（append-only ingest log。#647 の ingest と同じ形）: recordVerification
//   - 集約（決定的。最新 accepted attempt を採用する view の導出。永続 aggregate artifact は
//     持たない — verification 量は #647 の finding ingest よりずっと小さく、都度導出で十分）:
//     deriveVerificationView
//   - report / metrics（読み取り時の鮮度再検証を含む）: formatVerificationReport /
//     buildVerificationMetrics
//   - 人間裁定の比較（最小限。新しい state machine は作らない）: recordHumanAdjudication

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { REVIEW_FINDING_CONTRACT_VERSION } from './review-finding-contract.js';
import {
  STRUCTURED_FINDINGS_FILE,
  acquireIngestLock,
  assertArtifactBinding,
  isFiniteNumber,
  readJsonIfExists,
  readJsonOrThrow,
  releaseIngestLock,
  resolveSnapshot,
  sanitizeForDisplay,
  writeJson,
} from './review-findings.js';
import { validateAndNormalizeVerification } from './review-finding-verification-normalize.js';
import { truncateForMessage, capForStorage } from './review-findings-normalize.js';
import { parseArgs } from './review-plan.js';

export const STRUCTURED_FINDINGS_VERIFICATION_FILE = 'structured-findings-verifications.json';
export const STRUCTURED_FINDINGS_VERIFICATION_SCHEMA_VERSION = 1;

// `recordVerification` が record 時に決める outcome（common REVIEW_VERIFICATION_SCHEMA の
// verdict enum とは別の語彙。novel-ide consumer envelope 側だけが持つ「schema-valid verdict に
// 到達したか」の分類: 'accepted' / 'rejected' / 'execution_error'）。critical safety invariant:
// 'accepted' 以外はどれも「finding = refuted / dismissed / non-actionable」へ自動変換されない
// （詳細・語彙の表は docs/agent-workflows/review-finding-verification-runtime.md 参照）。

// execution_error の内訳語彙。閉じた集合にして、未知の呼び出し側文字列がそのまま無検証で
// artifact へ書き込まれるのを防ぐ（review-findings.js の isKnownAngle と同じ思想）。
export const EXECUTION_ERROR_STATUSES = Object.freeze([
  'model_failure',
  'malformed_json',
  'empty_output',
  'partial_output',
  'timeout',
  'tool_failure',
  'unknown',
]);

const HUMAN_ADJUDICATIONS = Object.freeze(['valid', 'false_positive', 'uncertain']);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length >= 1;
}

// 個々の normalized finding の内容ハッシュ（finding_id は含まない — finding_id は識別子で
// あって内容ではないため。#647 の finding_id semantics「内容由来の ID にしない」と対になる
// 規約: ここでは逆に「内容のハッシュを識別子として使わない」）。normalized finding は
// validateAndNormalizeFinding が常に同じフィールド順で組み立てるため、同じ内容なら常に同じ
// 文字列になり決定的（review-findings.js の hashFindingsContent と同じ前提）。
//
// **structured-findings.json 全体のハッシュ（#647 の aggregate 鮮度チェックが使う
// sourceHash 相当）ではなく、この finding_id 1件分の内容だけをハッシュする。** 全体ハッシュを
// 鮮度検証に使うと、この finding とは無関係な別 finding が同じ snapshot へ追加 ingest される
// 度に「鮮度不一致」が生じ、通常の反復的レビュー運用（複数観点が異なるタイミングで finding を
// 追加していく）で verifier の結果が頻繁に偽陽性の stale 扱いになる。individual finding の
// 内容は ingest 後不変（#647: append-only）なので、finding 単位のダイジェストは通常運用では
// 変化せず、実際に変化するのは「手編集・破損した artifact を削除して同じ finding_id へ別内容を
// 再 ingest した」場合（#647 既知 Low residual）だけに限定できる — これは write 時
// （target→record の間）にも read 時（report/metrics）にも同じ関数で検出できる。
export function findingContentDigest(finding) {
  return createHash('sha256').update(JSON.stringify(finding)).digest('hex');
}

// structured-findings.json を1回読み、normalized finding を finding_id → finding のマップに
// する共有ヘルパー。`resolveVerificationTarget`・`formatVerificationReport`・
// `buildVerificationMetrics` の3箇所が同じ読み取り・binding 検証を重複実装しない。
function currentNormalizedFindings(snap) {
  const findingsFile = join(snap.dir, STRUCTURED_FINDINGS_FILE);
  if (!existsSync(findingsFile)) return { findingsFile, byId: new Map(), exists: false };
  const artifact = readJsonOrThrow(findingsFile, STRUCTURED_FINDINGS_FILE);
  if (!artifact || !Array.isArray(artifact.records)) {
    throw new Error(
      `${findingsFile} の形式が不正です（records が配列ではありません）。verifier の対象解決を` +
        '続けられません',
    );
  }
  assertArtifactBinding(artifact, { file: findingsFile, expectedSnapshotId: snap.snapshotId });
  const byId = new Map(
    artifact.records
      .filter((r) => r?.status === 'normalized')
      .map((r) => [r.finding_id, r.finding]),
  );
  return { findingsFile, byId, exists: true };
}

/**
 * finding_id が対象 snapshot の structured-findings.json 内で一意に・正当に解決できるかを
 * 検証する。#648 acceptance criteria: 「wrong/missing/ambiguous finding_id 拒否」
 * 「stale/wrong-snapshot verification を current として扱わない」を、verifier の入口
 * （prompt 生成 = target）と出口（record）の両方で同じロジックにより保証する。
 *
 * @returns {{snap, findingsFile, findingDigest, finding}} 一意な normalized finding が
 *   見つかった場合のみ。それ以外は fail-loud（silent orphan を作らない）。
 */
export function resolveVerificationTarget({ snapshotId = null, findingId, cwd = process.cwd() }) {
  if (!isNonEmptyString(findingId)) {
    throw new Error('--finding-id が必要です');
  }
  const snap = resolveSnapshot({ snapshotId, cwd });
  const findingsFile = join(snap.dir, STRUCTURED_FINDINGS_FILE);
  if (!existsSync(findingsFile)) {
    throw new Error(
      `${findingsFile} がありません。この snapshot にはまだ finding が ingest されていません`,
    );
  }
  const artifact = readJsonOrThrow(findingsFile, STRUCTURED_FINDINGS_FILE);
  if (!artifact || !Array.isArray(artifact.records)) {
    throw new Error(
      `${findingsFile} の形式が不正です（records が配列ではありません）。verifier の対象解決を` +
        '続けられません',
    );
  }
  // #647 と同じ binding 検証（schemaVersion/contractVersion/snapshotId）。別 snapshot から
  // コピーされた・古いコード版が生成した artifact を「現在の finding」として誤って対象解決
  // しない。
  assertArtifactBinding(artifact, { file: findingsFile, expectedSnapshotId: snap.snapshotId });

  const matches = artifact.records.filter((r) => r?.finding_id === findingId);
  if (matches.length === 0) {
    throw new Error(
      `finding_id=${JSON.stringify(findingId)} は ${STRUCTURED_FINDINGS_FILE} に存在しません` +
        '（未知の finding_id。verification を作成できません）',
    );
  }
  if (matches.length > 1) {
    // 手編集・破損による重複 finding_id（#647 既知 Low residual）。verifier はどちらの
    // record を指しているか machine には判断できないため、曖昧なまま attach しない。
    throw new Error(
      `finding_id=${JSON.stringify(findingId)} が ${STRUCTURED_FINDINGS_FILE} 内で重複しています` +
        `（${matches.length}件）。artifact が手編集・破損している可能性があります。曖昧なまま` +
        'verification を作成しません（fail-loud）。',
    );
  }
  const record = matches[0];
  if (record.status !== 'normalized') {
    throw new Error(
      `finding_id=${JSON.stringify(findingId)} は status=${JSON.stringify(record.status)}` +
        '（invalid / unrecognized）のレコードです。normalized finding のみ検証対象にできます',
    );
  }
  return {
    snap,
    findingsFile,
    // この finding_id 1件分の内容ハッシュ（finding 単位の鮮度検証。上記コメント参照）。
    findingDigest: findingContentDigest(record.finding),
    finding: record.finding,
  };
}

/**
 * verifier へ渡す prompt payload を組み立てる（`target` CLI サブコマンドの本体）。
 *
 * finder の結論をそのまま ground truth として提示しない — 「この failure_scenario が
 * 独立に成立するか再検証し、confirmed/refuted_evidence/unresolved_concern のいずれかを
 * 具体的な evidence とともに返せ」という独立検証の枠組みとして提示する（confirmation bias
 * を減らすため。issue #648「Verifier prompt contract」）。
 */
export function buildVerificationPrompt({ snapshotId = null, findingId, cwd = process.cwd() }) {
  const { snap, findingDigest, finding } = resolveVerificationTarget({
    snapshotId,
    findingId,
    cwd,
  });
  const instructions =
    'あなたは finder（元のレビュアー）とは独立した verifier です。finder の結論を正しいと' +
    '仮定してはいけません。以下の failure_scenario が本当に成立するか、コード・テスト・' +
    '実行結果・正本ドキュメントを自分で調べて独立に再検証してください。\n' +
    '- 成立を確認できたら verdict=confirmed。\n' +
    '- 成立しないという具体的な反証（premise のどれが・どの証拠で否定されるか）を得られたら' +
    ' verdict=refuted_evidence。「再現できなかった」「自信がない」だけでは refuted_evidence に' +
    ' してはいけません。\n' +
    '- 証拠不足・環境不足・ツール失敗・判断材料の矛盾・予算内で結論に到達できない場合は' +
    ' verdict=unresolved_concern。\n' +
    'severity / scope_relation / finder の evidence 自己申告を書き換えないでください。新しい' +
    ' finding を広く探索しないでください（この finding 単独の再検証のみ）。' +
    '出力は finding_id・verdict・rationale・evidence[]（各 source/locator/detail）を持つ' +
    ' JSON1件のみとし、evidence には file:line・テスト名・実行コマンドと結果・正本文書の節など' +
    ' 具体的な locator を必ず含めてください。';
  return {
    snapshotId: snap.snapshotId,
    finding_id: findingId,
    findingDigest,
    finding,
    instructions,
  };
}

function nextAttemptSeq(artifact) {
  let max = 0;
  for (const a of artifact?.attempts ?? []) {
    if (isFiniteNumber(a?.seq)) max = Math.max(max, a.seq);
  }
  return max + 1;
}

/**
 * verifier の生出力（または実行失敗）を append-only の verification ログへ記録する。
 * #647 の ingestFindings と同じ append-only ログ方式: 1回の呼び出しは1 attempt を追記する
 * だけで、既存 attempt を上書きしない（duplicate verifier result の silent last-write-wins を
 * 避けるため。`deriveVerificationView` が「最新の accepted attempt」を決定的に選ぶ）。
 *
 * 呼び出し方は2通り:
 *   - `rawResult` を渡す（verifier が JSON を返せた場合）。schema 検証・finding_id 一致・
 *     鮮度（findingDigest 一致）を全て満たせば outcome='accepted'、いずれか失敗すれば
 *     outcome='rejected' として記録する。
 *   - `executionError` を渡す（verifier 起動・実行そのものが失敗した場合。model 失敗・
 *     malformed JSON・空出力・timeout/maxTurns・tool failure 等）。outcome='execution_error'。
 *     schema 検証は行わない（そもそも評価対象の出力が無い/信頼できない）。
 *
 * どちらの経路も、finding の refutation・dismissal・non-actionable 化には**絶対に**変換しない
 * （critical safety invariant）。
 */
export function recordVerification({
  snapshotId = null,
  findingId,
  findingDigest,
  rawResult = null,
  executionError = null,
  cwd = process.cwd(),
  now = () => new Date(),
}) {
  if (!isNonEmptyString(findingDigest)) {
    throw new Error(
      '--finding-digest が必要です（`target` サブコマンドの出力に含まれる findingDigest を' +
        'そのまま渡してください。鮮度検証のため省略できません）',
    );
  }
  if ((rawResult === null) === (executionError === null)) {
    throw new Error('rawResult / executionError のどちらか一方だけを指定してください');
  }
  const target = resolveVerificationTarget({ snapshotId, findingId, cwd });
  const file = join(target.snap.dir, STRUCTURED_FINDINGS_VERIFICATION_FILE);
  const lockPath = acquireIngestLock(file);
  try {
    const fileExists = existsSync(file);
    const artifact = fileExists
      ? readJsonOrThrow(file, STRUCTURED_FINDINGS_VERIFICATION_FILE)
      : {
          schemaVersion: STRUCTURED_FINDINGS_VERIFICATION_SCHEMA_VERSION,
          contractVersion: REVIEW_FINDING_CONTRACT_VERSION,
          snapshotId: target.snap.snapshotId,
          attempts: [],
          humanAdjudications: [],
        };
    if (!artifact || !Array.isArray(artifact.attempts)) {
      throw new Error(
        `${file} の形式が不正です（attempts が配列ではありません）。削除してやり直してください`,
      );
    }
    if (fileExists) {
      assertArtifactBinding(artifact, {
        file,
        expectedSnapshotId: target.snap.snapshotId,
        expectedSchemaVersion: STRUCTURED_FINDINGS_VERIFICATION_SCHEMA_VERSION,
      });
    }
    if (!Array.isArray(artifact.humanAdjudications)) artifact.humanAdjudications = [];

    const seq = nextAttemptSeq(artifact);
    const recordedAt = now().toISOString();

    let attempt;
    if (executionError !== null) {
      const status = EXECUTION_ERROR_STATUSES.includes(executionError.status)
        ? executionError.status
        : 'unknown';
      attempt = {
        seq,
        recordedAt,
        finding_id: findingId,
        verifiedAgainstFindingDigest: findingDigest,
        outcome: 'execution_error',
        executionStatus: status,
        detail: truncateForMessage(String(executionError.detail ?? '')),
      };
    } else if (target.findingDigest !== findingDigest) {
      // 鮮度不一致: target 解決（prompt 生成）時点から、この finding_id 自体の内容が変化して
      // いる（手編集・破損した artifact を削除して同じ finding_id へ別内容を再 ingest した等。
      // #647 既知 Low residual）。stale な verification を current として扱わない
      // （issue #648「Artifact freshness」）。他 finding の追加 ingest ではこの不一致は
      // 発生しない（finding 単位のダイジェストのため）。
      attempt = {
        seq,
        recordedAt,
        finding_id: findingId,
        verifiedAgainstFindingDigest: findingDigest,
        outcome: 'rejected',
        errors: [
          'findingDigest が現在のこの finding_id の内容と一致しません（stale な対象に対する' +
            'verification の可能性があります）。`target` を取り直してから再検証してください。',
        ],
      };
    } else {
      const normalized = validateAndNormalizeVerification(rawResult);
      if (normalized.status === 'invalid') {
        attempt = {
          seq,
          recordedAt,
          finding_id: findingId,
          verifiedAgainstFindingDigest: findingDigest,
          outcome: 'rejected',
          errors: normalized.errors,
          raw: capForStorage(rawResult),
        };
      } else if (normalized.result.finding_id !== findingId) {
        // wrong/injected finding_id（他 finding の verdict の使い回し・別 snapshot の結果の
        // 転用等）。schema は valid でも、対象が要求した finding_id と一致しなければ
        // 拒否する（silent orphan を作らない）。
        attempt = {
          seq,
          recordedAt,
          finding_id: findingId,
          verifiedAgainstFindingDigest: findingDigest,
          outcome: 'rejected',
          errors: [
            `verification result の finding_id（${JSON.stringify(normalized.result.finding_id)}）が` +
              `対象の finding_id（${JSON.stringify(findingId)}）と一致しません`,
          ],
          raw: capForStorage(rawResult),
        };
      } else {
        attempt = {
          seq,
          recordedAt,
          finding_id: findingId,
          verifiedAgainstFindingDigest: findingDigest,
          outcome: 'accepted',
          result: normalized.result,
        };
      }
    }

    artifact.attempts.push(attempt);
    writeJson(file, artifact);
    return attempt;
  } finally {
    releaseIngestLock(lockPath);
  }
}

/**
 * 人間裁定（人間 / 最終独立レビュー等が下した valid / false_positive / uncertain の判断）を
 * 記録する。新しい lifecycle / state machine を作らない最小限の比較入力（issue #648
 * 「Human adjudication comparison」）: verifier の attempts とは独立した配列に追記するだけで、
 * finding artifact 自体・verifier の結果を書き換えない。`buildVerificationMetrics` が両方
 * 揃った finding_id についてのみ agreement/disagreement を導出する。
 */
export function recordHumanAdjudication({
  snapshotId = null,
  findingId,
  adjudication,
  note = null,
  cwd = process.cwd(),
  now = () => new Date(),
}) {
  if (!isNonEmptyString(findingId)) throw new Error('--finding-id が必要です');
  if (!HUMAN_ADJUDICATIONS.includes(adjudication)) {
    throw new Error(
      `--adjudication は次のいずれかである必要があります: ${HUMAN_ADJUDICATIONS.join(' / ')}`,
    );
  }
  // 実在確認は verifier attempts と同じ厳格さを要求しない（人間裁定は verification の
  // schema/binding とは独立の入力）が、少なくとも実在 finding_id であることは確認する
  // （タイプミスをそのまま比較指標へ混入させない）。
  const target = resolveVerificationTarget({ snapshotId, findingId, cwd });
  const file = join(target.snap.dir, STRUCTURED_FINDINGS_VERIFICATION_FILE);
  const lockPath = acquireIngestLock(file);
  try {
    const fileExists = existsSync(file);
    const artifact = fileExists
      ? readJsonOrThrow(file, STRUCTURED_FINDINGS_VERIFICATION_FILE)
      : {
          schemaVersion: STRUCTURED_FINDINGS_VERIFICATION_SCHEMA_VERSION,
          contractVersion: REVIEW_FINDING_CONTRACT_VERSION,
          snapshotId: target.snap.snapshotId,
          attempts: [],
          humanAdjudications: [],
        };
    if (!artifact || !Array.isArray(artifact.humanAdjudications)) {
      throw new Error(
        `${file} の形式が不正です（humanAdjudications が配列ではありません）。削除してやり直して` +
          'ください',
      );
    }
    if (fileExists) {
      assertArtifactBinding(artifact, {
        file,
        expectedSnapshotId: target.snap.snapshotId,
        expectedSchemaVersion: STRUCTURED_FINDINGS_VERIFICATION_SCHEMA_VERSION,
      });
    }
    if (!Array.isArray(artifact.attempts)) artifact.attempts = [];
    artifact.humanAdjudications.push({
      recordedAt: now().toISOString(),
      finding_id: findingId,
      adjudication,
      note: note === null ? null : truncateForMessage(String(note)),
    });
    writeJson(file, artifact);
    return artifact.humanAdjudications[artifact.humanAdjudications.length - 1];
  } finally {
    releaseIngestLock(lockPath);
  }
}

function readVerificationArtifact(snap) {
  const file = join(snap.dir, STRUCTURED_FINDINGS_VERIFICATION_FILE);
  const artifact = readJsonIfExists(file, STRUCTURED_FINDINGS_VERIFICATION_FILE);
  if (artifact === null) {
    return {
      schemaVersion: STRUCTURED_FINDINGS_VERIFICATION_SCHEMA_VERSION,
      attempts: [],
      humanAdjudications: [],
    };
  }
  if (!Array.isArray(artifact.attempts)) {
    throw new Error(`${file} の形式が不正です（attempts が配列ではありません）`);
  }
  assertArtifactBinding(artifact, {
    file,
    expectedSnapshotId: snap.snapshotId,
    expectedSchemaVersion: STRUCTURED_FINDINGS_VERIFICATION_SCHEMA_VERSION,
  });
  return artifact;
}

/**
 * attempts[] から「各 finding_id の現在の verification」を決定的に導出する純粋関数。
 *
 * duplicate verifier result のポリシー: 同一 finding_id への複数回の verify 呼び出しは
 * silent last-write-wins にしない（append-only ログはすべて残る）。ここでは「seq が最大の
 * accepted attempt」を明示的に selected として採用する（多数決はしない。#648
 * 「Duplicate verifier results」）。selected 以外の accepted attempt は superseded として
 * 残す（監査用。集計からは除外する）。
 *
 * **鮮度の再検証はここでは行わない**（fs を読まない純粋関数のまま維持する）。write 時点で
 * 有効だった attempt をそのまま返すだけで、「現在も有効か」の判定は呼び出し側
 * （`partitionByFreshness`）の責務にする。
 */
export function deriveVerificationView(attempts) {
  const byFinding = new Map();
  for (const a of attempts) {
    if (!byFinding.has(a.finding_id)) byFinding.set(a.finding_id, []);
    byFinding.get(a.finding_id).push(a);
  }
  const selected = new Map();
  for (const [findingId, list] of byFinding) {
    const accepted = list.filter((a) => a.outcome === 'accepted');
    if (accepted.length === 0) continue;
    const latest = accepted.reduce((best, cur) => (cur.seq > best.seq ? cur : best));
    selected.set(findingId, latest);
  }
  return { byFinding, selected };
}

/**
 * `selected`（write 時点で accepted だった最新 attempt）を、structured-findings.json の
 * **現在**の内容と突き合わせて fresh / stale に分ける。
 *
 * これが無いと、report/metrics は「write 時点で鮮度検証を通過した」という過去の事実だけを見て
 * 現在の状態を表示してしまう。個々の finding の内容は通常不変（#647: append-only）なので
 * 大半のケースでは無害だが、手編集・破損した structured-findings.json を削除して同じ
 * finding_id へ**別内容**を再 ingest した場合（#647 既知 Low residual）、その finding_id の
 * 過去の verdict は**もう別物を指している**にもかかわらず、この再検証が無ければ report/metrics
 * はそれを何の注記もなく current として提示し続けてしまう（独立レビューで指摘。
 * review-finding-verifier.js の write 側〔recordVerification〕には鮮度検証があったが、
 * read 側〔report/metrics〕には対応する再検証が欠落していた）。
 *
 * `currentFindingsById` に finding_id が存在しない場合（該当 finding が消えた・invalid に
 * なった等）も stale として扱う（unknown として current 扱いにしない）。
 */
export function partitionByFreshness(selected, currentFindingsById) {
  const fresh = new Map();
  const stale = [];
  for (const [findingId, attempt] of selected) {
    const currentFinding = currentFindingsById.get(findingId);
    const currentDigest = currentFinding ? findingContentDigest(currentFinding) : null;
    if (currentDigest !== null && attempt.verifiedAgainstFindingDigest === currentDigest) {
      fresh.set(findingId, attempt);
    } else {
      stale.push(findingId);
    }
  }
  return { fresh, stale: stale.sort() };
}

export function formatVerificationReport({ snapshotId = null, cwd = process.cwd() } = {}) {
  const snap = resolveSnapshot({ snapshotId, cwd });
  const artifact = readVerificationArtifact(snap);
  const { byFinding, selected } = deriveVerificationView(artifact.attempts);
  const { byId: currentFindingsById } = currentNormalizedFindings(snap);
  const { fresh, stale } = partitionByFreshness(selected, currentFindingsById);
  const lines = [];
  lines.push(`snapshot: ${snap.snapshotId}`);
  lines.push(`verify 試行数: ${artifact.attempts.length} / 対象 finding 数: ${byFinding.size}`);
  const rejected = artifact.attempts.filter((a) => a.outcome === 'rejected').length;
  const executionError = artifact.attempts.filter((a) => a.outcome === 'execution_error').length;
  lines.push(`rejected: ${rejected} / execution_error: ${executionError}`);
  lines.push(`selected verdict（finding_id 昇順。鮮度確認済みのみ）:`);
  const ids = [...fresh.keys()].sort();
  for (const id of ids) {
    const r = fresh.get(id).result;
    lines.push(`  - [${sanitizeForDisplay(id)}] ${r.verdict}: ${sanitizeForDisplay(r.rationale)}`);
  }
  const unresolvedTargets = [...byFinding.keys()].filter((id) => !selected.has(id));
  if (unresolvedTargets.length > 0) {
    lines.push(
      `⚠ accepted な verification が1件も無い finding_id: ${unresolvedTargets.sort().join(', ')}`,
    );
  }
  if (stale.length > 0) {
    lines.push(
      `⚠ stale な verification（finding の内容が verify 後に変わった可能性。再検証してください）: ${stale.join(', ')}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * #648 required minimum metrics: verified total / confirmed / refuted_evidence /
 * unresolved_concern の件数・率、runtime/invalid result 件数。`--angle` 指定時は
 * structured-findings.json と finding_id で突き合わせ、angle 別の内訳を返す
 * （review-findings.js buildMetricsFlags の angle 分岐と同じ設計方針）。
 *
 * `selected` は読み取り時点で `partitionByFreshness` により再検証され、stale な結果は
 * 件数から除外し `staleSelected` として別枠で可視化する（silent には消さない。
 * review-findings-aggregate.js の `counts.unrecognized` と同じ思想）。
 */
export function buildVerificationMetrics({ snapshotId = null, cwd = process.cwd(), angle = null }) {
  const snap = resolveSnapshot({ snapshotId, cwd });
  const artifact = readVerificationArtifact(snap);
  const { selected } = deriveVerificationView(artifact.attempts);
  const { byId: currentFindingsById } = currentNormalizedFindings(snap);
  const { fresh, stale } = partitionByFreshness(selected, currentFindingsById);

  const zero = () => ({ confirmed: 0, refuted_evidence: 0, unresolved_concern: 0 });
  const counts = zero();
  let matchedTotal = 0;
  for (const [findingId, attempt] of fresh) {
    if (angle !== null) {
      const finding = currentFindingsById.get(findingId);
      if (!finding || finding.provenance.angle !== angle) continue;
    }
    counts[attempt.result.verdict] += 1;
    matchedTotal += 1;
  }
  const rejectedTotal = artifact.attempts.filter((a) => a.outcome === 'rejected').length;
  const executionErrorTotal = artifact.attempts.filter(
    (a) => a.outcome === 'execution_error',
  ).length;

  const rate = (n) => (matchedTotal === 0 ? 0 : n / matchedTotal);

  // Actionable finder finding → verifier refuted_evidence の件数（false positive **候補**の
  // 追跡指標。issue #648: これ自体を「確定 false positive」とは宣言しない。人間裁定との
  // 比較が揃って初めて強いシグナルになる）。angle でフィルタしない round 全体の値としてのみ
  // 提供する（angle 別の値は用途が無いため計算しない）。
  let actionableRefuted = 0;
  if (angle === null) {
    for (const [findingId, attempt] of fresh) {
      if (attempt.result.verdict !== 'refuted_evidence') continue;
      const finding = currentFindingsById.get(findingId);
      if (!finding) continue;
      const actionable =
        ['introduced', 'worsened', 'newly_exposed'].includes(finding.scope_relation) &&
        ['med', 'high', 'blocker'].includes(finding.severity) &&
        ['verified', 'strong'].includes(finding.evidence);
      if (actionable) actionableRefuted += 1;
    }
  }

  // 人間裁定との比較（揃っている finding_id のみ、かつ鮮度確認済みのもののみ）。#648
  // 「Human adjudication comparison」: 大きな state machine を作らず、揃った分だけ
  // agreement/disagreement を数える。
  const humanByFinding = new Map(
    (artifact.humanAdjudications ?? []).map((h) => [h.finding_id, h.adjudication]),
  );
  let agreement = 0;
  let disagreement = 0;
  let humanCompared = 0;
  for (const [findingId, attempt] of fresh) {
    const human = humanByFinding.get(findingId);
    if (human === undefined) continue;
    humanCompared += 1;
    // 単純な整合規約: verifier confirmed だが human が false_positive、または verifier
    // refuted_evidence だが human が valid、は disagreement。それ以外（unresolved_concern を
    // 含む）は agreement/disagreement のどちらとも断定しない中立として扱う（unresolved を
    // 誤って false positive 側へ倒さないため）。
    if (attempt.result.verdict === 'confirmed' && human === 'false_positive') disagreement += 1;
    else if (attempt.result.verdict === 'refuted_evidence' && human === 'valid') disagreement += 1;
    else if (attempt.result.verdict === 'confirmed' && human === 'valid') agreement += 1;
    else if (attempt.result.verdict === 'refuted_evidence' && human === 'false_positive')
      agreement += 1;
  }

  return {
    verifiedTotal: matchedTotal,
    confirmed: counts.confirmed,
    confirmedRate: rate(counts.confirmed),
    refutedEvidence: counts.refuted_evidence,
    refutedEvidenceRate: rate(counts.refuted_evidence),
    unresolvedConcern: counts.unresolved_concern,
    unresolvedConcernRate: rate(counts.unresolved_concern),
    rejectedTotal,
    executionErrorTotal,
    // angle 指定時は round 全体の stale 件数をそのまま返す（angle 別の stale 集合は用途が
    // 無いため分けない。stale の有無自体は round 全体の健全性シグナルのため）。
    staleSelected: stale.length,
    actionableRefutedEvidence: angle === null ? actionableRefuted : null,
    humanComparison: { compared: humanCompared, agreement, disagreement },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const ALLOWED_FLAGS_BY_COMMAND = new Map([
  ['target', new Set(['snapshot', 'finding-id'])],
  [
    'record',
    new Set(['snapshot', 'finding-id', 'finding-digest', 'input', 'execution-error', 'detail']),
  ],
  ['record-human', new Set(['snapshot', 'finding-id', 'adjudication', 'note'])],
  ['report', new Set(['snapshot'])],
  ['metrics', new Set(['snapshot', 'angle'])],
]);

function assertKnownArgs(rest, allowedFlags) {
  let i = 0;
  while (i < rest.length) {
    const token = rest[i];
    if (!token.startsWith('--')) {
      throw new Error(`認識できない引数です: ${JSON.stringify(token)}`);
    }
    const key = token.slice(2);
    if (!allowedFlags.has(key)) {
      throw new Error(`未知の flag です: --${key}`);
    }
    const next = rest[i + 1];
    i += next === undefined || next.startsWith('--') ? 1 : 2;
  }
}

function requireStringFlag(args, key, { optional = false } = {}) {
  if (args[key] === true) throw new Error(`--${key} には値が必要です`);
  if (args[key] === '') throw new Error(`--${key} に空文字列は指定できません`);
  if (typeof args[key] !== 'string') {
    if (optional) return null;
    throw new Error(`--${key} が必要です`);
  }
  return args[key];
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const allowedFlags = ALLOWED_FLAGS_BY_COMMAND.get(cmd);
  if (allowedFlags) assertKnownArgs(rest, allowedFlags);
  const args = parseArgs(rest);
  const cwd = process.cwd();

  if (cmd === 'target') {
    const payload = buildVerificationPrompt({
      snapshotId: requireStringFlag(args, 'snapshot', { optional: true }),
      findingId: requireStringFlag(args, 'finding-id'),
      cwd,
    });
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  if (cmd === 'record') {
    const executionErrorStatus = requireStringFlag(args, 'execution-error', { optional: true });
    let rawResult = null;
    let executionError = null;
    if (executionErrorStatus !== null) {
      executionError = {
        status: executionErrorStatus,
        detail: requireStringFlag(args, 'detail', { optional: true }) ?? '',
      };
    } else {
      const inputPath = requireStringFlag(args, 'input');
      let text;
      try {
        text = readFileSync(inputPath, 'utf-8');
      } catch (err) {
        executionError = { status: 'tool_failure', detail: `--input を読めません: ${err.message}` };
      }
      if (executionError === null) {
        if (text.trim() === '') {
          executionError = { status: 'empty_output', detail: '--input の内容が空です' };
        } else {
          try {
            rawResult = JSON.parse(text);
          } catch (err) {
            executionError = { status: 'malformed_json', detail: err.message };
          }
        }
      }
    }
    const attempt = recordVerification({
      snapshotId: requireStringFlag(args, 'snapshot', { optional: true }),
      findingId: requireStringFlag(args, 'finding-id'),
      findingDigest: requireStringFlag(args, 'finding-digest'),
      rawResult,
      executionError,
      cwd,
    });
    process.stdout.write(`${JSON.stringify(attempt)}\n`);
    if (attempt.outcome !== 'accepted') process.exitCode = 1;
    return;
  }

  if (cmd === 'record-human') {
    const row = recordHumanAdjudication({
      snapshotId: requireStringFlag(args, 'snapshot', { optional: true }),
      findingId: requireStringFlag(args, 'finding-id'),
      adjudication: requireStringFlag(args, 'adjudication'),
      note: requireStringFlag(args, 'note', { optional: true }),
      cwd,
    });
    process.stdout.write(`${JSON.stringify(row)}\n`);
    return;
  }

  if (cmd === 'report') {
    process.stdout.write(
      formatVerificationReport({
        snapshotId: requireStringFlag(args, 'snapshot', { optional: true }),
        cwd,
      }),
    );
    return;
  }

  if (cmd === 'metrics') {
    const result = buildVerificationMetrics({
      snapshotId: requireStringFlag(args, 'snapshot', { optional: true }),
      angle: requireStringFlag(args, 'angle', { optional: true }),
      cwd,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stderr.write(
    'usage: review-finding-verifier.js <target|record|record-human|report|metrics> [options]\n',
  );
  process.exit(1);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  /(^|[/\\])review-finding-verifier\.js$/.test(process.argv[1])
) {
  main();
}
