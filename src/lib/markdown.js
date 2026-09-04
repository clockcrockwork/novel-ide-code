import { stripComments } from './plainText.js';

const TOKEN_PREVIEW = /\*\*([^*]+?)\*\*|\{([^|}\n]+)\|([^}\n]*)\}/g;
const TOKEN_FULL = /\*\*([^*]+?)\*\*|\{([^|}\n]+)\|([^}\n]*)\}|\/\*([^*]*?)\*\//g;
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function parseMarkdown(raw, forPreview) {
  let src = (raw || '').replace(/\r\n?/g, '\n');
  if (forPreview) {
    src = stripComments(src);
  }
  const lines = src.split('\n');
  let html = '',
    inPara = false;
  const esc = (t) => t.replace(/[&<>"']/g, (m) => ESC_MAP[m]);
  const closePara = () => {
    if (inPara) {
      html += '</p>';
      inPara = false;
    }
  };
  const TOKEN = forPreview ? TOKEN_PREVIEW : TOKEN_FULL;
  const inline = (t) => {
    let result = '';
    let last = 0;
    for (const m of t.matchAll(TOKEN)) {
      result += esc(t.slice(last, m.index));
      if (m[1] !== undefined) {
        result += `<strong>${inline(m[1])}</strong>`;
      } else if (m[2] !== undefined) {
        result += `<ruby>${inline(m[2])}<rt>${inline(m[3])}</rt></ruby>`;
      } else if (m[4] !== undefined) {
        result += `<span class="hl-memo">/*${esc(m[4])}*/</span>`;
      }
      last = m.index + m[0].length;
    }
    result += esc(t.slice(last));
    return result;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hm = line.match(/^(#{1,3})\s+(.+)/);
    if (hm) {
      closePara();
      const level = hm[1].length;
      html += `<h${level}>${inline(hm[2])}</h${level}>`;
    } else if (/^-{3,}\s*$/.test(line.trim())) {
      closePara();
      html += '<hr/>';
    } else if (line.trim() === '') {
      closePara();
    } else {
      if (!inPara) {
        html += '<p>';
        inPara = true;
      } else html += '<br/>';
      html += inline(line);
    }
  }
  closePara();
  return html;
}

export { computeDiff, computeDiffAsync } from './diffCore.js';
