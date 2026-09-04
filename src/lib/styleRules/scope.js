import { SCOPE } from './types';

const OPEN_BRACKETS = '「『';
const CLOSE_BRACKETS = '」』';

export function getDialogueRanges(text) {
  const ranges = [];
  let activeOpenIdx = -1;
  let startIdx = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\u2029') {
      // 段落境界（U+2029）のみリセット。hardBreak（\n）は会話範囲を維持する
      activeOpenIdx = -1;
      startIdx = -1;
      continue;
    }
    if (activeOpenIdx === -1) {
      const openIdx = OPEN_BRACKETS.indexOf(text[i]);
      if (openIdx !== -1) {
        activeOpenIdx = openIdx;
        startIdx = i;
      }
    } else if (text[i] === CLOSE_BRACKETS[activeOpenIdx]) {
      ranges.push({ start: startIdx, end: i + 1 });
      activeOpenIdx = -1;
      startIdx = -1;
    }
  }
  return ranges;
}

function overlapsAnyRange(from, to, ranges) {
  return ranges.some((r) => from < r.end && to > r.start);
}

function isInsideAnyRange(from, to, ranges) {
  return ranges.some((r) => from >= r.start && to <= r.end);
}

export function filterByScope(matches, text, scope) {
  if (scope === SCOPE.ALL) return matches;
  const ranges = getDialogueRanges(text);
  if (scope === SCOPE.OUTSIDE_DIALOGUE) {
    return matches.filter((m) => !overlapsAnyRange(m.from, m.to, ranges));
  }
  if (scope === SCOPE.DIALOGUE_ONLY) {
    return matches.filter((m) => isInsideAnyRange(m.from, m.to, ranges));
  }
  return matches;
}
