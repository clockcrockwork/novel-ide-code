const PARA_SEP = ' '; // U+2029 Paragraph Separator

export function getParagraphOffsets(text) {
  const paragraphs = [];
  let offset = 0;
  for (const line of text.split(/\r?\n|\u2029/)) {
    paragraphs.push({ text: line, offset });
    offset += line.length + 1;
  }
  return paragraphs;
}

export function docToLinesText(doc) {
  const parts = [];
  const blockStarts = [];
  let textOffset = 0;

  doc.descendants((node, pos) => {
    if (node.isTextblock && node.type.name === 'slashComment') {
      return false;
    } else if (node.isTextblock) {
      if (blockStarts.length > 0) {
        parts.push(PARA_SEP);
        textOffset += 1;
      }
      blockStarts.push({ textOffset, pmBase: pos + 1 });
    } else if (node.type.name === 'hardBreak') {
      parts.push('\n');
      textOffset += 1;
    } else if (node.type.name === 'ruby') {
      parts.push('�');
      textOffset += 1;
      return false;
    } else if (node.isText) {
      parts.push(node.text);
      textOffset += node.text.length;
    }
    return true;
  });

  const text = parts.join('');

  function toPmPos(offset) {
    if (blockStarts.length === 0) return null;
    let blockIdx = 0;
    for (let i = 1; i < blockStarts.length; i++) {
      if (blockStarts[i].textOffset > offset) break;
      blockIdx = i;
    }
    const { textOffset: blockTextOffset, pmBase } = blockStarts[blockIdx];
    return pmBase + (offset - blockTextOffset);
  }

  return { text, toPmPos };
}
