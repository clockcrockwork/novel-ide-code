import { detectInvisibleChars, SEVERITY } from './unicodeSafety.js';

const DANGEROUS_ATTRS = /^on/i;
// xlink:href は SVG の <a> 等で使用されるため href と同様に検査する
const DANGEROUS_URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'data', 'xlink:href']);

// Anchor at start so query params like ?redirect=javascript:... are not matched
const DANGEROUS_SCHEME_RE = /^\s*(?:javascript|data|file|vbscript)\s*:/i;

function sanitizeHtmlString(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let stripped = false;

  for (const tag of ['script', 'style', 'iframe', 'object', 'embed', 'form']) {
    for (const el of doc.querySelectorAll(tag)) {
      el.remove();
      stripped = true;
    }
  }

  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
  const elements = [];
  let node = walker.currentNode;
  while (node) {
    elements.push(node);
    node = walker.nextNode();
  }

  for (const el of elements) {
    for (const attr of [...el.attributes]) {
      if (DANGEROUS_ATTRS.test(attr.name)) {
        el.removeAttribute(attr.name);
        stripped = true;
      } else if (DANGEROUS_URL_ATTRS.has(attr.name.toLowerCase())) {
        // \r\n\t を除去してから判定（"java\nscript:" のような制御文字混入によるバイパスを防ぐ）
        const cleanVal = attr.value.replace(/[\r\n\t]/g, '').trim();
        if (DANGEROUS_SCHEME_RE.test(cleanVal)) {
          el.removeAttribute(attr.name);
          stripped = true;
        }
      }
    }
  }

  // rawPlain が空の場合のフォールバックで改行を維持するため、ブロック要素境界と br に改行を挿入する。
  // textContent はブロック要素境界で改行を挿入しないため、事前に \n テキストノードを追加する。
  // ネスト要素（<div><p>...）で二重改行が発生しないよう、子ブロック要素を持つ親には挿入しない。
  const BLOCK_SEL = 'p, div, h1, h2, h3, h4, h5, h6, tr, li, td, th, blockquote, pre';
  for (const el of doc.querySelectorAll(`${BLOCK_SEL}, br`)) {
    if (el.tagName.toLowerCase() === 'br') {
      el.replaceWith(doc.createTextNode('\n'));
    } else if (!el.querySelector(BLOCK_SEL)) {
      el.appendChild(doc.createTextNode('\n'));
    }
  }

  return { text: doc.body.textContent, stripped };
}

function aggregateWarnFindings(findings) {
  const counts = new Map();
  for (const f of findings) {
    if (f.severity !== SEVERITY.WARN) continue;
    counts.set(f.label, (counts.get(f.label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => ({ label, count }));
}

function removeDenyChars(text) {
  const findings = detectInvisibleChars(text);
  const denyIndices = new Set(
    findings.filter((f) => f.severity === SEVERITY.DENY).map((f) => f.index),
  );
  if (!denyIndices.size) return { text, removed: 0, findings };

  let result = '';
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i);
    const len = cp > 0xffff ? 2 : 1;
    if (!denyIndices.has(i)) result += text.slice(i, i + len);
    i += len;
  }
  return { text: result, removed: denyIndices.size, findings };
}

export function sanitizeClipboardEvent(event) {
  const rawHtml = event.clipboardData?.getData('text/html') ?? '';
  const rawPlain = event.clipboardData?.getData('text/plain') ?? '';

  let text;
  let htmlStripped = false;

  if (rawHtml) {
    const result = sanitizeHtmlString(rawHtml);
    htmlStripped = result.stripped;
    // rawPlain を優先して改行を保持する（textContent はブロック要素境界で改行を挿入しない）。
    // sanitizeHtmlString は htmlStripped フラグの算出のためだけに実行する。
    // rawPlain が空（画像のみのコピー等）の場合は result.text にフォールバックする。
    // sanitizeHtmlString 内でブロック要素に \n を挿入済みのため改行は維持される。
    text = rawPlain || result.text;
  } else {
    text = rawPlain;
  }

  const { text: cleanText, removed: denyCharsRemoved, findings } = removeDenyChars(text);
  text = cleanText;

  const warnFindings = aggregateWarnFindings(findings);

  return { text, htmlStripped, denyCharsRemoved, warnFindings };
}
