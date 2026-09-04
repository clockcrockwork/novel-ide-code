import { filterByScope } from './scope';
import { docToLinesText } from './utils';
import { notationRules } from './rules/notation';
import { syntaxRules } from './rules/syntax';
import { kinsokuRules } from './rules/kinsoku';
import { styleRules } from './rules/style';

export { SEVERITY, CATEGORY, SCOPE } from './types';

export const ALL_RULES = [...notationRules, ...syntaxRules, ...kinsokuRules, ...styleRules];

export function runStyleChecks(doc, enabledRuleIds) {
  const { text, toPmPos } = docToLinesText(doc);
  const results = [];
  for (const rule of ALL_RULES) {
    if (!enabledRuleIds.includes(rule.id)) continue;
    const matches = rule.check(text);
    const filtered = filterByScope(matches, text, rule.scope);
    for (const m of filtered) {
      const from = toPmPos(m.from);
      const to = toPmPos(m.to);
      if (from == null || to == null || from >= to) continue;
      results.push({
        ruleId: rule.id,
        category: rule.category,
        severity: rule.severity,
        message: rule.label,
        from,
        to,
        text: m.text,
        suggestion: m.suggestion,
      });
    }
  }
  return results;
}
