import { CATEGORY, SEVERITY, SCOPE } from '../types';

function regexMatches(text, re, toMatch) {
  if (!re.global) throw new Error(`regexMatches: g フラグが必要です: ${re}`);
  const results = [];
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    const matched = m[0];
    results.push({
      from: m.index,
      to: m.index + matched.length,
      text: matched,
      suggestion: toMatch ? toMatch(m) : undefined,
    });
  }
  return results;
}

export const notationRules = [
  {
    id: 'notation/punct-repeat',
    category: CATEGORY.NOTATION,
    severity: SEVERITY.WARNING,
    scope: SCOPE.ALL,
    label: '読点・句点の連続',
    defaultEnabled: true,
    check(text) {
      return regexMatches(text, /([、。，．])\1+/g);
    },
  },
  {
    id: 'notation/ellipsis',
    category: CATEGORY.NOTATION,
    severity: SEVERITY.SUGGESTION,
    scope: SCOPE.ALL,
    label: '三点リーダー（…）の使用を推奨',
    defaultEnabled: true,
    check(text) {
      return regexMatches(text, /\.{3}|。。。/g, () => '…');
    },
  },
  {
    id: 'notation/dash',
    category: CATEGORY.NOTATION,
    severity: SEVERITY.SUGGESTION,
    scope: SCOPE.ALL,
    label: 'ダッシュ（——）の使用を推奨',
    defaultEnabled: true,
    check(text) {
      return regexMatches(text, /--/g, () => '——');
    },
  },
];
