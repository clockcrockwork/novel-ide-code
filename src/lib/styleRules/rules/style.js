import { CATEGORY, SEVERITY, SCOPE } from '../types';
import { getParagraphOffsets } from '../utils';

const LONG_SENTENCE_THRESHOLD = 120;

export const styleRules = [
  {
    id: 'style/long-sentence',
    category: CATEGORY.STYLE,
    severity: SEVERITY.SUGGESTION,
    scope: SCOPE.OUTSIDE_DIALOGUE,
    label: `一段落が${LONG_SENTENCE_THRESHOLD}字を超えています`,
    defaultEnabled: false,
    check(text) {
      const results = [];
      for (const { text: line, offset } of getParagraphOffsets(text)) {
        const stripped = line.replace(/^[#*\s]+/, '');
        if (stripped.length > LONG_SENTENCE_THRESHOLD) {
          const leadOffset = line.length - stripped.length;
          results.push({
            from: offset + leadOffset,
            to: offset + line.length,
            text: stripped.slice(0, 20) + '…',
          });
        }
      }
      return results;
    },
  },
  {
    id: 'style/repeated-particle',
    category: CATEGORY.STYLE,
    severity: SEVERITY.SUGGESTION,
    scope: SCOPE.OUTSIDE_DIALOGUE,
    label: '同一助詞の連続',
    defaultEnabled: false,
    check(text) {
      const results = [];
      // が・を・に・は・も の連続（同じ助詞が 2 回以上）
      const re = /(が|を|に|は|も)[^。？！?!\n\u2029]{0,20}?\1/g;
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(text)) !== null) {
        results.push({ from: m.index, to: m.index + m[0].length, text: m[0] });
        re.lastIndex = m.index + 1;
      }
      return results;
    },
  },
];
