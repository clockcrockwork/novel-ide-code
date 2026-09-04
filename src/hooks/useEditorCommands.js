import { openRubyEditPopup } from '../lib/rubyUtils';

export function useEditorCommands(editorRef, canEdit) {
  const ins = (text) => {
    if (!canEdit) return;
    const editor = editorRef?.current;
    if (!editor) return;
    const { from, to } = editor.state.selection;
    const hasSel = from !== to;

    if (Array.isArray(text)) {
      if (hasSel) {
        const selText = editor.state.doc.textBetween(from, to);
        editor
          .chain()
          .focus()
          .insertContent(text[0] + selText + text[1])
          .run();
      } else {
        editor
          .chain()
          .focus()
          .insertContent(text[0] + text[1])
          .run();
        if (text[1].length > 0) {
          const newPos = editor.state.selection.from - text[1].length;
          editor.commands.setTextSelection(Math.max(0, newPos));
        }
      }
    } else {
      editor.chain().focus().insertContent(text).run();
    }
  };

  const mv = (dir) => {
    if (!canEdit) return;
    const editor = editorRef?.current;
    if (!editor) return;
    editor.commands.focus();
    const dirMap = {
      l: ['backward', 'character'],
      r: ['forward', 'character'],
      u: ['backward', 'line'],
      d: ['forward', 'line'],
    };
    const [d, g] = dirMap[dir] || [];
    if (d && g) window.getSelection()?.modify('move', d, g);
  };

  const moveLine = (dir) => {
    if (!canEdit) return;
    const editor = editorRef?.current;
    if (!editor?.view) return;

    const { state, view } = editor;
    const { $from } = state.selection;

    const blocks = [];
    state.doc.forEach((node, pos) => blocks.push({ node, pos }));

    const curIdx = blocks.findIndex(
      (b) => $from.pos >= b.pos && $from.pos < b.pos + b.node.nodeSize,
    );
    if (curIdx === -1) return;
    const swapIdx = dir === 'up' ? curIdx - 1 : curIdx + 1;
    if (swapIdx < 0 || swapIdx >= blocks.length) return;

    const cur = blocks[curIdx];
    const swap = blocks[swapIdx];
    const tr = state.tr;

    if (dir === 'up') {
      tr.delete(cur.pos, cur.pos + cur.node.nodeSize);
      tr.insert(swap.pos, cur.node);
    } else {
      tr.insert(swap.pos + swap.node.nodeSize, cur.node);
      tr.delete(cur.pos, cur.pos + cur.node.nodeSize);
    }

    view.dispatch(tr);

    const newBlocks = [];
    editor.state.doc.forEach((node, pos) => newBlocks.push({ node, pos }));
    const target = newBlocks[swapIdx];
    if (target)
      editor.commands.setTextSelection(Math.min(target.pos + 1, editor.state.doc.content.size));
  };

  const insHeading = (n) => {
    if (!canEdit) return;
    editorRef.current?.chain().focus().toggleHeading({ level: n }).run();
  };

  const wrapBold = () => {
    if (!canEdit) return;
    editorRef.current?.chain().focus().toggleBold().run();
  };

  const insRuby = () => {
    if (!canEdit) return;
    const editor = editorRef?.current;
    if (!editor) return;
    const { from, to } = editor.state.selection;
    const base = from !== to ? editor.state.doc.textBetween(from, to) : '漢字';
    editor
      .chain()
      .focus()
      .insertContent({ type: 'ruby', attrs: { base, reading: '' } })
      .run();
    const insertedPos = editor.state.selection.from - 1;
    openRubyEditPopup(editor, insertedPos);
  };

  const insSplitParagraph = () => {
    if (!canEdit) return;
    const editor = editorRef?.current;
    if (!editor) return;
    if (editor.view?.composing) return;
    editor.chain().focus().splitBlock().run();
  };

  return { ins, mv, moveLine, insHeading, wrapBold, insRuby, insSplitParagraph };
}
