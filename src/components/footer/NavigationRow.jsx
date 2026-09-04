import { useCallback, useMemo } from 'react';

export default function NavigationRow({ canEdit, mv, moveLine, editorRef }) {
  const runEditorAction = useCallback(
    (action) => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.chain().focus()[action]().run();
    },
    [editorRef],
  );

  const handleButtonClick = useCallback(
    (type, value) => {
      if (type === 'cursor') mv(value);
      if (type === 'moveLine') moveLine(value);
      if (type === 'history') runEditorAction(value);
    },
    [moveLine, mv, runEditorAction],
  );

  const rowItems = useMemo(
    () => [
      { l: '◂', type: 'cursor', value: 'l', cur: true, title: 'カーソル左' },
      { l: '▴', type: 'cursor', value: 'u', cur: true, title: 'カーソル上' },
      { l: '▾', type: 'cursor', value: 'd', cur: true, title: 'カーソル下' },
      { l: '▸', type: 'cursor', value: 'r', cur: true, title: 'カーソル右' },
      null,
      { l: '行↑', type: 'moveLine', value: 'up', lmv: true, title: '行を上へ移動' },
      { l: '行↓', type: 'moveLine', value: 'down', lmv: true, title: '行を下へ移動' },
      null,
      { l: '↩', type: 'history', value: 'undo', sym: true, title: '元に戻す' },
      { l: '↪', type: 'history', value: 'redo', sym: true, title: 'やり直し' },
    ],
    [],
  );

  return (
    <div className="frow">
      {rowItems.map((b, i) =>
        b ? (
          <button
            type="button"
            key={i}
            className={`fb${b.cur ? ' cur' : b.lmv ? ' lmv' : b.sym ? ' sym' : ''}`}
            onClick={() => handleButtonClick(b.type, b.value)}
            title={b.title}
            disabled={!canEdit}
          >
            {b.l}
          </button>
        ) : (
          <div key={i} className="fsep" />
        ),
      )}
    </div>
  );
}
