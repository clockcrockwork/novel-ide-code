import { detectInvisibleChars, SEVERITY } from './unicodeSafety.js';

// null = OK、文字列 = エラー理由
export function validateCommitMessage(template) {
  if (typeof template !== 'string') return 'not a string';
  if (template.length > 500) return 'too long';
  if (template.includes('\x00')) return 'null byte';
  if (/[\r\n]/.test(template)) return 'newline';
  const findings = detectInvisibleChars(template);
  if (findings.some((f) => f.severity === SEVERITY.DENY)) return 'dangerous unicode';
  if (
    findings.some(
      (f) =>
        f.severity === SEVERITY.WARN && (f.label.startsWith('Control') || f.label === 'Delete'),
    )
  )
    return 'control char';
  return null;
}
