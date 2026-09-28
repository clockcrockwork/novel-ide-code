// 構造化 review finding の ingest（検証・正規化・採番）→ aggregate（決定論的集約）→
// report / metrics（人間向け出力・review-metrics.js 連携用フラグ生成）の CLI。
//
// 既存の snapshot ライフサイクル（review-snapshot.js の reviewRoot/snapshotById/
// latestSnapshot）をそのまま再利用し、新しい保存領域は作らない。成果物は各 snapshot 自身の
// ディレクトリ（snap.dir）に書くため、snapshot の破棄・整理と運命を共にする。
//
// ファイル名は意図的に `findings.json` を避ける — review-plan.js の
// `discardLegacyFindingArtifacts()` が `plan` 実行の度に、各 snapshot ディレクトリ内の
// 「findings.json」という名前のファイルを無条件削除するため（旧 semantic finding 成果物の
// 掃除）。ここで書く成果物がその名前と衝突すると、`npm run review:plan` の実行だけで
// 消える。

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ANGLE_TOKENS, CONDITIONAL_ANGLE_TOKENS } from './review-angle-tokens.js';
import { REVIEW_FINDING_CONTRACT_VERSION } from './review-finding-contract.js';
import { aggregateFindings, findingIdNumber } from './review-findings-aggregate.js';
import {
  capForStorage,
  isActionable,
  truncateForMessage,
  validateAndNormalizeFinding,
} from './review-findings-normalize.js';
import { parseArgs, requireSnapshot } from './review-plan.js';
import { git, snapshotById } from './review-snapshot.js';

// review-metrics.js の isKnownAngle と同じ方式（Object.hasOwn）。`in` はプロトタイプ鎖キー
// （__proto__ 等）まで真を返すため、ANGLE_TOKENS が素のオブジェクトリテラルである以上、
// 素朴な `in` 検証では既知観点を騙る未知入力を通してしまう。
function isKnownAngle(angle) {
  return Object.hasOwn(ANGLE_TOKENS, angle) || Object.hasOwn(CONDITIONAL_ANGLE_TOKENS, angle);
}

export const STRUCTURED_FINDINGS_FILE = 'structured-findings.json';
export const STRUCTURED_FINDINGS_AGGREGATE_FILE = 'structured-findings-aggregate.json';
export const STRUCTURED_FINDINGS_SCHEMA_VERSION = 1;
// aggregate 成果物（canonical finding の形状）専用のバージョン。ingest 側の
// STRUCTURED_FINDINGS_SCHEMA_VERSION とは対象が異なるため独立して管理する。1→2 は
// round8 で canonical finding へ actionableReporters / assessmentSourceFindingId を
// 追加した形状変更を反映する（review-adversarial A9-1）。
export const STRUCTURED_FINDINGS_AGGREGATE_SCHEMA_VERSION = 2;

// `--snapshot` が指定されていればそれを、無ければ最新 snapshot を使う。snapshot が1つも
// 無い場合は review-plan.js の requireSnapshot が案内付きで fail-loud する（挙動の重複実装を
// 持たない）。
// export するのは、review-finding-verifier.js（issue #648）が同じ snapshot 解決規約を
// 再実装せず共有するため。
export function resolveSnapshot({ snapshotId, cwd }) {
  return snapshotId ? snapshotById(cwd, snapshotId) : requireSnapshot(cwd);
}

/**
 * JSON.parse に失敗した場合、生の SyntaxError ではなく復旧手順を示すエラーへ変換する
 * （review-plan.js の loadState と同じ fail-loud 方針）。呼び出し側が事前に existsSync で
 * 存在確認済みであることを前提とする（未存在時の扱いは呼び出し側の責務のまま変えない）。
 */
export function readJsonOrThrow(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch (err) {
    throw new Error(
      `${label}（${file}）が壊れています（${err.message}）。削除してやり直してください`,
      {
        cause: err,
      },
    );
  }
}

export function readJsonIfExists(file, label) {
  return existsSync(file) ? readJsonOrThrow(file, label) : null;
}

// rename は同一ディレクトリ内（= 同一ファイルシステム）であれば OS レベルでアトミックで
// あり、読み手（aggregate/report/metrics。ロックを取らない）が truncate 直後〜書き込み
// 完了前の torn な内容を観測することが構造的に無くなる（review-operability Finding#2 /
// review-adversarial N4: 26KB規模でも高頻度の torn read を実行確認済み）。
export function writeJson(file, value) {
  const tmpFile = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(tmpFile, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(tmpFile, file);
  } catch (err) {
    // writeFileSync（ディスク容量不足等）や renameSync（対象パスが既にディレクトリ等）が
    // 失敗した場合、作成済みの可能性がある tmpFile を残さない——acquireIngestLock の
    // writeFileSync/closeSync 失敗時クリーンアップと同じ best-effort 方針（tmpFile がまだ
    // 作成されていない段階での失敗なら unlinkSync は ENOENT で失敗するが、それも無視してよい）。
    try {
      unlinkSync(tmpFile);
    } catch {
      // 削除できなくても元の例外をそのまま伝播させる。
    }
    throw err;
  }
}

/**
 * EEXIST 時の診断用ベストエフォートヘルパー。既存ロックの中身（pid・取得時刻）を人間可読な
 * 文字列にする。あくまで運用者が「異常終了した残留ロックか、今も実行中の別プロセスか」を
 * 判断するための材料であり、ロックの中身が空・壊れている・読めない場合でも、本来投げるべき
 * EEXIST エラーを別の例外でマスクしてはいけないため、ここでは throw しない。
 *
 * pid を呼び出し側（`acquireIngestLock`）が判定できるよう、表示用文字列だけでなく
 * `pid`（数値 or null）も返す — pid が不明な場合にまで `ps -p <pid>` を案内すると、
 * 案内された確認手順が実行不可能になる（review-operability Finding#1 / review-adversarial N5:
 * 実行検証済み）。
 */
function describeLockHolder(lockPath) {
  let content;
  try {
    content = readFileSync(lockPath, 'utf-8');
  } catch {
    return { pid: null, description: 'ロックの中身を読み取れませんでした' };
  }
  if (content === '') {
    return {
      pid: null,
      description:
        'ロックの中身が空です' +
        '（このロックを作成した実行が古いバージョンのものか、書き込みが中断された可能性があります）',
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { pid: null, description: 'ロックの中身を読み取れませんでした' };
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !isFiniteNumber(parsed.pid)
  ) {
    return { pid: null, description: 'ロックの中身を読み取れませんでした' };
  }
  return {
    pid: parsed.pid,
    description: `pid=${parsed.pid} acquiredAt=${parsed.acquiredAt ?? '不明'}`,
  };
}

/**
 * `ingestFindings` の冒頭で呼ぶ。`${file}.lock` を `wx`（排他新規作成。既に存在すれば
 * `EEXIST` で失敗する）で作成することで、真の排他制御を得る——「読んでから比較して書く」楽観的
 * チェックとは異なり、2つのプロセスが両方とも「自分だけが書いている」と誤認する窓が存在しない
 * （OS レベルでアトミック）。ロックの中身には取得プロセスの pid・取得時刻を書き込む——空の
 * ロックのままだと、異常終了による残留ロックか今も実行中の別プロセスかを運用者が区別できず、
 * 実行中のロックを誤って削除すると排他制御そのものを再び壊してしまうため。
 */
export function acquireIngestLock(file) {
  const lockPath = `${file}.lock`;
  let fd;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (err) {
    if (err.code === 'EEXIST') {
      const holder = describeLockHolder(lockPath);
      // pid が判明している場合のみ `ps -p <pid>` を案内する。判明しない場合（空・壊れている・
      // pid 未記載）にまで固定文言で `ps -p` を案内すると、案内された確認手順が実行不可能に
      // なる（review-operability Finding#1 / review-adversarial N5: 実行検証済み）。
      const confirmationGuidance =
        holder.pid !== null
          ? `このプロセスが実際に実行中か確認してから（例: pid ${holder.pid} を \`ps -p ${holder.pid}\` 等で確認）、`
          : 'このロックを取得したプロセスの pid が分からないため、他に本ロックを取得しうる ingest ' +
            'プロセスが実行中でないことを別の方法で確認してから、';
      throw new Error(
        `別の ingest がこの snapshot に対して実行中です（ロックファイル: ${lockPath}）。` +
          '同一 snapshot への並行 ingest はサポートされていません。' +
          `既存ロックの中身: ${holder.description}。` +
          confirmationGuidance +
          '異常終了により残留したロックだと判断できた場合にのみ手動で削除して再実行してください。',
        { cause: err },
      );
    }
    throw err;
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
    closeSync(fd);
  } catch (err) {
    // openSync（'wx'）が成功した直後の writeFileSync/closeSync 失敗（ディスク容量不足等）。
    // この時点でロックファイルは「このプロセスが今しがた自分自身で作成したもの」であることが
    // 確定しており、他プロセスが横取りする前なので、競合リスクなくクリーンアップできる。
    // fd が開いたままの可能性がある（writeFileSync 失敗時）ため close を試みる——既に
    // closeSync 済み・無効な fd の可能性がある（closeSync 自体が失敗した経路）ため
    // best-effort で行う。クリーンアップ自体が失敗しても、元の例外を優先して伝播させる。
    try {
      closeSync(fd);
    } catch {
      // 既に閉じられている等。ここでの失敗は無視する。
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // 削除できなくても元の例外をそのまま伝播させる。
    }
    throw err;
  }
  return lockPath;
}

// 自分が取得したロックであることを確認してから削除する。人間が誤って残留と判断し
// 手動削除した後に別プロセスが取得したロックを、このプロセスの finally が無条件 unlink で
// 消してしまうと、ロックが防ぐはずの並行書き込みが再発する（review-adversarial N5:
// 実行検証済み）。読めない・パースできない・pid が一致しない場合は「自分のロックではない」
// として何もしない（ベストエフォート。ingest 自体の結果はそのまま返す/伝播させる）。
export function releaseIngestLock(lockPath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(lockPath, 'utf-8'));
  } catch {
    return;
  }
  if (parsed && typeof parsed === 'object' && parsed.pid === process.pid) {
    try {
      unlinkSync(lockPath);
    } catch {
      // 削除できなくても呼び出し結果はそのまま返す/伝播させる。
    }
  }
}

export function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// records の内容から決定的な fingerprint を作る。件数だけの比較（旧実装）は、件数を
// 変えずに内容を差し替えるケース（例: 壊れたartifactを削除して同数を再ingestする、
// 復旧手順どおりの操作）を鮮度不一致として検出できなかった（review-adversarial A1:
// 実行検証済み）。JSON.stringify はオブジェクトの own key 挿入順に依存するが、
// records の各要素は validateAndNormalizeFinding が常に同じ順序でキーを組み立てるため
// （動的キー代入をしない既存方針）、同じ内容なら常に同じ文字列になり決定的。
export function hashFindingsContent(records) {
  return createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

// aggregate 成果物は `report` / `metrics` の両方が「先に aggregate 済みであること」を要求する
// 読み取り専用の前提として共有する。無ければ同じ文言で fail-loud する（`report` は副作用として
// aggregate を自動実行しない）。加えて、(a) schemaVersion が現在のコードが書き込む値
// （STRUCTURED_FINDINGS_AGGREGATE_SCHEMA_VERSION）と一致するか（不一致なら canonical finding の
// 形状が変わった以前のコード版が生成した成果物であり、鮮度ガード〔sourceHash〕は ingest 内容の
// 変化しか検知しないためすり抜ける——round8 で追加した actionableReporters /
// assessmentSourceFindingId の欠落が無警告のまま復活したり、それらへの参照が生の TypeError に
// なったりする。review-adversarial A9-1: 実行検証済み）、(b) 形状（counts の必須数値
// フィールド・sourceHash）が壊れていないか、(c) 現在の structured-findings.json の records
// 内容から計算したハッシュが aggregate 記録時の sourceHash と一致するか（一致しなければ
// 「aggregate 後に ingest 内容が変わった」＝古い aggregate を読んでいる。件数が同じでも内容が
// 変わっていれば検出する—— review-adversarial A1）も検証する。
function readAggregateOrThrow(snap) {
  const file = join(snap.dir, STRUCTURED_FINDINGS_AGGREGATE_FILE);
  if (!existsSync(file)) {
    throw new Error('先に aggregate を実行してください');
  }
  const aggregate = readJsonOrThrow(file, STRUCTURED_FINDINGS_AGGREGATE_FILE);
  if (aggregate?.schemaVersion !== STRUCTURED_FINDINGS_AGGREGATE_SCHEMA_VERSION) {
    throw new Error(
      `${STRUCTURED_FINDINGS_AGGREGATE_FILE} のスキーマバージョンが古いか不明です` +
        `（\`schemaVersion\`=${aggregate?.schemaVersion}、` +
        `期待値=${STRUCTURED_FINDINGS_AGGREGATE_SCHEMA_VERSION}）。` +
        '以前のコード版が生成した成果物である可能性があります。' +
        '`review-findings.js aggregate` を再実行してください。',
    );
  }
  // aggregate.snapshotId が対象 snapshot と一致するかも検証する。防いでいる攻撃シナリオの
  // 詳細は `assertArtifactBinding` の定義コメントを参照（ingest/aggregate を経ずに artifact を
  // 直接コピーする経路を防ぐ点は共通）。ただし検証対象は aggregate 自身であり、
  // `assertArtifactBinding`（findingsArtifact 用）は呼べない——aggregate には
  // contractVersion フィールドが無いため（`runAggregate` が書き込む形状に含まれない）、
  // schemaVersion + snapshotId の2点で検証する独立したチェックとして存在する。
  if (aggregate?.snapshotId !== snap.snapshotId) {
    throw new Error(
      `${STRUCTURED_FINDINGS_AGGREGATE_FILE} の snapshotId が一致しません` +
        `（\`snapshotId\`=${JSON.stringify(aggregate?.snapshotId)}、` +
        `期待値=${JSON.stringify(snap.snapshotId)}）。別の snapshot からコピーされた可能性が` +
        'あります。削除して aggregate からやり直すか、正しい snapshot を指定してください',
    );
  }
  const counts = aggregate?.counts;
  const requiredCountFields = [
    'totalIngested',
    'normalized',
    'invalid',
    'unrecognized',
    'validMedPlus',
    'actionable',
    'canonical',
    'exactDuplicates',
    'duplicateClusterParticipation',
    'candidateGroupCount',
  ];
  if (
    counts === null ||
    typeof counts !== 'object' ||
    Array.isArray(counts) ||
    requiredCountFields.some((key) => !isFiniteNumber(counts[key])) ||
    typeof aggregate.sourceHash !== 'string'
  ) {
    throw new Error(
      `${STRUCTURED_FINDINGS_AGGREGATE_FILE} の形式が不正です（counts に必要な数値フィールドが` +
        '揃っていないか、sourceHash が欠落しています）。先に aggregate を再実行してください',
    );
  }
  // counts / sourceHash が揃っていても canonicalFindings 自体が欠落・非配列（部分破損・別
  // schema の cache 混入等）だと、この後の formatReport / buildMetricsFlags の
  // `canonicalFindings.filter(...)` が案内なしの生 TypeError を投げてしまう。他の形状検証と
  // 同じ方針で、ここで fail-loud にする。
  if (!Array.isArray(aggregate.canonicalFindings)) {
    throw new Error(
      `${STRUCTURED_FINDINGS_AGGREGATE_FILE} の形式が不正です（canonicalFindings が配列では` +
        'ありません）。先に aggregate を再実行してください',
    );
  }
  const findingsFile = join(snap.dir, STRUCTURED_FINDINGS_FILE);
  const findingsArtifact = readJsonIfExists(findingsFile, STRUCTURED_FINDINGS_FILE);
  // findingsArtifact が非 null（= structured-findings.json が存在し、JSON としては読めた）
  // なのに records が配列でない場合、`?? []` へ黙って fallback すると、破損後の空配列ハッシュが
  // 「一度も ingest していない」正当な空集計由来の sourceHash（同じく空配列のハッシュ）と
  // 偶然一致してしまい、破損を検知できないまま素通りする経路がある（runAggregate / ingest 側の
  // 書き込み経路には既にある同種のガードを、読み取り経路にも揃える）。
  if (findingsArtifact !== null && !Array.isArray(findingsArtifact.records)) {
    throw new Error(
      `${findingsFile} の形式が不正です（records が配列ではありません）。` +
        '削除して ingest からやり直してください',
    );
  }
  // findingsArtifact が存在する場合、その schemaVersion/contractVersion/snapshotId も検証する。
  // 検証内容・fail-loud の判断は `ingestFindings`・`runAggregate` と共有する
  // `assertArtifactBinding` を正本とする（詳細な理由はその定義コメントを参照）。
  if (findingsArtifact !== null) {
    assertArtifactBinding(findingsArtifact, {
      file: findingsFile,
      expectedSnapshotId: snap.snapshotId,
    });
  }
  const currentRecords = findingsArtifact?.records ?? [];
  if (hashFindingsContent(currentRecords) !== aggregate.sourceHash) {
    throw new Error(
      'aggregate 結果が古い可能性があります（ingest 内容が変わっています）。' +
        '先に aggregate を再実行してください',
    );
  }
  return aggregate;
}

// 既存 artifact（fileExists の場合のみ意味を持つ）の schemaVersion/contractVersion/snapshotId が
// 現在のコード・snapshot と一致するかを検証する共有ヘルパー。records が配列でありさえすれば
// 呼び出し側の形式チェックは通過するため、別 snapshot からコピーされた、または旧
// schema/contract バージョンで生成された structured-findings.json がこのディレクトリに
// 置かれていた場合、ingest 経由では現在の snapshot の finding として追記され、aggregate 経由では
// ingest を経ずに直接読み込まれ、どちらも report/metrics がこの混入 record を現在の snapshot に
// 帰属させて誤集計してしまう（chatgpt-codex-connector 所見。review-pr #650。aggregate 経由の
// 抜け穴は review-adversarial round16 で実行検証済み——ingest を経ずに別 snapshot の
// structured-findings.json を直接コピーしても、鮮度ガード〔sourceHash〕は配置後の内容から
// 再計算されるため通過してしまう）。`ingestFindings`・`runAggregate` の両方の読み取り経路から、
// 既存 artifact を読んだ場合（fileExists）にのみ呼ぶ（新規作成時は検証不要）。
//
// `expectedSchemaVersion` は既定で `STRUCTURED_FINDINGS_SCHEMA_VERSION`（このファイル自身が
// 書く structured-findings.json 用の値）。**他の artifact 形状（例:
// review-finding-verifier.js の structured-findings-verifications.json。issue #648）が
// この共有 binding 検証を再利用する場合、自分自身の schemaVersion 定数を明示的に渡すこと** —
// 既定値のまま呼ぶと、findings 側の schemaVersion がこの先バージョンアップされた際に、
// 中身が変わっていない別 artifact まで「schemaVersion 不一致」として誤検出される（逆に、
// たまたま数値が一致している間は誤って検証をすり抜ける）。
export function assertArtifactBinding(
  artifact,
  { file, expectedSnapshotId, expectedSchemaVersion = STRUCTURED_FINDINGS_SCHEMA_VERSION },
) {
  if (artifact.schemaVersion !== expectedSchemaVersion) {
    throw new Error(
      `${file} の schemaVersion が一致しません（\`schemaVersion\`=` +
        `${JSON.stringify(artifact.schemaVersion)}、期待値=${expectedSchemaVersion}）。` +
        '別の snapshot / 古いコード版で生成された可能性がある artifact です。削除して ' +
        'ingest からやり直すか、正しい snapshot を指定してください',
    );
  }
  if (artifact.contractVersion !== REVIEW_FINDING_CONTRACT_VERSION) {
    throw new Error(
      `${file} の contractVersion が一致しません（\`contractVersion\`=` +
        `${JSON.stringify(artifact.contractVersion)}、期待値=${REVIEW_FINDING_CONTRACT_VERSION}）。` +
        '別の snapshot / 古いコード版で生成された可能性がある artifact です。削除して ' +
        'ingest からやり直すか、正しい snapshot を指定してください',
    );
  }
  if (artifact.snapshotId !== expectedSnapshotId) {
    throw new Error(
      `${file} の snapshotId が一致しません（\`snapshotId\`=${JSON.stringify(artifact.snapshotId)}、` +
        `期待値=${JSON.stringify(expectedSnapshotId)}）。別の snapshot からコピーされた可能性がある ` +
        'artifact です。削除して ingest からやり直すか、正しい snapshot を指定してください',
    );
  }
}

/**
 * 生 finding の配列を検証・正規化し、対象 snapshot の structured-findings.json へ追記する。
 * 呼び出し側（`main()`）が既に JSON.parse 済みの配列を渡す前提で、ここではファイル読み込みを
 * 行わない（独立して unit テストできるようにするため）。
 */
export function ingestFindings({
  snapshotId = null,
  angle = null,
  anchorClass = null,
  rawFindings,
  cwd = process.cwd(),
  now = () => new Date(),
}) {
  if (!Array.isArray(rawFindings)) {
    throw new Error('rawFindings は配列である必要があります');
  }
  // `angle`（CLI の `--angle`。個々の finding が独自の provenance.angle を持たない場合の
  // 既定値）は、後続では各要素の解決後の provenance.angle に対してしか isKnownAngle 検証されない
  // ため、バッチ内の全要素が既に有効な明示 provenance.angle を持つ場合、`angle` 自体
  // （実際にはどの要素にも適用されない）が一度も検証されず、typo がそのまま ingestBatch.angle
  // （監査メタデータ）に記録されてしまう。`angle` が null（全 finding が自前の provenance.angle
  // を持つことを前提にした呼び出し）の場合は、この検証の対象外とする（既存の要素単位の検証が
  // そのまま効く）。
  if (angle !== null && !isKnownAngle(angle)) {
    throw new Error(truncateForMessage(`未知の観点です（--angle）: ${angle}`));
  }
  const snap = resolveSnapshot({ snapshotId, cwd });
  // normalizeFile の基準は process.cwd()（CLI呼び出し元ディレクトリ）ではなく、実際の
  // リポジトリのworktree rootにする——呼び出し元がリポジトリルート以外（例:
  // scripts/agent/ から直接実行）だと、絶対パスの file が「cwd配下でない」と誤判定され
  // path正規化が黙って無効化される（review-adversarial A-3: 実行検証済み）。
  // review-snapshot.js の既存パターン（git rev-parse --show-toplevel）を再利用する。
  const worktreeRoot = git(['rev-parse', '--show-toplevel'], { cwd }).trim();
  const file = join(snap.dir, STRUCTURED_FINDINGS_FILE);
  // 同一 snapshot への並行 ingest を排他制御する。取得できたら必ず finally で解放する。
  const lockPath = acquireIngestLock(file);
  try {
    const fileExists = existsSync(file);
    if (!fileExists) {
      // findings.json が存在しない場合、「まだ一度も ingest していない」正当な初回か、
      // 「以前は records があったが削除された」疑わしい状態かを、既存の aggregate 成果物と
      // 突き合わせて区別する。runAggregate と全く同じガード（review-operability round7
      // 所見1: 実行検証済み。ingest 経由でこのガードが無いと、runAggregate 側のガードを
      // 迂回して同じデータ消失が再発する——ingestで新規の空ログを一度作ってしまうと、
      // 次のaggregate実行時にはファイルが「存在する」状態になり、runAggregate側のガードの
      // 発火条件〔!fileExists〕に当たらなくなる）。
      const aggregateFile = join(snap.dir, STRUCTURED_FINDINGS_AGGREGATE_FILE);
      if (existsSync(aggregateFile)) {
        const previousAggregate = readJsonOrThrow(
          aggregateFile,
          STRUCTURED_FINDINGS_AGGREGATE_FILE,
        );
        const previousTotal = previousAggregate?.counts?.totalIngested;
        if (isFiniteNumber(previousTotal) && previousTotal > 0) {
          throw new Error(
            `${file} が存在しませんが、既存の ${STRUCTURED_FINDINGS_AGGREGATE_FILE} は ` +
              `${previousTotal} 件の ingest 実績を記録しています。ingest ログが削除された可能性が` +
              'あり、このまま新規ログとして ingest を続けると、次の aggregate で過去の集計結果' +
              '（他 reviewer 分を含む）が黙って上書きされます。意図した操作であれば、先に古い ' +
              STRUCTURED_FINDINGS_AGGREGATE_FILE +
              ' も削除してからやり直してください。',
          );
        }
      }
    }
    const artifact = fileExists
      ? readJsonOrThrow(file, STRUCTURED_FINDINGS_FILE)
      : {
          schemaVersion: STRUCTURED_FINDINGS_SCHEMA_VERSION,
          contractVersion: REVIEW_FINDING_CONTRACT_VERSION,
          snapshotId: snap.snapshotId,
          records: [],
        };
    // records が配列でない（欠落・別形状）壊れた artifact だけでなく、artifact 自体が
    // falsy（ファイルの中身が JSON の妥当な値としての `null` 等）な場合も同様に扱う——ここに
    // 来る artifact はファイルが存在する場合の読み取り結果のみで、存在しない場合は上で
    // 既定オブジェクトを使っているため、falsy になるのはファイルの中身が壊れている場合だけ
    // である（runAggregate と同じ方針: 生の TypeError ではなく復旧手順を示すエラーで
    // fail-loud する）。
    if (!artifact || !Array.isArray(artifact.records)) {
      throw new Error(
        `${file} の形式が不正です（records が配列ではありません）。` +
          '削除して ingest からやり直してください',
      );
    }
    // fileExists（既存 artifact を読んだ場合）のみ、schemaVersion/contractVersion/snapshotId が
    // 現在のコード・snapshot と一致するかを検証する（新規作成時は直前の分岐で自分自身が設定した
    // 値のため検証不要）。検証内容・fail-loud の判断は `runAggregate` と共有する
    // `assertArtifactBinding` を正本とする（詳細な理由はその定義コメントを参照）。
    if (fileExists) {
      assertArtifactBinding(artifact, { file, expectedSnapshotId: snap.snapshotId });
    }

    // 既存 records の最大数値サフィックスから採番を再開する（同一 snapshot への複数回の
    // ingest 呼び出しをまたいで単調増加させるため）。空なら 0 から。フォーマット不一致・
    // 桁あふれ（巨大な数値文字列で Number.parseInt が精度を落として飽和する）はどちらも
    // artifact 破損として fail-loud する — 黙って許容すると、以後の ingest が同じ finding_id を
    // 採番し続け、既存レコードを上書き衝突させる。
    let nextSeq = 0;
    for (const record of artifact.records) {
      // 形式検証・安全整数チェックは review-findings-aggregate.js の findingIdNumber と
      // 重複実装しない（review-quality 所見1）。ただし ingest 側は独自のエラーメッセージで
      // fail-loud する既存契約を維持するため、throw をその場で catch して変換する。
      let parsed;
      try {
        parsed = findingIdNumber(record.finding_id);
      } catch {
        parsed = NaN;
      }
      if (!Number.isSafeInteger(parsed)) {
        throw new Error(
          `artifact に不正な finding_id 形式のレコードがあります: ${JSON.stringify(record.finding_id)}`,
        );
      }
      nextSeq = Math.max(nextSeq, parsed);
    }

    const ingestedAt = now().toISOString();
    const ingestBatch = { angle, anchorClass };
    // 返り値の normalized/invalid はこの呼び出し1回分だけの内訳（artifact 全体の累計ではない）。
    let normalizedThisCall = 0;
    let invalidThisCall = 0;
    const invalidDetails = [];

    for (const element of rawFindings) {
      nextSeq += 1;
      // Number.MAX_SAFE_INTEGER を超えると浮動小数点の加算が一意に増分しなくなり、以後の
      // 全要素が同じ finding_id に衝突する（黙って重複IDを発行するくらいなら、この
      // 天文学的な件数に達した時点で fail-loud する方が安全）。
      if (!Number.isSafeInteger(nextSeq)) {
        throw new Error(
          'finding_id の採番上限に達しました。この snapshot にこれ以上 ingest できません',
        );
      }
      // 4桁未満はゼロ埋めし、4桁を超えたら桁を広げる（折り返し・切り詰めはしない）。
      const findingId = `f-${String(nextSeq).padStart(4, '0')}`;

      // 1要素の処理を丸ごと try/catch する: validateAndNormalizeFinding は原則 throw しない契約
      // だが、capForStorage（invalid record の raw 保存）は極端に深い/循環参照を含む要素で
      // RangeError を投げうる。ここで捕まえず伝播させると、バッチ全体が中断し、既にこの呼び出しで
      // 処理済みの他の正常な要素まで書き込まれずに失われる（1要素の異常が全体を道連れにしない、
      // という finding ingest の契約を守る）。
      let record;
      let isInvalid = false;
      let errorsForDetail = null;
      try {
        const result = validateAndNormalizeFinding(element, {
          defaultAngle: angle,
          defaultAnchorClass: anchorClass,
          cwd: worktreeRoot,
        });
        if (result.status === 'normalized' && !isKnownAngle(result.finding.provenance.angle)) {
          const message = truncateForMessage(`未知の観点です: ${result.finding.provenance.angle}`);
          isInvalid = true;
          errorsForDetail = [message];
          record = {
            finding_id: findingId,
            status: 'invalid',
            ingestedAt,
            ingestBatch,
            errors: [message],
            raw: capForStorage(element),
          };
        } else if (result.status === 'normalized') {
          record = {
            finding_id: findingId,
            status: 'normalized',
            ingestedAt,
            ingestBatch,
            finding: { finding_id: findingId, ...result.finding },
          };
        } else {
          isInvalid = true;
          errorsForDetail = result.errors;
          record = {
            finding_id: findingId,
            status: 'invalid',
            ingestedAt,
            ingestBatch,
            errors: result.errors,
            raw: capForStorage(element),
          };
        }
      } catch (err) {
        const message = truncateForMessage(
          `finding の処理中に予期しないエラーが発生しました: ${err.message}`,
        );
        isInvalid = true;
        errorsForDetail = [message];
        record = {
          finding_id: findingId,
          status: 'invalid',
          ingestedAt,
          ingestBatch,
          errors: [message],
        };
      }

      artifact.records.push(record);
      if (isInvalid) {
        invalidThisCall += 1;
        invalidDetails.push({ finding_id: findingId, errors: errorsForDetail });
      } else {
        normalizedThisCall += 1;
      }
    }

    writeJson(file, artifact);

    return {
      snapshotId: snap.snapshotId,
      added: rawFindings.length,
      normalized: normalizedThisCall,
      invalid: invalidThisCall,
      invalidDetails,
    };
  } finally {
    // ロック解放はベストエフォート: 失敗しても ingest 自体の結果/エラーをマスクしない。
    // 所有権（pid一致）の確認は releaseIngestLock 自身が行う（review-adversarial N5）。
    releaseIngestLock(lockPath);
  }
}

/**
 * 対象 snapshot の structured-findings.json を集約し、structured-findings-aggregate.json を
 * 書く。ingest が一度も行われていない（ファイル自体が無い）場合も records=[] として成功する
 * （「まだ何も取り込んでいない」は空集計であってエラーではない）。ただし、既存の
 * structured-findings-aggregate.json が totalIngested > 0 を記録している状態で
 * structured-findings.json が存在しない場合は、「ingest ログが削除された疑わしい状態」として
 * fail-loud する（review-operability round6 Finding#1: 空集計での不可逆な上書きを防ぐ）。
 */
export function runAggregate({ snapshotId = null, cwd = process.cwd(), now = () => new Date() }) {
  const snap = resolveSnapshot({ snapshotId, cwd });
  const findingsFile = join(snap.dir, STRUCTURED_FINDINGS_FILE);
  // ファイルが「存在しない」（正当な空集計ケース）場合と「存在するが中身が壊れている」場合を
  // 区別する必要があるため、readJsonIfExists（両者とも null を返す）は使わず existsSync で
  // 明示的に分岐する。後者は records が配列でない場合（欠落・別形状）だけでなく、artifact
  // 自体が falsy（JSON の妥当な値としての `null` 等）な場合も同様に「壊れている」として扱う
  // ——`?? []` で黙って空集計に倒すと、実際は取り込み済みの finding が全て消えたのと
  // 区別が付かなくなる。
  const fileExists = existsSync(findingsFile);
  const artifact = fileExists ? readJsonOrThrow(findingsFile, STRUCTURED_FINDINGS_FILE) : null;
  if (fileExists && (!artifact || !Array.isArray(artifact.records))) {
    throw new Error(
      `${findingsFile} の形式が不正です（records が配列ではありません）。` +
        '削除して ingest からやり直してください',
    );
  }
  // fileExists（既存 artifact を読んだ場合）のみ、schemaVersion/contractVersion/snapshotId が
  // 現在のコード・snapshot と一致するかを検証する。検証内容・fail-loud の判断は
  // `ingestFindings` と共有する `assertArtifactBinding` を正本とする（詳細な理由はその定義
  // コメントを参照）。
  if (fileExists) {
    assertArtifactBinding(artifact, { file: findingsFile, expectedSnapshotId: snap.snapshotId });
  }
  if (!fileExists) {
    // ingest ログが存在しない場合、「まだ一度も ingest していない」正当な空集計か、
    // 「以前は records があったが削除された」疑わしい状態かを、既存の aggregate 成果物と
    // 突き合わせて区別する（review-operability round6 Finding#1: 実行検証済みのデータ消失経路。
    // 壊れたingestログを削除する復旧手順→report鮮度検出→案内通りaggregate再実行、という
    // 連鎖で発生する）。
    const aggregateFile = join(snap.dir, STRUCTURED_FINDINGS_AGGREGATE_FILE);
    if (existsSync(aggregateFile)) {
      const previousAggregate = readJsonOrThrow(aggregateFile, STRUCTURED_FINDINGS_AGGREGATE_FILE);
      const previousTotal = previousAggregate?.counts?.totalIngested;
      if (isFiniteNumber(previousTotal) && previousTotal > 0) {
        throw new Error(
          `${findingsFile} が存在しませんが、既存の ${STRUCTURED_FINDINGS_AGGREGATE_FILE} は ` +
            `${previousTotal} 件の ingest 実績を記録しています。ingest ログが削除された可能性が` +
            'あり、このまま空集計で上書きすると過去の集計結果（他 reviewer 分を含む）が失われます。' +
            '意図した操作であれば、先に古い ' +
            STRUCTURED_FINDINGS_AGGREGATE_FILE +
            ' も削除してから' +
            'やり直してください。',
        );
      }
    }
  }
  const records = artifact?.records ?? [];
  const aggregate = {
    schemaVersion: STRUCTURED_FINDINGS_AGGREGATE_SCHEMA_VERSION,
    snapshotId: snap.snapshotId,
    generatedAt: now().toISOString(),
    sourceHash: hashFindingsContent(records),
    ...aggregateFindings(records),
  };
  writeJson(join(snap.dir, STRUCTURED_FINDINGS_AGGREGATE_FILE), aggregate);
  return aggregate;
}

/**
 * review-metrics.js の `record` サブコマンドへそのまま渡せるフラグ文字列を組み立てる。
 * `angle` を指定すると、round 全体ではなく**その観点自身が actionable と評価した
 * （`validMedPlus`/`uniqueValidMedPlus`）、または `reportedBy` に含まれる
 * （`duplicateClusterParticipation`）canonical finding だけ**を対象にした値を返す（観点ごとの
 * unique valid Med+ を dogfood 指標として追跡するため。review-spec F1+F2、所見1による
 * actionableReporters 基準への訂正）。
 */
export function buildMetricsFlags({ snapshotId = null, cwd = process.cwd(), angle = null }) {
  // 綴り違い・表示ラベル（例: `risk-model`。canonical ID は `riskmodel`）を渡すと、常に
  // 「該当0件」を意味する 0/0/0 が返り、「その観点は所見ゼロだった」という正当な結果と
  // 区別が付かない。`ingest`・review-metrics.js の `record --angle` と同じ検証を、
  // angle 有無どちらの分岐にも共通する入口で行う（review-spec F3: 実行検証済み）。
  if (angle !== null && !isKnownAngle(angle)) {
    throw new Error(truncateForMessage(`未知の観点です: ${angle}`));
  }
  const snap = resolveSnapshot({ snapshotId, cwd });
  const aggregate = readAggregateOrThrow(snap);
  if (angle === null) {
    const { validMedPlus, actionable, duplicateClusterParticipation } = aggregate.counts;
    return {
      validMedPlus,
      uniqueValidMedPlus: actionable,
      duplicateClusterParticipation,
      flagString:
        `--valid-med-plus ${validMedPlus} ` +
        `--unique-valid-med-plus ${actionable} ` +
        `--duplicate-cluster-participation ${duplicateClusterParticipation}`,
    };
  }
  // 観点ごとの内訳: actionableReporters にこの観点自身が含まれる canonical finding だけを
  // 対象にする——「そのクラスタが」actionableかではなく「その観点自身が」actionableと評価した
  // かで判定する（review-spec 所見1: cluster全体のactionable判定を使うと、非actionableな
  // 評価しか出していない観点にまでvalidMedPlusが誤って計上される。実行検証済み）。観点内の
  // 自己重複は既に aggregate 側で sortedDistinct によって排除済みのため、観点単位では
  // validMedPlus と uniqueValidMedPlus は同じ値になる（観点をまたいだ重複排除が無い以上、
  // 観点内で「重複」という概念自体が発生しない）。duplicateClusterParticipation は収束
  // （複数観点が同じ問題に到達した事実）を追跡する指標であり、actionable 判定を経由しない
  // reportedBy ベースのまま独立に計算する（修正1の対象外）。
  const forAngle = aggregate.canonicalFindings.filter((c) => c.actionableReporters.includes(angle));
  const actionableForAngle = forAngle.length; // 「そのクラスタが」ではなく「その観点自身が」actionableと評価した件数
  const duplicateClusterParticipationForAngle = aggregate.canonicalFindings.filter(
    (c) => c.reportedBy.includes(angle) && c.reportedBy.length > 1,
  ).length;
  return {
    validMedPlus: actionableForAngle,
    uniqueValidMedPlus: actionableForAngle,
    duplicateClusterParticipation: duplicateClusterParticipationForAngle,
    // uniqueValidMedPlus は観点内では自己重複が既に排除済みのため validMedPlus と同値だが、
    // round全体でこの値を review-metrics.js の record へ渡すと、summarize() の単純加算により
    // 「unique」が持つべき非加算的な意味（round全体でのdedup後件数）が崩れる
    // （review-spec F2で実証。実行検証済み）。flagString は record への受け渡し用のため、
    // 意図的に --unique-valid-med-plus を含めない（round全体の正確なunique数は
    // report/aggregate artifactを直接参照する）。
    flagString:
      `--valid-med-plus ${actionableForAngle} ` +
      `--duplicate-cluster-participation ${duplicateClusterParticipationForAngle}`,
  };
}

// report は reviewer が書いた自由記述の summary をそのまま人間可読出力へ埋め込む。埋め込み
// 改行や ESC/CR 等の制御文字を許すと、他の行（例: 「actionable な canonical finding」見出し）を
// 偽装したり端末を誤動作させたりできる。表示直前にのみ無害化し、保存済み finding.summary 自体は
// 書き換えない。
// eslint-disable-next-line no-control-regex -- 制御文字の除去が目的の検証用正規表現
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/g;
export function sanitizeForDisplay(text) {
  return text.replace(CONTROL_CHARS_RE, ' ');
}

export function formatReport(aggregate) {
  const { counts, canonicalFindings } = aggregate;
  const lines = [];
  lines.push(
    `取り込み: ${counts.totalIngested}（正規化 ${counts.normalized} / 不正 ${counts.invalid} / ` +
      `unrecognized ${counts.unrecognized}）`,
  );
  lines.push(
    `canonical: ${counts.canonical}（完全重複 ${counts.exactDuplicates} / actionable ${counts.actionable}）`,
  );
  lines.push(
    `valid Med+: ${counts.validMedPlus} / duplicate cluster participation: ${counts.duplicateClusterParticipation}`,
  );
  lines.push(`候補グループ: ${counts.candidateGroupCount}`);
  // aggregateFindings は unrecognized record（status が normalized/invalid のいずれでもない
  // record。schema移行・手動破損由来）を counts.unrecognized として正しく分離・保持しているが
  // （silent dropしない設計）、この人間可読 report にそれを出さないと、後続の全ての行が0件表示に
  // なり「正常な空結果」と誤読される。machine が検出できているデータを表示だけで隠さないよう、
  // 1件以上あれば目立つ警告行を追加する。
  if (counts.unrecognized > 0) {
    lines.push(
      `⚠ unrecognized な record が ${counts.unrecognized} 件あります（schema移行・手動破損の` +
        `可能性）。${STRUCTURED_FINDINGS_FILE} の該当 record（status が normalized/invalid の` +
        'いずれでもないもの）を確認してください。',
    );
  }
  // aggregate 済みの `actionable` フィールドをそのまま信頼せず、公開関数 isActionable() から
  // 都度導出する（判定式の正本を1箇所に保つ）。
  const actionableFindings = canonicalFindings.filter((c) => isActionable(c.finding));
  lines.push(`actionable な canonical finding（${actionableFindings.length}件）:`);
  for (const c of actionableFindings) {
    const loc = c.finding.line === null ? c.finding.file : `${c.finding.file}:${c.finding.line}`;
    lines.push(
      `  - [${c.finding_id}] ${sanitizeForDisplay(loc)} ${sanitizeForDisplay(c.finding.summary)}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** CLI `report` サブコマンドの本体。テストが CLI を経由せず直接呼べるよう export する。 */
export function runReport({ snapshotId = null, cwd = process.cwd() } = {}) {
  const snap = resolveSnapshot({ snapshotId, cwd });
  return formatReport(readAggregateOrThrow(snap));
}

export function optionalString(value) {
  return typeof value === 'string' ? value : null;
}

// `--flag` の直後が別の `--flag` または末尾だと、parseArgs はその flag を値なしの `true` として
// 格納する。それを「省略された」と同じ扱いにすると、値の付け忘れが黙って「既定値（最新
// snapshot 等）を使う」へ誤解釈される（`--input` に既に適用済みのチェックと同じクラスの事故）。
// 本当に省略された場合（`args[key] === undefined`）は `optionalString` の `null` のまま扱う。
export function requireStringFlagIfPresent(args, key) {
  if (args[key] === true) {
    throw new Error(`--${key} には値が必要です`);
  }
  // 空文字列（例: 未設定のシェル変数が展開されて空の argv トークンになった場合）を「省略」と
  // 同じ扱いにすると、`snapshotId ? ... : requireSnapshot(...)` のような truthy チェックが
  // 黙って最新 snapshot にフォールバックし、意図した値が無視されたことに気づけない。
  // snapshot id / angle / anchor-class が正当に空文字列であることはないため、ここで拒否する。
  if (args[key] === '') {
    throw new Error(`--${key} に空文字列は指定できません`);
  }
  return optionalString(args[key]);
}

// subcommand ごとに受け付ける flag 名の allowlist。`parseArgs`（review-plan.js。共有実装であり
// 本スクリプトからは変更しない）は `--flag=value` 形式を単一のキー `"flag=value"` として格納し、
// `args.flag` 自体は `undefined` のままになる。`--snapshot-id`（別スペル）・`--Snapshot`（大文字
// 小文字違い）・末尾の空白がフラグ名に融合したトークンも同様に、意図したキーとは異なる
// 「想定外のキー」を作る。これらはどれも「省略された」場合と区別が付かず、値の指定漏れと同じ
// 挙動（既定値への黙ったフォールバック、例: 最新 snapshot の使用）に誤解釈される。個々の
// 綴り違いパターンを検出するのではなく、subcommand が実際に受け付ける flag 名を allowlist で
// 閉じることで、この種の「`--` で始まるが認識されない flag」全体を早期に一括拒否する
// （review-metrics.js の main() と同じ straightforward・per-branch な検証方針。4 subcommand 分の
// Set 以上の抽象化は持たない）。en dash・em dash・全角ハイフン等の非ASCIIダッシュで始まる
// トークンや `--` を伴わない位置引数は、そもそも parseArgs 自身がその場で無視するため
// この allowlist（parseArgs の出力キーに対する検査）だけでは拒否できない —— それらは
// assertKnownArgs が parseArgs 呼び出しより前に生トークンを直接検査して拒否する
// （review-adversarial N1: 実行検証済み）。
const ALLOWED_FLAGS_BY_COMMAND = new Map([
  ['ingest', new Set(['snapshot', 'angle', 'anchor-class', 'input'])],
  ['aggregate', new Set(['snapshot'])],
  ['report', new Set(['snapshot'])],
  ['metrics', new Set(['snapshot', 'angle'])],
]);

export function assertKnownArgs(rest, allowedFlags) {
  let i = 0;
  while (i < rest.length) {
    const token = rest[i];
    // parseArgs は ASCII "--"（U+002D2つ）で始まらないトークンを黙って無視するため、
    // parseArgs の出力（キー名）だけを検査すると、非ASCIIダッシュ変種・位置引数がここへ
    // 一切現れず allowlist を素通りする（review-adversarial N1: 実行検証済み）。ここでは
    // 生トークンを直接検査し、"--" で始まらないトークンをその時点で拒否する。
    if (!token.startsWith('--')) {
      throw new Error(`認識できない引数です: ${JSON.stringify(token)}`);
    }
    const key = token.slice(2);
    if (!allowedFlags.has(key)) {
      throw new Error(`未知の flag です: --${key}`);
    }
    const next = rest[i + 1];
    // parseArgs と同じ「次トークンが無い、または "--" で始まるなら値なしフラグとして扱う」
    // 判定に合わせてトークン消費量を決める（値の妥当性自体は既存の
    // requireStringFlagIfPresent 等が別途検査する。ここでは「どのトークンも検査対象から
    // 漏れない」ことだけを保証する）。
    i += next === undefined || next.startsWith('--') ? 1 : 2;
  }
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  // 未知の flag・非ASCIIダッシュ変種・位置引数は、個々のサブコマンド分岐（--input 等）へ
  // 進む前に、ここで一括拒否する（どの他の flag が正しく指定されていても、認識されない
  // トークンがあれば早期に失敗させる）。
  const allowedFlags = ALLOWED_FLAGS_BY_COMMAND.get(cmd);
  if (allowedFlags) {
    assertKnownArgs(rest, allowedFlags);
  }
  const args = parseArgs(rest);
  const cwd = process.cwd();

  if (cmd === 'ingest') {
    // `--input` は値なしフラグを既定値へ黙って倒さない（review-metrics.js の --status と
    // 同じクラス: 付け忘れに気づけないまま「入力なし」を別の意味に誤解釈するのを避ける）。
    if (args.input === true || args.input === undefined) {
      throw new Error('--input には値（JSON ファイルパス）が必要です');
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(args.input, 'utf-8'));
    } catch (err) {
      throw new Error(`--input を JSON として読めません: ${err.message}`, { cause: err });
    }
    if (!Array.isArray(parsed)) {
      throw new Error('--input の内容は配列である必要があります');
    }
    const result = ingestFindings({
      snapshotId: requireStringFlagIfPresent(args, 'snapshot'),
      angle: requireStringFlagIfPresent(args, 'angle'),
      anchorClass: requireStringFlagIfPresent(args, 'anchor-class'),
      rawFindings: parsed,
      cwd,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    for (const detail of result.invalidDetails) {
      // finding_id 自体は採番した値だが、errors は不正な入力由来の値（例: 未知の
      // provenance.angle）をそのまま埋め込みうる。formatReport の summary/loc と同じ理由
      // （端末制御文字による行の偽装・端末誤動作の防止）で、表示直前に無害化する。
      const sanitizedId = sanitizeForDisplay(detail.finding_id);
      const sanitizedErrors = detail.errors.map((e) => sanitizeForDisplay(e)).join('; ');
      process.stderr.write(`${sanitizedId}: ${sanitizedErrors}\n`);
    }
    // 送信件数 > 0 なのに正規化件数が 0（--angle/--anchor-class の指定漏れ・誤り等で全件
    // invalid になった）場合、orchestrator が exit code だけを見て次工程（metrics 等）へ
    // 進んでしまわないよう、非ゼロ終了にする（review-adversarial N2: 実行検証済み）。
    // rawFindings が空配列（added === 0）の場合は「今回の reviewer は所見ゼロだった」という
    // 正当なケースであり、failure 扱いしない。process.exit() は呼ばない —— 同期処理が
    // 完了した後、自然にプロセスが終了し stdout/stderr が flush されるようにするため。
    if (result.added > 0 && result.normalized === 0) {
      process.stderr.write(
        '警告: 送信した finding が1件も正規化されませんでした（全件 invalid）。' +
          '--angle / --anchor-class の指定漏れ・誤りの可能性があります。\n',
      );
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === 'aggregate') {
    const result = runAggregate({ snapshotId: requireStringFlagIfPresent(args, 'snapshot'), cwd });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (cmd === 'report') {
    process.stdout.write(
      runReport({ snapshotId: requireStringFlagIfPresent(args, 'snapshot'), cwd }),
    );
    return;
  }

  if (cmd === 'metrics') {
    const result = buildMetricsFlags({
      snapshotId: requireStringFlagIfPresent(args, 'snapshot'),
      angle: requireStringFlagIfPresent(args, 'angle'),
      cwd,
    });
    process.stdout.write(
      `valid Med+: ${result.validMedPlus} / unique valid Med+: ${result.uniqueValidMedPlus} / ` +
        `duplicate cluster participation: ${result.duplicateClusterParticipation}\n` +
        `review-metrics.js record 用: ${result.flagString}\n`,
    );
    return;
  }

  process.stderr.write('usage: review-findings.js <ingest|aggregate|report|metrics> [options]\n');
  process.exit(1);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  /(^|[/\\])review-findings\.js$/.test(process.argv[1])
) {
  main();
}
