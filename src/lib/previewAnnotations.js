import { parseMarkdown } from './markdown.js';
import { escapeHtml, escapeAttr, normalizeAnnotations, safeColor } from './annotations.js';

function replaceNth(str, escapedPattern, replacement, n) {
  let count = 0;
  // eslint-disable-next-line security/detect-non-literal-regexp
  const re = new RegExp(`(<[^>]+>)|(${escapedPattern})|(&[A-Za-z0-9#]+;)`, 'g');
  return str.replace(re, (match, tag, pat, entity) => {
    if (tag || entity) return match;
    return count++ === n ? replacement : match;
  });
}

function countOccurrences(html, re) {
  let count = 0;
  for (const match of html.matchAll(re)) {
    const [, tag, , entity] = match;
    if (tag || entity) continue;
    count++;
  }
  return count;
}

export function applyAnnotationsToHTML(html, annotations) {
  if (!annotations?.length) return html;
  let result = html;
  for (const anno of normalizeAnnotations(annotations)) {
    const esc = escapeHtml(anno.selectedText);
    const pattern = esc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const n = anno.occurrenceIdx ?? 0;
    const id = escapeAttr(anno.id);
    if (anno.type === 'marker') {
      result = replaceNth(
        result,
        pattern,
        `<mark class="a-mark" style="background:${safeColor(anno.color)}" data-anno-id="${id}">${esc}</mark>`,
        n,
      );
    } else {
      const note = escapeAttr(anno.note || '');
      result = replaceNth(
        result,
        pattern,
        `<span class="a-memo" data-anno-id="${id}" data-note="${note}">${esc}</span>`,
        n,
      );
    }
  }
  return result;
}

// グローバル occurrenceIdx をブロック単位のローカル index に変換してから適用する。
// blocks.map(b => applyAnnotationsToHTML(b, annos)) の代わりに使用する。
export function applyAnnotationsToBlocks(blocks, annotations) {
  if (!annotations?.length || !blocks.length) return blocks;

  const normalizedAnnos = normalizeAnnotations(annotations);
  if (!normalizedAnnos.length) return blocks;

  const remaining = normalizedAnnos.map((a) => a.occurrenceIdx ?? 0);
  const blockLocalAnnos = blocks.map(() => []);

  for (let ai = 0; ai < normalizedAnnos.length; ai++) {
    const anno = normalizedAnnos[ai];
    const esc = escapeHtml(anno.selectedText);
    const pattern = esc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // eslint-disable-next-line security/detect-non-literal-regexp
    const re = new RegExp(`(<[^>]+>)|(${pattern})|(&[A-Za-z0-9#]+;)`, 'g');

    for (let bi = 0; bi < blocks.length; bi++) {
      const countInBlock = countOccurrences(blocks[bi], re);
      if (remaining[ai] < countInBlock) {
        blockLocalAnnos[bi].push({ ...anno, occurrenceIdx: remaining[ai] });
        break;
      }
      remaining[ai] -= countInBlock;
    }
  }

  return blocks.map((block, i) =>
    blockLocalAnnos[i].length ? applyAnnotationsToHTML(block, blockLocalAnnos[i]) : block,
  );
}

export function splitIntoBlocks(html) {
  if (!html) return [];
  const blocks = html.match(/<(p|h[1-6])\b[^>]*>[\s\S]*?<\/\1>|<hr\s*\/?>/gi);
  if (!blocks) return [html];
  // 正規表現でカバーされなかったテキストが消失しないよう完全性チェック
  return blocks.join('') === html ? blocks : [html];
}

export const _parseCache = new Map();
export function _clearParseCache() {
  _parseCache.clear();
}

export function cachedParseMarkdown(content) {
  if (_parseCache.has(content)) {
    // LRU: ヒット時に末尾へ再挿入して新鮮さを更新
    const result = _parseCache.get(content);
    _parseCache.delete(content);
    _parseCache.set(content, result);
    return result;
  }
  const result = parseMarkdown(content, true);
  _parseCache.set(content, result);
  if (_parseCache.size > 5) _parseCache.delete(_parseCache.keys().next().value);
  return result;
}
