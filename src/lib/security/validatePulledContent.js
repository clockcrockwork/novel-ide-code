import { detectInvisibleChars, SEVERITY } from './unicodeSafety.js';
import { sanitizeFileName } from './validateSafeFileName.js';

// GitHub から pull した EXTERNAL データ（本文・ファイル名）の検証。
// 設計: docs/security/github-boundary.md §5。preview / エディタの前段で配線する。
// 純関数（React / toast を含まない）。呼び出し側が decision を UX にマップする。

// 既存の編集系上限（AppContext FILE_CONTENT_MAX）と揃える。専用閾値は設けない。
export const FILE_CONTENT_MAX = 5_000_000;
// GitHub contents API の 1MB 上限に合わせた警告閾値（sync 経路には API 上限がないため有効）。
export const OVERSIZE_WARN_CHARS = 1_000_000;
const NAME_MAX = 100; // not-a-threshold（ファイル名の最大長。UI 表示上の上限）

// バイナリ判定は先頭サンプルのみ走査して巨大入力での DoS を避ける。
const BINARY_SAMPLE_LIMIT = 65536;
const BINARY_CONTROL_RATIO = 0.1;
const BINARY_MIN_SUSPICIOUS = 4; // not-a-threshold（短文での誤検知防止の絶対下限）

/**
 * テキストかバイナリかを軽量ヒューリスティックで判定する。
 * 1. null byte (U+0000) を含めばバイナリ。
 * 2. C0 制御文字（tab/LF/CR 除く）＋ U+FFFD の比率が 10% 超 かつ
 *    絶対数が下限以上ならバイナリ（base64→UTF-8 で誤デコードしたバイナリを捕捉）。
 *    短文で制御文字 1 個だけで比率超過 → 誤判定するのを下限で防ぐ。
 * 先頭 64K code unit のみ走査する。
 *
 * @param {string} content
 * @returns {boolean}
 */
export function detectBinary(content) {
  if (typeof content !== 'string' || content.length === 0) return false;
  const limit = Math.min(content.length, BINARY_SAMPLE_LIMIT);
  let suspicious = 0;
  for (let i = 0; i < limit; i++) {
    const cp = content.charCodeAt(i);
    if (cp === 0x00) return true;
    if (cp === 0xfffd) {
      suspicious++;
      continue;
    }
    if (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) suspicious++;
  }
  return suspicious >= BINARY_MIN_SUSPICIOUS && suspicious / limit > BINARY_CONTROL_RATIO;
}

// sanitizeClipboard.js の集計パターンと同等（export されていないため複製）。
function aggregateWarnFindings(findings) {
  const counts = new Map();
  for (const f of findings) {
    if (f.severity !== SEVERITY.WARN) continue;
    counts.set(f.label, (counts.get(f.label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => ({ label, count }));
}

/**
 * pull した本文・ファイル名を検証する。
 *
 * @param {string} content
 * @param {string} name
 * @returns {{
 *   isBinary: boolean, tooLarge: boolean, oversizeWarn: boolean,
 *   safeName: string, nameChanged: boolean,
 *   hasDeny: boolean, denyFindings: object[],
 *   warnSummary: string|null, decision: 'allow'|'warn'|'deny'
 * }}
 */
export function validatePulledContent(content, name) {
  // remote の content は EXTERNAL。非文字列（壊れた JSON 等）は deny し、downstream の
  // content.length / plainTextToPmJson クラッシュを防ぐ。
  const invalidType = typeof content !== 'string';
  const text = invalidType ? '' : content;
  const tooLarge = text.length > FILE_CONTENT_MAX;
  // サイズ超過時は走査を省く（短絡）。binary 判定はサンプル限定なので tooLarge でなければ実行。
  const isBinary = !tooLarge && detectBinary(text);

  const safeName = sanitizeFileName(name, NAME_MAX) || 'ファイル.md';
  // 非文字列（undefined/null）はデフォルトへフォールバックするため変更扱いにする。
  const nameChanged = typeof name !== 'string' || safeName !== name;

  // deny 確定（サイズ / バイナリ）なら O(n) の全文走査をスキップする。
  let hasDeny = false;
  let denyFindings = [];
  let warnFindings = [];
  if (!invalidType && !tooLarge && !isBinary) {
    const findings = detectInvisibleChars(text);
    denyFindings = findings.filter((f) => f.severity === SEVERITY.DENY);
    hasDeny = denyFindings.length > 0;
    warnFindings = aggregateWarnFindings(findings);
  }
  const denyLabels = [...new Set(denyFindings.map((f) => f.label))];

  const oversizeWarn = !tooLarge && text.length > OVERSIZE_WARN_CHARS;
  const warnSummary = warnFindings.length
    ? warnFindings.map((w) => `${w.label} ×${w.count}`).join('、')
    : null;

  // 拒否は binary / 巨大 / 不正な型のみ。Bidi・不可視文字は warn として開けるようにし、
  // UI 側で警告する（#285 の方針: 可視化・警告。可視化/修正提案 UI は follow-up）。
  let decision = 'allow';
  if (invalidType || tooLarge || isBinary) decision = 'deny';
  else if (hasDeny || oversizeWarn || warnSummary || nameChanged) decision = 'warn';

  return {
    invalidType,
    isBinary,
    tooLarge,
    oversizeWarn,
    safeName,
    nameChanged,
    hasDeny,
    denyFindings,
    denyLabels,
    warnSummary,
    decision,
  };
}

/** deny 時にユーザーへ表示する理由文（日本語）。 */
export function pullDenyReason(result) {
  if (result.invalidType) return '不正な形式のファイルのため開けません（テキストではありません）';
  if (result.tooLarge) return 'ファイルが大きすぎて開けません（上限: 500万文字）';
  if (result.isBinary) return 'バイナリファイルのため開けません（テキストファイルのみ対応）';
  return '開けないファイルです';
}

/**
 * pull 時に 1 回だけ走査した検証結果を、ファイルに永続化する compact なレコードに変換する。
 * preview / エディタ / export はこのメタデータを参照し、本文を再走査しない（#285）。
 */
export function toSecurityRecord(result) {
  return {
    decision: result.decision,
    isBinary: result.isBinary,
    tooLarge: result.tooLarge,
    oversizeWarn: result.oversizeWarn,
    hasDeny: result.hasDeny,
    denyReason: result.decision === 'deny' ? pullDenyReason(result) : null,
  };
}

// deny 判定（binary / oversize / 非文字列）のファイルは active な編集リストに載せず
// IDB に quarantine として保持する（#291）。warn（Bidi/不可視文字）は対象外。
export function isQuarantined(file) {
  return file?.security?.decision === 'deny';
}

/**
 * エディタ編集後の findings から security レコードを再計算する（#291 Task 3）。
 * UnicodeSafetyExtension のプラグイン state に保持済みの ranges を使うため追加 O(n) 走査なし。
 *
 * - originalSecurity が null/undefined: 返値 null（pull 時の記録なし、スキップ）
 * - isBinary: quarantine 済みで編集不可のため元の record をそのまま返す
 * - in-editor の deny 文字: decision:'deny' にしない（ロックアウト防止）。hasDeny:true で
 *   InvisibleCharMod の「危険な制御文字を除去」ボタンを有効化し、ユーザーが修正できる状態にする。
 */
export function deriveEditedSecurity(ranges, originalSecurity, contentLength) {
  if (!originalSecurity) return null;
  if (originalSecurity.isBinary) return originalSecurity;

  const hasDeny = ranges.some((r) => r.severity === SEVERITY.DENY);
  const hasWarn = ranges.some((r) => r.severity === SEVERITY.WARN);
  const tooLarge = contentLength > FILE_CONTENT_MAX;
  const oversizeWarn = !tooLarge && contentLength > OVERSIZE_WARN_CHARS;
  const decision = hasWarn || hasDeny || tooLarge ? 'warn' : 'allow';
  if (
    originalSecurity.decision === decision &&
    originalSecurity.tooLarge === tooLarge &&
    originalSecurity.oversizeWarn === oversizeWarn &&
    originalSecurity.hasDeny === hasDeny &&
    (originalSecurity.denyReason ?? null) === null
  ) {
    return originalSecurity;
  }
  return { decision, isBinary: false, tooLarge, oversizeWarn, hasDeny, denyReason: null };
}

/** warn 時の toast メッセージ（該当なしは空文字）。 */
export function pullWarnMessage(result) {
  const parts = [];
  if (result.nameChanged) parts.push('ファイル名を安全な形式に修正しました');
  if (result.oversizeWarn) parts.push('サイズの大きいファイルです');
  if (result.hasDeny && result.denyLabels?.length)
    parts.push(`危険な制御文字を検出: ${result.denyLabels.join('、')}`);
  if (result.warnSummary) parts.push(`不可視文字を検出: ${result.warnSummary}`);
  return parts.join(' / ');
}
