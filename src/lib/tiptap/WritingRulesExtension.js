import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

const pluginKey = new PluginKey('writingRules');
const APPLIED_META = 'writingRulesApplied';

// 1500ms: 高速連打中に rIC が強制実行される頻度を下げる。200ms: rIC 非対応ブラウザの代替遅延
const scheduleIdle =
  typeof requestIdleCallback !== 'undefined'
    ? (fn) => requestIdleCallback(fn, { timeout: 1500 })
    : (fn) => setTimeout(fn, 200);

const cancelIdle = typeof cancelIdleCallback !== 'undefined' ? cancelIdleCallback : clearTimeout;

function buildReplacements(state, rules, range) {
  const replacements = [];
  const indentOn = rules.some((r) => r.id === 'indent' && r.enabled);
  const rmDblOn = rules.some((r) => r.id === 'rm_dbl_sp' && r.enabled);
  const brktOn = rules.some((r) => r.id === 'bracket_sp' && r.enabled);

  const from = range ? range.from : 0;
  const to = range ? range.to : state.doc.content.size;

  state.doc.nodesBetween(from, to, (block, blockPos) => {
    if (block.type.name === 'doc') return true;
    if (block.type.name !== 'paragraph') return false;

    if (indentOn) {
      let lineStartOff = 0;
      let lineChecked = false;
      let shouldIndent = false;

      const flushLine = () => {
        if (shouldIndent)
          replacements.push({
            from: blockPos + 1 + lineStartOff,
            to: blockPos + 1 + lineStartOff,
            insert: '　',
          });
      };

      block.forEach((inline, inlineOff) => {
        if (inline.type.name === 'hardBreak') {
          flushLine();
          lineStartOff = inlineOff + 1;
          lineChecked = false;
          shouldIndent = false;
        } else if (!lineChecked) {
          lineChecked = true;
          if (inline.type.name === 'text') {
            shouldIndent = !!inline.text.trim() && !/^[#/\-\s　*>]/.test(inline.text);
          } else {
            shouldIndent = true; // ruby 等、行頭の非テキストインラインはインデント対象
          }
        }
      });
      flushLine();
    }

    if (rmDblOn || brktOn) {
      block.forEach((inline, inlinePos) => {
        if (inline.type.name !== 'text') return;
        let t = inline.text;
        if (rmDblOn) t = t.replace(/　{2,}/g, '　');
        if (brktOn) {
          t = t.replace(/([（「『【〔｛(])[^\S\n]+/g, '$1');
          t = t.replace(/[^\S\n]+([）」』】〕｝)])/g, '$1');
        }
        if (t === inline.text) return;
        const from = blockPos + 1 + inlinePos;
        replacements.push({ from, to: from + inline.text.length, text: t, marks: inline.marks });
      });
    }

    return false; // inline ノードへの descent を防ぐ（block.forEach で処理済み）
  });

  // 後方から適用するため降順ソート。同位置ではテキスト置換（to > from）を挿入（to === from）より先に処理
  replacements.sort((a, b) => b.from - a.from || b.to - a.to);
  return replacements;
}

export default Extension.create({
  name: 'writingRules',

  addStorage: () => ({ rules: [], isComposing: false, idleHandle: null }),

  addCommands() {
    return {
      setWritingRules:
        (rules) =>
        ({ editor }) => {
          editor.storage.writingRules.rules = rules;
          editor.view.dispatch(editor.view.state.tr.setMeta('writingRulesTrigger', true));
          return true;
        },
    };
  },

  onDestroy() {
    if (this.storage.idleHandle !== null) {
      cancelIdle(this.storage.idleHandle);
      this.storage.idleHandle = null;
    }
  },

  addProseMirrorPlugins() {
    const ext = this;

    return [
      new Plugin({
        key: pluginKey,
        props: {
          handleDOMEvents: {
            compositionstart: () => {
              ext.storage.isComposing = true;
              return false;
            },
            compositionend: (view) => {
              ext.storage.isComposing = false;
              if (ext.storage.rules.some((r) => r.enabled))
                view.dispatch(view.state.tr.setMeta('writingRulesTrigger', true));
              return false;
            },
          },
        },
        appendTransaction(transactions) {
          if (!transactions.some((tr) => tr.docChanged || tr.getMeta('writingRulesTrigger')))
            return null;
          if (transactions.some((tr) => tr.getMeta(APPLIED_META))) return null;
          if (ext.storage.isComposing) return null;
          if (!ext.storage.rules.some((r) => r.enabled)) return null;

          // 変更範囲を最終 doc 座標系で算出（手動トリガー時は null = 全文スキャン）
          // step.from/to は変更前座標のため tr.mapping で変換する（挿入時は from===to になる問題を回避）
          let changedFrom = Infinity,
            changedTo = 0;
          for (const tr of transactions) {
            if (changedFrom !== Infinity) {
              changedFrom = tr.mapping.map(changedFrom, -1);
              changedTo = tr.mapping.map(changedTo, 1);
            }
            if (!tr.docChanged) continue;
            tr.mapping.maps.forEach((map, i) => {
              map.forEach((_os, _oe, ns, ne) => {
                const posStart = tr.mapping.slice(i + 1).map(ns, -1);
                const posEnd = tr.mapping.slice(i + 1).map(ne, 1);
                changedFrom = Math.min(changedFrom, posStart);
                changedTo = Math.max(changedTo, posEnd);
              });
            });
          }
          // ±500 doc positions: 隣接ブロックを含むマージン（行数ではなく ProseMirror position 単位）
          const range =
            changedFrom !== Infinity
              ? { from: Math.max(0, changedFrom - 500), to: changedTo + 500 }
              : null;

          if (ext.storage.idleHandle !== null) {
            cancelIdle(ext.storage.idleHandle);
            ext.storage.idleHandle = null;
          }

          const view = ext.editor.view;
          ext.storage.idleHandle = scheduleIdle(() => {
            ext.storage.idleHandle = null;
            if (
              view.isDestroyed ||
              ext.editor.isDestroyed ||
              ext.storage.isComposing ||
              !ext.editor.isEditable
            )
              return;

            const rules = ext.storage.rules.filter((r) => r.enabled);
            if (!rules.length) return;

            const { state } = view;
            const replacements = buildReplacements(state, rules, range);
            if (!replacements.length) return;

            const tr = state.tr;
            for (const rep of replacements) {
              if (rep.insert !== undefined) {
                tr.insert(rep.from, state.schema.text(rep.insert));
              } else {
                const node = state.schema.text(rep.text, rep.marks.length ? rep.marks : null);
                tr.replaceWith(rep.from, rep.to, node);
              }
            }
            tr.setMeta(APPLIED_META, true);
            view.dispatch(tr);
          });

          return null;
        },
      }),
    ];
  },
});
