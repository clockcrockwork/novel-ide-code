import {
  validateGitHubWritePath,
  hasForbiddenPkgSegment,
} from '../security/validateGitHubWritePath.js';

// rootPath 用に拒否する Unicode カテゴリ deny-list（#478。u フラグ）。列挙式からカテゴリベースへ移行し
// homograph/不可視の網羅漏れ（whack-a-mole）を解消:
//  \p{Cc}=制御(C0/C1/DEL)・\p{Cf}=format(ZWSP/ZWNJ/ZWJ/WordJoiner/SHY/BOM/Bidi 等)・\p{Cs}=孤立サロゲート・
//  \p{Co}=私用領域・\p{Zl}/\p{Zp}=行/段落区切り・\p{Default_Ignorable_Code_Point}=VS/U+3164/U+115F 等・
//  末尾の明示コードポイント=\p{Zs} から通常スペース(U+0020)を除いた空白 homograph（NBSP/全角スペース/en-quad 系）。
// ASCII スペース(U+0020)のみ許容（設計判断 #478）。\p{Cs}/u は孤立サロゲートのみ検出し、正当な
// 単一コードポイントの astral（emoji・CJK 拡張B）は許容する。ただし ZWJ/VS/tag で合成した emoji 列
// （family 絵文字・キーキャップ・地域旗等）は連結子 ZWJ(\p{Cf})・VS(\p{Default_Ignorable_Code_Point}) が
// 拒否対象のため列全体が拒否される（連結子自体が spoofing ベクターのため意図的）。
// v フラグ(set 減算)は Safari17+ 必須・browserslist 未設定のため使わず、Zs の許容除外分を明示列挙する
// （\p{Zs} は Unicode で稀にしか増えない安定集合。増加時は \p{Zs} 被覆テストが検出）。
// 残る限界（対象外）: mixed-script homograph（Cyrillic а vs Latin a 等、文字クラスで判別不能）、
// blank レンダリングだがカテゴリ外の記号（U+2800 BRAILLE BLANK 等の \p{So}）、および client/worker が
// 別エンジン（ブラウザ ↔ Cloudflare V8）で動く場合の Unicode 版差による受理集合の理論的乖離。詳細は
// docs/security/TRUST-BOUNDARY.md。
// worker 側 validation.ts の ROOTPATH_FORBIDDEN_CHAR_RE と source/flags を一致させる（parity テストが機械検査。
// unicodeSafety.js の INVISIBLE_WARN および \p{Zs}（U+0020 除く）の被覆も別途機械検査する）。
export const ROOTPATH_FORBIDDEN_CHAR_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/u;

// GitHub repo 内のディレクトリプレフィックスとして使える rootPath 相当の文字列を検証する。
// validateGitHubWritePath より厳格：先頭・末尾スラッシュ禁止、URL メタ文字禁止。
export function validateWorkspaceRootPath(path) {
  if (typeof path !== 'string') return { ok: false, reason: 'パスが文字列ではありません' };
  if (path.length === 0) return { ok: false, reason: 'パスが空です' };
  if (path.length > 256) return { ok: false, reason: 'パスが長すぎます（上限: 256文字）' };

  if (path.includes('%2F') || path.includes('%2f')) {
    return { ok: false, reason: 'パスに URL エンコードされたスラッシュが含まれています' };
  }
  if (path.includes('?') || path.includes('#')) {
    return { ok: false, reason: 'パスに URL メタ文字（? #）が含まれています' };
  }
  if (path.startsWith('/') || path.endsWith('/')) {
    return { ok: false, reason: 'パスの先頭・末尾にスラッシュは使用できません' };
  }
  if (ROOTPATH_FORBIDDEN_CHAR_RE.test(path)) {
    return { ok: false, reason: 'パスに制御・不可視文字や空白 homograph（NBSP・全角スペース等）が含まれています' };
  }

  const baseResult = validateGitHubWritePath(path);
  if (!baseResult.ok) return baseResult;

  // rootPath 用途はディレクトリプレフィックスなので、書き込みパス用途では許可される
  // サブディレクトリ配下のパッケージ管理ファイル名も禁止する（worker 側と受理集合を一致。#469）。
  // 上の validateGitHubWritePath（機微セグメント）との合成で worker 単一ヘルパーと同じ受理集合になる
  if (hasForbiddenPkgSegment(path)) {
    return { ok: false, reason: 'ルートパスにパッケージ管理ファイル名を含めることはできません' };
  }

  return { ok: true };
}

export function validateWorkId(id) {
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
    return { ok: false, reason: '無効な workId です' };
  }
  return { ok: true };
}

export function validateCustomFieldKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > 64) {
    return { ok: false, reason: '無効なフィールドキーです（1〜64文字）' };
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
    return {
      ok: false,
      reason: 'フィールドキーは英数字・アンダースコア・ハイフンのみ使用できます',
    };
  }
  return { ok: true };
}

const VALID_CUSTOM_FIELD_TYPES = [
  'text',
  'number',
  'boolean',
  'date',
  'url',
  'select',
  'multi-select',
];

export function validateCustomFieldDefinition(def) {
  if (!def || typeof def !== 'object') return { ok: false, reason: 'フィールド定義が無効です' };

  const keyResult = validateCustomFieldKey(def.key);
  if (!keyResult.ok) return keyResult;

  if (typeof def.label !== 'string' || def.label.length === 0 || def.label.length > 100) {
    return { ok: false, reason: 'フィールドラベルは1〜100文字にしてください' };
  }
  if (!VALID_CUSTOM_FIELD_TYPES.includes(def.type)) {
    return { ok: false, reason: `フィールドタイプが無効です: ${def.type}` };
  }
  if ((def.type === 'select' || def.type === 'multi-select') && !Array.isArray(def.options)) {
    return { ok: false, reason: 'select / multi-select には options 配列が必要です' };
  }
  if (Array.isArray(def.options)) {
    for (const opt of def.options) {
      if (typeof opt !== 'string' || opt.length === 0 || opt.length > 200) {
        return { ok: false, reason: '選択肢は1〜200文字の文字列にしてください' };
      }
    }
    if (def.options.length > 200) {
      return { ok: false, reason: '選択肢は200件以下にしてください' };
    }
  }
  return { ok: true };
}
