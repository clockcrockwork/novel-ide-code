import { EditorContent } from '@tiptap/react';
import { useEffect, useRef } from 'react';

// Measure line heights in the ProseMirror DOM for line-number gutter alignment.
// gutterTop: gutter's getBoundingClientRect().top (pre-read by caller to avoid layout thrashing).
function measureLineHeights(pm, gutterTop) {
  const nodes = pm.children;
  if (!nodes.length) return null;

  const nodeRects = [];
  for (let ni = 0; ni < nodes.length; ni++) {
    nodeRects.push(nodes[ni].getBoundingClientRect());
  }

  const firstOffset = nodeRects[0].top - gutterTop;
  const heights = [];

  for (let ni = 0; ni < nodes.length; ni++) {
    const node = nodes[ni];
    const rect = nodeRects[ni];
    const nextRect = nodeRects[ni + 1];
    const brs = node.querySelectorAll('br:not(.ProseMirror-trailingBreak)');
    if (brs.length === 0) {
      heights.push(nextRect ? nextRect.top - rect.top : rect.height);
    } else {
      let prevY = rect.top;
      for (const br of brs) {
        const brBottom = br.getBoundingClientRect().bottom;
        heights.push(brBottom - prevY);
        prevY = brBottom;
      }
      heights.push(nextRect ? nextRect.top - prevY : rect.bottom - prevY);
    }
  }

  return { firstOffset, heights };
}

export default function WriteMode({
  editor,
  content,
  showLineNumbers,
  readOnly,
  lineNumbers,
  ctxMenu,
  ctxAction,
  focusEditorAtPoint,
  showCtx,
  handleContextMenu,
  onFocusPane,
  pane,
}) {
  const gutterRef = useRef(null);
  const bodyRef = useRef(null);
  const rafRef = useRef(null);
  const syncRef = useRef(null);

  useEffect(() => {
    if (!showLineNumbers || !editor || lineNumbers.length === 0) return;

    const sync = () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const pm = bodyRef.current?.querySelector('.ProseMirror');
        const gutter = gutterRef.current;
        if (!pm || !gutter) return;
        const items = gutter.children;
        if (!items.length) return;

        // 読み取りフェーズを先に完了させてから書き込む（layout thrashing 防止）
        const gutterTop = gutter.getBoundingClientRect().top;
        const measured = measureLineHeights(pm, gutterTop);
        if (!measured) return;
        const { firstOffset, heights } = measured;

        // --- 書き込みフェーズ ---
        gutter.style.paddingTop = firstOffset > 0 ? `${firstOffset}px` : '0px';
        for (let i = 0; i < heights.length; i++) {
          if (items[i]) items[i].style.height = heights[i] > 0 ? `${heights[i]}px` : '';
        }
      });
    };

    syncRef.current = sync;

    const pm = bodyRef.current?.querySelector('.ProseMirror');
    editor.on('update', sync);
    const ro = window.ResizeObserver ? new window.ResizeObserver(sync) : null;
    if (pm && ro) ro.observe(pm);
    sync();

    return () => {
      editor.off('update', sync);
      ro?.disconnect();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      syncRef.current = null;
    };
  }, [editor, showLineNumbers, lineNumbers.length]);

  // ファイル切替・同行数の場合に update イベントも ResizeObserver も発火しないケースを補完
  useEffect(() => {
    syncRef.current?.();
  }, [content]);

  return (
    <div
      className={`${readOnly ? 'editor-readonly ' : ''}editor-write-shell${showLineNumbers && lineNumbers.length > 0 ? ' with-line-numbers' : ''}`}
      onMouseDown={() => onFocusPane?.(pane)}
      onFocusCapture={() => onFocusPane?.(pane)}
      onPointerDown={focusEditorAtPoint}
      onMouseUp={showCtx}
      onTouchEnd={showCtx}
      onContextMenu={handleContextMenu}
    >
      {showLineNumbers && lineNumbers.length > 0 && (
        <div ref={gutterRef} className="line-number-gutter" aria-hidden="true">
          {lineNumbers.map((n) => (
            <div key={n} className="line-number">
              {n}
            </div>
          ))}
        </div>
      )}
      <div ref={bodyRef} className="editor-write-body">
        {!content && (
          <div
            style={{
              position: 'absolute',
              pointerEvents: 'none',
              zIndex: 0,
              fontFamily: 'var(--ef)',
              fontSize: 'var(--es)',
              lineHeight: 'var(--el)',
              letterSpacing: 'var(--elt)',
              color: 'var(--tx3)',
            }}
          >
            ここから執筆を始めてください…
          </div>
        )}
        <EditorContent editor={editor} />
      </div>
      {ctxMenu && (
        <div
          className="ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onTouchEnd={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <button type="button" className="ctx-item" onClick={() => ctxAction('quote')}>
            「」
          </button>
          <button type="button" className="ctx-item" onClick={() => ctxAction('bold')}>
            太字
          </button>
          <button type="button" className="ctx-item" onClick={() => ctxAction('h1')}>
            H1
          </button>
          <button type="button" className="ctx-item" onClick={() => ctxAction('h2')}>
            H2
          </button>
          <button type="button" className="ctx-item" onClick={() => ctxAction('ruby')}>
            ルビ
          </button>
          <button type="button" className="ctx-item" onClick={() => ctxAction('comment')}>
            /*コメント*/
          </button>
          <button type="button" className="ctx-item" onClick={() => ctxAction('slashcmt')}>
            // コメント
          </button>
          <button type="button" className="ctx-item" onClick={() => ctxAction('copy')}>
            コピー
          </button>
        </div>
      )}
    </div>
  );
}
