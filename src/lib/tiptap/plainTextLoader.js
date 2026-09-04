// Convert plain-text (markdown-like) to ProseMirror JSON.
// Also migrates legacy %%...%% inline comment syntax to /*...*/.

export function migrateCommentSyntax(text) {
  return text.replace(/%%([^%\n]*?)%%/g, '/*$1*/');
}

function tryParseHorizontalRule(line, nodes, flushPending) {
  if (!/^-{3,}\s*$/.test(line.trim())) return false;
  flushPending();
  nodes.push({ type: 'horizontalRule' });
  return true;
}

function tryParseHeading(line, nodes, flushPending) {
  const hm = line.match(/^(#{1,3})\s+(.+)/);
  if (!hm) return false;
  flushPending();
  const inline = parseInline(hm[2]);
  nodes.push({
    type: 'heading',
    attrs: { level: hm[1].length },
    content: inline.length > 0 ? inline : [{ type: 'text', text: hm[2] }],
  });
  return true;
}

function tryParseSlashComment(line, nodes, flushPending) {
  if (!line.startsWith('//')) return false;
  flushPending();
  const commentText = line.slice(2).trimStart();
  nodes.push({
    type: 'slashComment',
    content: commentText ? [{ type: 'text', text: commentText }] : [],
  });
  return true;
}

// Bold **...**; returns new index on match, -1 on miss. Caller guarantees text[i] === '*' and text[i+1] === '*'.
function tryParseBold(text, i, nodes, flushPlain) {
  const end = text.indexOf('**', i + 2);
  if (end === -1) return -1;
  flushPlain();
  nodes.push({ type: 'text', text: text.slice(i + 2, end), marks: [{ type: 'bold' }] });
  return end + 2;
}

// InlineComment /*...*/; returns new index on match, -1 on miss. Caller guarantees text[i] === '/' and text[i+1] === '*'.
// Supports multi-line comments: \n within the comment becomes a hardBreak carrying inlineComment mark.
function tryParseInlineComment(text, i, nodes, flushPlain) {
  const end = text.indexOf('*/', i + 2);
  if (end === -1) return -1;
  flushPlain();
  const inner = text.slice(i + 2, end);
  const parts = inner.split('\n');
  for (let pi = 0; pi < parts.length; pi++) {
    if (pi > 0) nodes.push({ type: 'hardBreak', marks: [{ type: 'inlineComment' }] });
    if (parts[pi])
      nodes.push({ type: 'text', text: parts[pi], marks: [{ type: 'inlineComment' }] });
  }
  return end + 2;
}

// Ruby {base|reading}; returns new index on match, -1 on miss. Caller guarantees text[i] === '{'.
// Uses indexOf comparisons instead of slice to avoid allocation in failure paths.
function tryParseRuby(text, i, nodes, flushPlain) {
  const close = text.indexOf('}', i + 1);
  if (close === -1) return -1;
  const nextOpen = text.indexOf('{', i + 1);
  if (nextOpen !== -1 && nextOpen < close) return -1;
  const pipePos = text.indexOf('|', i + 1);
  if (pipePos === -1 || pipePos >= close) return -1;
  const base = text.slice(i + 1, pipePos);
  const reading = text.slice(pipePos + 1, close);
  if (!base.trim() || !reading.trim()) return -1;
  flushPlain();
  nodes.push({ type: 'ruby', attrs: { base, reading } });
  return close + 1;
}

// Parse a plain-text segment (no block-comment spans) into ProseMirror nodes.
function parseNormalText(segment, nodes) {
  if (!segment) return;
  const groups = segment.split(/\n\n+/);
  for (const group of groups) {
    const lines = group.split('\n');
    const pendingLines = [];

    const flushPending = () => {
      if (pendingLines.length === 0) return;
      const content = parseInline(pendingLines.join('\n'));
      nodes.push({ type: 'paragraph', content: content.length > 0 ? content : undefined });
      pendingLines.length = 0;
    };

    for (const line of lines) {
      if (!line.trim()) continue;
      if (tryParseHorizontalRule(line, nodes, flushPending)) continue;
      if (tryParseHeading(line, nodes, flushPending)) continue;
      if (tryParseSlashComment(line, nodes, flushPending)) continue;
      pendingLines.push(line);
    }

    flushPending();
  }
}

// Parse the interior of a multi-paragraph /* */ block comment.
// Each blank-line-separated group becomes one commentParagraph node.
function parseBlockComment(inner, nodes) {
  const groups = inner.split(/\n\n+/);
  for (const group of groups) {
    const lines = group.split('\n').filter((l) => l.trim());
    if (lines.length === 0) continue;
    const content = parseInline(lines.join('\n'));
    nodes.push({ type: 'commentParagraph', content: content.length > 0 ? content : undefined });
  }
}

// 改行のみ処理し記法変換を行わない ProseMirror JSON 生成。
// onCancel（そのまま貼り付け）用。plainTextToPmJson は **bold** 等を記法変換するため区別が必要。
export function rawTextToPmJson(text) {
  const normalized = (text || '').replace(/\r\n?/g, '\n');
  const paragraphs = normalized.split(/\n\n+/);
  const nodes = paragraphs
    .map((para) => {
      const lines = para.split('\n');
      // 末尾の空文字列を除去（trailing \n で trailing hardBreak が生成されるのを防ぐ）
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
      const content = [];
      lines.forEach((line, i) => {
        if (i > 0) content.push({ type: 'hardBreak' });
        if (line) content.push({ type: 'text', text: line });
      });
      return content.length > 0 ? { type: 'paragraph', content } : null;
    })
    .filter(Boolean);
  if (nodes.length === 0) nodes.push({ type: 'paragraph' });
  return { type: 'doc', content: nodes };
}

export function plainTextToPmJson(rawText) {
  // Normalize CRLF/CR to LF before processing.
  // User content may arrive with Windows line endings from external editors or imports.
  const text = migrateCommentSyntax((rawText || '').replace(/\r\n?/g, '\n'));
  const nodes = [];

  // Pre-pass: find /* */ blocks that contain \n\n (span multiple paragraph groups).
  // These are extracted and converted to commentParagraph nodes before group splitting.
  // Single-paragraph /* */ (no \n\n) stay in the text and are handled by parseInline.
  const blockCommentRe = /\/\*([\s\S]*?)\*\//g;
  let last = 0;
  let m;
  while ((m = blockCommentRe.exec(text)) !== null) {
    const inner = m[1];
    if (/\n\n/.test(inner)) {
      if (m.index > last) parseNormalText(text.slice(last, m.index), nodes);
      parseBlockComment(inner.replace(/^\s+|\s+$/g, ''), nodes);
      last = m.index + m[0].length;
    }
    // Single-paragraph /* */ left in text for parseInline to apply inlineComment mark
  }
  if (last < text.length) parseNormalText(text.slice(last), nodes);

  if (nodes.length === 0) nodes.push({ type: 'paragraph' });
  return { type: 'doc', content: nodes };
}

function parseInline(text) {
  const nodes = [];
  let i = 0;
  let plain = '';

  const flushPlain = () => {
    if (plain) {
      nodes.push({ type: 'text', text: plain });
      plain = '';
    }
  };

  while (i < text.length) {
    const char = text[i];
    if (char === '\n') {
      flushPlain();
      nodes.push({ type: 'hardBreak' });
      i++;
      continue;
    }
    let advance = -1;
    if (char === '*' && text[i + 1] === '*') advance = tryParseBold(text, i, nodes, flushPlain);
    else if (char === '/' && text[i + 1] === '*')
      advance = tryParseInlineComment(text, i, nodes, flushPlain);
    else if (char === '{') advance = tryParseRuby(text, i, nodes, flushPlain);
    if (advance !== -1) {
      i = advance;
      continue;
    }
    plain += text[i++];
  }
  flushPlain();
  return nodes.filter((n) => n.type !== 'text' || n.text);
}
