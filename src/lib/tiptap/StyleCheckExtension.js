import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { useStyleCheckStore } from '../../stores/styleCheckStore';

export const styleCheckPluginKey = new PluginKey('styleCheck');

function buildDecorations(doc, results) {
  if (!results?.length) return DecorationSet.empty;
  const decorations = [];
  for (const r of results) {
    if (r.from == null || r.to == null || r.from >= r.to) continue;
    if (r.to > doc.content.size) continue;
    const title = r.suggestion ? `${r.message} → ${r.suggestion}` : r.message;
    decorations.push(
      Decoration.inline(r.from, r.to, {
        class: r.severity === 'warning' ? 's-warn' : 's-sug',
        'data-rule-id': r.ruleId,
        title,
      }),
    );
  }
  decorations.sort((a, b) => a.from - b.from);
  return DecorationSet.create(doc, decorations);
}

export const StyleCheckExtension = Extension.create({
  name: 'styleCheck',

  addOptions() {
    return { editorId: null };
  },

  addStorage() {
    return { editorId: this.options.editorId };
  },

  addProseMirrorPlugins() {
    // 分割表示では同じ拡張が両 EditorBox に入る。結果を所有する pane のみが
    // 自身の docChanged でグローバル store をクリアできるよう editorId を捕捉する（#330）。
    const editorId = this.options.editorId;
    return [
      new Plugin({
        key: styleCheckPluginKey,
        state: {
          init(_, state) {
            return buildDecorations(state.doc, []);
          },
          apply(tr, oldSet, _, newState) {
            const results = tr.getMeta(styleCheckPluginKey);
            if (results !== undefined) return buildDecorations(newState.doc, results);
            if (tr.docChanged) {
              const store = useStyleCheckStore.getState();
              if (store.results.length > 0 && store.ownerId === editorId) {
                queueMicrotask(() => useStyleCheckStore.getState().setResults([], null));
              }
              return DecorationSet.empty;
            }
            return oldSet;
          },
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
        },
        view(editorView) {
          // 結果の所有者が他 pane へ移る／クリアされた（ownerId が自身でなくなった）
          // とき、自身が非所有 pane なら古い下線を残さないよう空 meta を送って
          // DecorationSet をクリアする。owner 切替・参照ファイル切替（同一本文で
          // docChanged が出ない経路）の両方で stale 装飾を防ぐ（#331）。
          const unsubscribe = useStyleCheckStore.subscribe((state) => {
            if (state.ownerId === editorId) return;
            const set = styleCheckPluginKey.getState(editorView.state);
            if (set && set.find().length > 0) {
              editorView.dispatch(editorView.state.tr.setMeta(styleCheckPluginKey, []));
            }
          });
          return { destroy: unsubscribe };
        },
      }),
    ];
  },
});
