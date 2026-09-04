export { default as WritingRulesExtension } from './WritingRulesExtension';
export { default as SlashCommentExtension } from './SlashCommentExtension';
export { default as CommentParagraphExtension } from './CommentParagraphExtension';
export { default as InlineCommentMark } from './InlineCommentMark';
export { default as RubyNode } from './RubyMark';
export { AnnotationExtension, annotationPluginKey } from './AnnotationExtension';
export {
  default as UnicodeSafetyExtension,
  unicodeSafetyPluginKey,
  collectFindingRanges,
} from './UnicodeSafetyExtension';
export { StyleCheckExtension, styleCheckPluginKey } from './StyleCheckExtension';
export { serializeToText } from './textSerializer';
export { plainTextToPmJson, rawTextToPmJson, migrateCommentSyntax } from './plainTextLoader';

export function textOffsetToPmPos(doc, offset) {
  let seen = 0,
    found = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.isText) {
      if (seen + node.text.length >= offset) {
        found = pos + (offset - seen);
        return false;
      }
      seen += node.text.length;
    }
  });
  return found;
}

export function findNthOccurrencePmPos(doc, text, n) {
  if (!text) return null;
  const fullText = doc.textContent;
  let count = 0,
    searchFrom = 0;
  while (true) {
    const idx = fullText.indexOf(text, searchFrom);
    if (idx === -1) return null;
    if (count === n) {
      const from = textOffsetToPmPos(doc, idx);
      const to = textOffsetToPmPos(doc, idx + text.length);
      return from != null && to != null ? { from, to } : null;
    }
    count++;
    searchFrom = idx + text.length;
  }
}
