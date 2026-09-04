import { useCallback } from 'react';
import { useApp } from '../context/AppContext';

export function useEditorJump() {
  const { editorRef } = useApp();

  const jumpToPos = useCallback(
    (pos) => {
      const editor = editorRef?.current;
      if (!editor || pos == null) return;
      editor.chain().focus().setTextSelection(pos).scrollIntoView().run();
    },
    [editorRef],
  );

  const jumpToRange = useCallback(
    (from, to) => {
      const editor = editorRef?.current;
      if (!editor || from == null || to == null) return;
      editor.chain().focus().setTextSelection({ anchor: from, head: to }).scrollIntoView().run();
    },
    [editorRef],
  );

  return { jumpToPos, jumpToRange };
}
