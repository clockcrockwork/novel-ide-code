import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { escapeAttr, normalizeAnnotations, safeColor } from '../annotations';

export const annotationPluginKey = new PluginKey('annotations');

function buildDecorations(doc, annos) {
  if (!annos?.length) return DecorationSet.empty;
  const decorations = [];
  for (const anno of normalizeAnnotations(annos, doc.content.size)) {
    if (anno.from == null || anno.to == null) continue;
    if (anno.from >= anno.to || anno.to > doc.content.size) continue;
    if (anno.type === 'marker') {
      decorations.push(
        Decoration.inline(anno.from, anno.to, {
          class: 'a-mark',
          style: `background:${safeColor(anno.color)}`,
          'data-anno-id': escapeAttr(anno.id),
        }),
      );
    } else if (anno.type === 'memo') {
      decorations.push(
        Decoration.inline(anno.from, anno.to, {
          class: 'a-memo',
          'data-anno-id': escapeAttr(anno.id),
          'data-note': escapeAttr(anno.note || ''),
        }),
      );
    }
  }
  return DecorationSet.create(doc, decorations);
}

export const AnnotationExtension = Extension.create({
  name: 'annotations',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: annotationPluginKey,
        state: {
          init(_, state) {
            return buildDecorations(state.doc, []);
          },
          apply(tr, oldSet, _, newState) {
            const newAnnos = tr.getMeta(annotationPluginKey);
            if (newAnnos !== undefined) return buildDecorations(newState.doc, newAnnos);
            if (tr.docChanged) return oldSet.map(tr.mapping, newState.doc);
            return oldSet;
          },
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
        },
      }),
    ];
  },
});
