import { CATEGORY, SEVERITY, SCOPE } from '../types';
import { getParagraphOffsets } from '../utils';

// 行頭禁則文字（JIS X 4051 準拠の主要なもの）
const LINE_START_FORBIDDEN = /^[、。，．・：；？！）］｝〕〉》」』】〗〙〛ぁぃぅぇぉっゃゅょゎゝゞァィゥェォッャュョヮヵヶヽヾ々ー]/;
// 行末禁則文字
const LINE_END_FORBIDDEN = /[（［｛〔〈《「『【〖〘〚]$/;

export const kinsokuRules = [
  {
    id: 'kinsoku/line-start',
    category: CATEGORY.KINSOKU,
    severity: SEVERITY.SUGGESTION,
    scope: SCOPE.ALL,
    label: '行頭禁則候補',
    defaultEnabled: true,
    check(text) {
      const results = [];
      for (const { text: line, offset } of getParagraphOffsets(text)) {
        const stripped = line.replace(/^[#\s]+/, '');
        const leadOffset = line.length - stripped.length;
        if (LINE_START_FORBIDDEN.test(stripped)) {
          const charOffset = offset + leadOffset;
          results.push({ from: charOffset, to: charOffset + 1, text: stripped[0] });
        }
      }
      return results;
    },
  },
  {
    id: 'kinsoku/line-end',
    category: CATEGORY.KINSOKU,
    severity: SEVERITY.SUGGESTION,
    scope: SCOPE.ALL,
    label: '行末禁則候補',
    defaultEnabled: true,
    check(text) {
      const results = [];
      for (const { text: line, offset } of getParagraphOffsets(text)) {
        const stripped = line.trimEnd();
        if (LINE_END_FORBIDDEN.test(stripped)) {
          const charOffset = offset + stripped.length - 1;
          results.push({ from: charOffset, to: charOffset + 1, text: stripped[stripped.length - 1] });
        }
      }
      return results;
    },
  },
];
