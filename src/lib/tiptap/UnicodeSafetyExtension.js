import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { detectInvisibleChars, SEVERITY } from '../security/unicodeSafety';

export const unicodeSafetyPluginKey = new PluginKey('unicodeSafety');

// text node ごとに detectInvisibleChars を走らせ、char index → PM position（pos + index）へ
// マップする。ProseMirror の text 位置は JS 文字列の code unit と 1:1（textOffsetToPmPos と同様）。
export function collectFindingRanges(doc) {
  const ranges = [];
  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      for (const f of detectInvisibleChars(node.text)) {
        const from = pos + f.index;
        const len = f.codePoint > 0xffff ? 2 : 1; // combining run（codePoint < 0）は 1
        ranges.push({ from, to: from + len, severity: f.severity, label: f.label });
      }
    } else if (node.type?.name === 'ruby') {
      // ruby は atom:true のため text node を持たず、base/reading を attrs に格納する。
      // 不可視文字が見つかった場合はルビノード全体の位置にウィジェットを 1 つ出す。
      let worstSeverity = null;
      let firstLabel = null;
      for (const attrKey of ['base', 'reading']) {
        const val = node.attrs?.[attrKey];
        if (!val) continue;
        for (const f of detectInvisibleChars(val)) {
          if (worstSeverity === null || f.severity === SEVERITY.DENY) {
            worstSeverity = f.severity;
            firstLabel = f.label;
          }
          if (worstSeverity === SEVERITY.DENY) break;
        }
        if (worstSeverity === SEVERITY.DENY) break;
      }
      if (worstSeverity !== null) {
        ranges.push({ from: pos, to: pos + node.nodeSize, severity: worstSeverity, label: firstLabel });
      }
    }
  });
  return ranges;
}

// 不可視・zero-width 文字は inline 背景では描画されないため、位置に可視マーカー（widget）を挿入する。
// マーカーは文書本文を変更しない（position に副作用なし）。label は title / aria-label で伝える。
function makeMarker(severity, label) {
  const el = document.createElement('span');
  const isDeny = severity === SEVERITY.DENY;
  el.className = isDeny ? 'uc-marker uc-marker-deny' : 'uc-marker uc-marker-warn';
  el.title = label;
  // role=img + aria-label で「不可視文字がここにある」ことを AT に伝える（span 単独の aria-label は無効）。
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', `${isDeny ? '危険な制御文字' : '不可視文字'}: ${label}`);
  el.textContent = isDeny ? '⚠' : '·';
  return el;
}

// docChanged のたびに collectFindingRanges（O(n)）を 1 回走らせ、decorations と ranges を同時に生成する。
// ranges は外部から unicodeSafetyPluginKey.getState(editorState).ranges で参照でき、
// security メタデータの debounced 再計算に再利用する（#291 Task 3）。
function buildState(doc) {
  const ranges = collectFindingRanges(doc);
  if (!ranges.length) return { decorations: DecorationSet.empty, ranges: [] };
  const decorations = DecorationSet.create(
    doc,
    ranges.map((r) =>
      Decoration.widget(r.from, () => makeMarker(r.severity, r.label), { side: 1, ignoreSelection: true }),
    ),
  );
  return { decorations, ranges };
}

// WriteMode で Bidi / 不可視 / 制御文字をインラインハイライトする（#291）。
// detectInvisibleChars は単一線形走査だが毎キーストローク全走査になるため docChanged 限定で再構築する。
const UnicodeSafetyExtension = Extension.create({
  name: 'unicodeSafety',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: unicodeSafetyPluginKey,
        state: {
          init(_, state) {
            return buildState(state.doc);
          },
          apply(tr, old, _, newState) {
            if (tr.docChanged) return buildState(newState.doc);
            return old;
          },
        },
        props: {
          decorations(state) {
            return this.getState(state).decorations;
          },
        },
      }),
    ];
  },
});

export default UnicodeSafetyExtension;
