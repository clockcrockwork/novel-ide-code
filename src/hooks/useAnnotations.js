import { useState, useCallback, useEffect } from 'react';
import { dbGet, dbPut } from '../lib/db';
import { normalizeAnnotations } from '../lib/annotations';
import { annotationPluginKey, findNthOccurrencePmPos } from '../lib/tiptap';

function migrateAnnotationPositions(annos, state) {
  return annos.map((anno) => {
    if (anno.from != null && anno.to != null) return anno;
    if (!anno.selectedText) return anno;
    const n = anno.occurrenceIdx ?? 0;
    const pos = findNthOccurrencePmPos(state.doc, anno.selectedText, n);
    if (!pos) return anno;
    return { ...anno, from: pos.from, to: pos.to };
  });
}

export function useAnnotations(fileId, editor) {
  const [annos, setAnnosRaw] = useState([]);

  useEffect(() => {
    if (!editor) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fileId切替時に前ファイルの装飾を即クリアする正当な副作用
    setAnnosRaw([]);
    if (editor.view) {
      editor.view.dispatch(editor.state.tr.setMeta(annotationPluginKey, []));
    }
    (async () => {
      try {
        const record = await dbGet('annotations', fileId);
        if (cancelled) return;
        const parsedRaw = record?.list ?? [];
        const raw = normalizeAnnotations(parsedRaw, editor.state.doc.content.size);
        const migrated = normalizeAnnotations(
          migrateAnnotationPositions(raw, editor.state),
          editor.state.doc.content.size,
        );
        setAnnosRaw(migrated);
        if (JSON.stringify(migrated) !== JSON.stringify(parsedRaw)) {
          dbPut('annotations', { fileId, list: migrated, updatedAt: Date.now() }).catch(
            console.warn,
          );
        }
        if (editor.view) {
          editor.view.dispatch(editor.state.tr.setMeta(annotationPluginKey, migrated));
        }
      } catch {
        if (cancelled) return;
        setAnnosRaw([]);
        if (editor.view) {
          editor.view.dispatch(editor.state.tr.setMeta(annotationPluginKey, []));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [editor, fileId]);

  const saveAnnos = useCallback(
    (list) => {
      const normalized = normalizeAnnotations(list, editor?.state?.doc.content.size);
      setAnnosRaw(normalized);
      dbPut('annotations', { fileId, list: normalized, updatedAt: Date.now() }).catch(console.warn);
      if (editor?.view) {
        editor.view.dispatch(editor.state.tr.setMeta(annotationPluginKey, normalized));
      }
    },
    [fileId, editor],
  );

  return { annos, saveAnnos };
}
