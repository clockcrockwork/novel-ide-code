// Serialize ProseMirror doc → plain text for localStorage storage.
// Must round-trip correctly with plainTextLoader.js.

export function serializeToText(doc) {
  const allNodes = [];
  doc.forEach((node) => allNodes.push(node));

  const blocks = [];
  let i = 0;
  while (i < allNodes.length) {
    if (allNodes[i].type.name === 'commentParagraph') {
      // Collect consecutive commentParagraph nodes and wrap in /* ... */
      const commentLines = [];
      while (i < allNodes.length && allNodes[i].type.name === 'commentParagraph') {
        commentLines.push(serializeInline(allNodes[i]));
        i++;
      }
      blocks.push('/*\n' + commentLines.join('\n\n') + '\n*/');
    } else {
      const block = serializeBlock(allNodes[i]);
      if (block !== null) blocks.push(block);
      i++;
    }
  }

  // Drop trailing empty blocks added by TrailingNode extension
  while (blocks.length > 0 && blocks[blocks.length - 1] === '') blocks.pop();
  return blocks.join('\n\n');
}

function serializeBlock(node) {
  switch (node.type.name) {
    case 'heading':
      return '#'.repeat(node.attrs.level) + ' ' + serializeInline(node);
    case 'horizontalRule':
      return '---';
    case 'slashComment':
      return '// ' + serializeInline(node);
    case 'paragraph':
      return serializeInline(node);
    default:
      return null;
  }
}

function serializeInline(node) {
  let text = '';
  let inComment = false;
  const children = [];
  node.forEach((child) => children.push(child));

  for (let idx = 0; idx < children.length; idx++) {
    const child = children[idx];
    if (child.isText) {
      const t = child.text || '';
      const hasBold = child.marks.some((m) => m.type.name === 'bold');
      const hasComment = child.marks.some((m) => m.type.name === 'inlineComment');
      // Track comment state to emit one /* ... */ wrapping consecutive inlineComment nodes
      // (bold inside inlineComment is serialized as plain text — nested marks can't round-trip)
      if (hasComment) {
        if (!inComment) {
          text += '/*';
          inComment = true;
        }
        text += t;
      } else {
        if (inComment) {
          text += '*/';
          inComment = false;
        }
        if (hasBold) text += '**' + t + '**';
        else text += t;
      }
    } else if (child.type.name === 'hardBreak') {
      const breakInComment = child.marks.some((m) => m.type.name === 'inlineComment');
      if (inComment && !breakInComment) {
        text += '*/';
        inComment = false;
      } else if (!inComment && breakInComment) {
        text += '/*';
        inComment = true;
      }
      text += '\n';
    } else if (child.type.name === 'ruby') {
      if (inComment) {
        text += '*/';
        inComment = false;
      }
      text += '{' + (child.attrs.base || '') + '|' + (child.attrs.reading || '') + '}';
    }
  }
  if (inComment) text += '*/';
  return text;
}
