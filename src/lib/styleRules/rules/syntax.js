import { CATEGORY, SEVERITY, SCOPE } from '../types';

export const syntaxRules = [
  {
    id: 'syntax/unmatched-bracket',
    category: CATEGORY.SYNTAX,
    severity: SEVERITY.WARNING,
    scope: SCOPE.ALL,
    label: '括弧の不対称（「」『』）',
    defaultEnabled: true,
    check(text) {
      const results = [];
      const pairs = [['「', '」'], ['『', '』']];
      for (const [open, close] of pairs) {
        let stack = [];
        for (let i = 0; i < text.length; i++) {
          if (text[i] === '\u2029') {
            for (const idx of stack) {
              results.push({ from: idx, to: idx + 1, text: open });
            }
            stack = [];
            continue;
          }
          if (text[i] === open) {
            stack.push(i);
          } else if (text[i] === close) {
            if (stack.length === 0) {
              results.push({ from: i, to: i + 1, text: close });
            } else {
              stack.pop();
            }
          }
        }
        for (const idx of stack) {
          results.push({ from: idx, to: idx + 1, text: open });
        }
      }
      return results.sort((a, b) => a.from - b.from);
    },
  },
];
