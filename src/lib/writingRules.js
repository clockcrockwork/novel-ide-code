export const DEFAULT_RULES = [
  {
    id: 'indent',
    label: '行頭全角スペース',
    desc: '段落先頭に「　」を自動付加（見出し・コメント行を除く）',
    enabled: false,
  },
  {
    id: 'rm_dbl_sp',
    label: '連続全角スペース除去',
    desc: '「　　」以上の連続全角スペースを「　」に整理',
    enabled: false,
  },
  {
    id: 'bracket_sp',
    label: '括弧前後のスペース除去',
    desc: '「( 文字 )」など括弧の内側スペースを削除',
    enabled: false,
  },
];

export function applyWritingRules(text, rules) {
  let t = text;
  rules.forEach((r) => {
    if (!r.enabled) return;
    if (r.id === 'indent') {
      t = t
        .split('\n')
        .map((line) => {
          if (!line.trim()) return line;
          if (/^[#/\-\s　*>]/.test(line)) return line;
          if (line.startsWith('　')) return line;
          return '　' + line;
        })
        .join('\n');
    }
    if (r.id === 'rm_dbl_sp') t = t.replace(/　{2,}/g, '　');
    if (r.id === 'bracket_sp') {
      t = t.replace(/([（「『【〔｛(])[^\S\n]+/g, '$1').replace(/[^\S\n]+([）」』】〕｝)])/g, '$1');
    }
  });
  return t;
}
