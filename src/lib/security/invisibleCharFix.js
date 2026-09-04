import { detectInvisibleChars, SEVERITY } from './unicodeSafety.js';

// NBSP は除去すると前後の語が連結してしまうため半角スペースへ正規化する。
// それ以外の対象（Bidi / null / zero-width / soft-hyphen / BOM / 制御文字）は除去する。
const NORMALIZE_TO_SPACE = 0x00a0;

// detectInvisibleChars の結果を severity × label で集計する。
export function summarizeFindings(text) {
  const findings = detectInvisibleChars(text);
  const denyMap = new Map();
  const warnMap = new Map();
  for (const f of findings) {
    const map =
      f.severity === SEVERITY.DENY ? denyMap : f.severity === SEVERITY.WARN ? warnMap : null;
    if (!map) continue;
    map.set(f.label, (map.get(f.label) ?? 0) + 1);
  }
  const toList = (m) => [...m.entries()].map(([label, count]) => ({ label, count }));
  const deny = toList(denyMap);
  const warn = toList(warnMap);
  return {
    deny,
    warn,
    denyTotal: deny.reduce((s, x) => s + x.count, 0),
    warnTotal: warn.reduce((s, x) => s + x.count, 0),
  };
}

// severities（例: ['deny'] / ['warn']）に該当する不可視/制御文字を除去・正規化する。
// combining run の集約 finding（codePoint < 0）は単一 index 除去では不正確なため対象外。
export function fixInvisibleChars(text, severities) {
  if (typeof text !== 'string') return { text: '', fixed: 0 };
  const wanted = new Set(severities);
  const policy = new Map();
  for (const f of detectInvisibleChars(text)) {
    if (!wanted.has(f.severity) || f.codePoint < 0) continue;
    policy.set(f.index, f.codePoint === NORMALIZE_TO_SPACE ? ' ' : '');
  }
  if (policy.size === 0) return { text, fixed: 0 };

  let out = '';
  let fixed = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i);
    const len = cp > 0xffff ? 2 : 1;
    if (policy.has(i)) {
      out += policy.get(i);
      fixed++;
    } else {
      out += text.slice(i, i + len);
    }
    i += len;
  }
  return { text: out, fixed };
}
