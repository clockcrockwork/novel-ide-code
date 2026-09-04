import { detectInvisibleChars } from './unicodeSafety.js';

const SAFE_SCHEME_RE = /^https?:\/\//i;

// null = OK、文字列 = エラー理由
export function validateUrl(value) {
  if (typeof value !== 'string') return 'not a string';
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'empty';
  if (trimmed.length > 2000) return 'too long';
  if (!SAFE_SCHEME_RE.test(trimmed)) return 'unsafe scheme';
  if (/[\t\r\n]/.test(trimmed)) return 'control char';
  if (trimmed.includes('\\')) return 'backslash';
  if (detectInvisibleChars(trimmed).length > 0) return 'dangerous unicode';
  try {
    const parsed = new URL(trimmed);
    if (!parsed.hostname) return 'invalid host';
  } catch {
    return 'invalid url';
  }
  return null;
}

// export 用: 無効なら undefined、有効なら正規化済み URL を返す
export function sanitizeUrlForExport(value) {
  if (validateUrl(value) !== null) return undefined;
  try {
    return new URL(value.trim()).href;
  } catch {
    return undefined;
  }
}

// href / img src に EXTERNAL な URL（GitHub API 由来の html_url / avatar_url 等）を
// 使う前の検証（audit M2）。https/http のみ許可し、不正なら undefined を返す。
// undefined を href/src に渡すと React は属性を出力しないため、危険スキーム
// （javascript: 等）が DOM に載らない。表示用途のため export と違い元 URL を維持する。
export function safeExternalHref(value) {
  return validateUrl(value) === null ? value.trim() : undefined;
}
