// verifier sidecar が返す生の verification 結果を、agent-commons 契約
// （REVIEW_VERIFICATION_SCHEMA / VERIFICATION_VERDICTS）に沿って検証し、正規化済みの
// verification result オブジェクトへ変換する。review-findings-normalize.js と同じ方針:
//
//   - 純粋関数のみを export する（fs / CLI 副作用を持たない）
//   - 語彙（verdict enum・schema 形状）は review-finding-contract.js からのみ import し、
//     このファイル自身では列挙値をハードコードしない
//   - 検証済みフィールドを個別に列挙して組み立てる（動的キー代入をしない。__proto__ 等の
//     プロトタイプ汚染を構造的に防ぐ）
//
// このモジュールが判定するのは**形状**（schema 適合・verdict enum・evidence の非空性）だけ。
// 「evidence の locator が本当に該当 finding と関係あるか」「rationale が本当に妥当か」といった
// **意味**の正しさは判定しない（issue #648: 意味の正しさの検証は adversarial review / 人間裁定に
// 残す）。finding_id が対象 finding と一致するか・snapshot に紐づくか（binding）も、ここでは
// 判定しない — それは review-finding-verifier.js の責務（対象解決・鮮度検証は finding 単位の
// 文脈が要るため、finding_id 形式だけを見るこのモジュールには持たせない）。
//
// evidence source/locator/detail は「具体的な根拠」を要求する契約上の最低限として、trim 後も
// 非空であることを要求する（空白のみの文字列で埋めた schema-valid だが無内容な evidence を
// 弾くため）。同じ理由で rationale も trim 後の非空を要求する。

import { REVIEW_VERIFICATION_SCHEMA, VERIFICATION_VERDICTS } from './review-finding-contract.js';
import { MAX_SERIALIZED_CHARS } from './review-findings-normalize.js';

const ALLOWED_TOP_LEVEL_KEYS = new Set(Object.keys(REVIEW_VERIFICATION_SCHEMA.properties));
const evidenceItemSchema = REVIEW_VERIFICATION_SCHEMA.properties.evidence.items;
const ALLOWED_EVIDENCE_KEYS = new Set(Object.keys(evidenceItemSchema.properties));

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyAfterTrim(value) {
  return typeof value === 'string' && value.trim().length >= 1;
}

function validateEvidenceItem(raw, index, errors) {
  if (!isPlainObject(raw)) {
    errors.push(`evidence[${index}] は object である必要があります`);
    return null;
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_EVIDENCE_KEYS.has(key)) {
      errors.push(`evidence[${index}]: 未知のフィールドです: ${key}`);
    }
  }
  let ok = true;
  for (const field of ['source', 'locator', 'detail']) {
    if (!isNonEmptyAfterTrim(raw[field])) {
      errors.push(`evidence[${index}].${field} は非空文字列である必要があります`);
      ok = false;
    }
  }
  if (!ok) return null;
  return { source: raw.source, locator: raw.locator, detail: raw.detail };
}

/**
 * 生 verification 結果（verifier の raw 出力）を検証し、正規化済み verification result へ
 * 変換する。データ形状の問題では throw しない（常に `{status:'invalid', errors}` を返す）。
 *
 * 呼び出し側は evidence 未検証の raw をそのまま schema-valid として扱ってはいけない
 * （critical safety invariant: 未検証の raw response は authoritative ではない）。
 */
export function validateAndNormalizeVerification(raw) {
  if (!isPlainObject(raw)) {
    return { status: 'invalid', errors: ['verification result は object である必要があります'] };
  }

  const errors = [];

  for (const key of Object.keys(raw)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      errors.push(`未知のフィールドです: ${key}`);
    }
  }

  if (typeof raw.finding_id !== 'string' || raw.finding_id.length < 1) {
    errors.push('finding_id は非空文字列である必要があります');
  }
  if (!VERIFICATION_VERDICTS.includes(raw.verdict)) {
    errors.push(`verdict は次のいずれかである必要があります: ${VERIFICATION_VERDICTS.join(' / ')}`);
  }
  if (!isNonEmptyAfterTrim(raw.rationale)) {
    errors.push('rationale は非空文字列である必要があります');
  }

  let evidence;
  if (!Array.isArray(raw.evidence) || raw.evidence.length < 1) {
    errors.push('evidence は要素数1以上の配列である必要があります（具体的な根拠locatorが必須）');
  } else {
    const items = [];
    let evidenceOk = true;
    raw.evidence.forEach((item, index) => {
      const validated = validateEvidenceItem(item, index, errors);
      if (validated === null) evidenceOk = false;
      else items.push(validated);
    });
    if (evidenceOk) evidence = items;
  }

  // 全体の直列化後サイズを見る（review-findings-normalize.js の angle_fields と同じ思想:
  // 巨大な rationale / evidence 文字列で artifact を無制限に肥大化させる敵対的入力を防ぐ）。
  // 個々のフィールド検証が通っていても、ここで超過していれば invalid にする。
  let serialized;
  try {
    serialized = JSON.stringify(raw);
  } catch {
    errors.push('verification result を直列化できません（深すぎるか循環参照を含みます）');
  }
  if (serialized !== undefined && serialized.length > MAX_SERIALIZED_CHARS) {
    errors.push(`verification result が大きすぎます（上限 ${MAX_SERIALIZED_CHARS} 文字）`);
  }

  if (errors.length > 0) {
    return { status: 'invalid', errors };
  }

  return {
    status: 'valid',
    result: {
      finding_id: raw.finding_id,
      verdict: raw.verdict,
      rationale: raw.rationale,
      evidence,
    },
  };
}
