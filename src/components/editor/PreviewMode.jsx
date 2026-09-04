import { useState, useEffect, useRef, useMemo, useCallback, memo } from 'react';
import { usePopoverClose } from '../../hooks/usePopoverClose';
import { MARKER_COLORS } from '../../lib/annotations';
import {
  applyAnnotationsToBlocks,
  splitIntoBlocks,
  cachedParseMarkdown,
} from '../../lib/previewAnnotations';
import { findNthOccurrencePmPos } from '../../lib/tiptap';
import { viewportBottomLimit } from '../../lib/viewportMetrics';

function generateId() {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

const ParaBlock = memo(function ParaBlock({ html }) {
  // eslint-disable-next-line no-restricted-syntax -- applyAnnotationsToHTML + cachedParseMarkdown で escapeHtml() 済み
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
});

export default function PreviewMode({
  content,
  annos,
  saveAnnos,
  editorInstance,
  onFocusPane,
  pane,
}) {
  const [toolbar, setToolbar] = useState(null);
  const [showMemo, setShowMemo] = useState(false);
  const [memoText, setMemoText] = useState('');
  const [popover, setPopover] = useState(null);
  const memoInputRef = useRef(null);
  const previewRef = useRef(null);

  // contentとannosを別々にメモ化し、アノテーション変化だけではmarkdownパースを再実行しない
  // cachedParseMarkdown: write↔preview切替でも同一contentならパースをスキップ
  const parsedHtml = useMemo(() => cachedParseMarkdown(content), [content]);
  const blocks = useMemo(() => splitIntoBlocks(parsedHtml), [parsedHtml]);
  const annotatedBlocks = useMemo(() => applyAnnotationsToBlocks(blocks, annos), [blocks, annos]);

  const closeToolbar = useCallback(() => setToolbar(null), []);
  const closePopover = useCallback(() => setPopover(null), []);
  // toolbar は showMemo 時に textarea が focus し Android でキーボードが開く。
  // usePopoverClose の window.resize は interactive-widget=resizes-content 下で layout viewport 縮小として
  // 発火するため toolbar が即 close される。幅変化（＝画面回転）のみ close し、高さ変化（＝キーボード）は無視する。
  useEffect(() => {
    if (!toolbar) return;
    let prevW = window.innerWidth;
    const onResize = () => {
      if (window.innerWidth !== prevW) {
        prevW = window.innerWidth;
        closeToolbar();
      }
    };
    const onScroll = () => closeToolbar();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [toolbar, closeToolbar]);
  usePopoverClose(popover ? closePopover : null);

  useEffect(() => {
    const fn = (e) => {
      if (!e.target.closest('.anno-toolbar') && !e.target.closest('.anno-popover'))
        setPopover(null);
    };
    document.addEventListener('mousedown', fn);
    return () => document.removeEventListener('mousedown', fn);
  }, []);

  useEffect(() => {
    if (showMemo && memoInputRef.current) memoInputRef.current.focus();
  }, [showMemo]);

  const handleMouseUp = (e) => {
    if (e.target.closest('.anno-toolbar')) return;
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        setToolbar(null);
        setShowMemo(false);
        return;
      }
      const selText = sel.toString().trim();
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const cx = rect.left + rect.width / 2;

      let occurrenceIdx = 0;
      if (previewRef.current && sel.rangeCount > 0) {
        try {
          const range = sel.getRangeAt(0);
          const preRange = document.createRange();
          preRange.setStart(previewRef.current, 0);
          preRange.setEnd(range.startContainer, range.startOffset);
          const textBefore = preRange.toString();
          let searchFrom = 0;
          while (true) {
            const idx = textBefore.indexOf(selText, searchFrom);
            if (idx === -1) break;
            occurrenceIdx++;
            searchFrom = idx + selText.length;
          }
        } catch {
          /* ignore cross-frame/DOM errors */
        }
      }

      setMemoText('');
      setShowMemo(false);
      setToolbar({
        x: Math.max(80, Math.min(cx, window.innerWidth - 80)),
        y: rect.top - 8,
        selText,
        occurrenceIdx,
      });
    }, 15);
  };

  const handleClick = (e) => {
    const el = e.target.closest('.a-memo[data-anno-id]');
    if (!el) return;
    const id = el.getAttribute('data-anno-id');
    const anno = annos.find((a) => a.id === id);
    if (!anno) return;
    const rect = el.getBoundingClientRect();
    setPopover({ x: rect.left, y: rect.bottom + 6, anno });
    e.stopPropagation();
  };

  const _createAnnotation = (type, extra, createdAt) => {
    const id = generateId();
    const occurrenceIdx = toolbar.occurrenceIdx ?? 0;
    let from = null,
      to = null;
    if (editorInstance) {
      const pos = findNthOccurrencePmPos(editorInstance.state.doc, toolbar.selText, occurrenceIdx);
      if (pos) {
        from = pos.from;
        to = pos.to;
      }
    }
    return {
      id,
      type,
      selectedText: toolbar.selText,
      createdAt,
      from,
      to,
      occurrenceIdx,
      ...extra,
    };
  };

  const commit = (type, color, createdAt) => {
    if (!toolbar?.selText) return;
    if (type === 'memo') {
      setShowMemo(true);
      return;
    }
    saveAnnos([...annos, _createAnnotation('marker', { color }, createdAt)]);
    setToolbar(null);
    window.getSelection()?.removeAllRanges();
  };

  const commitMemo = (createdAt) => {
    if (!toolbar?.selText) return;
    saveAnnos([...annos, _createAnnotation('memo', { note: memoText }, createdAt)]);
    setToolbar(null);
    setShowMemo(false);
    window.getSelection()?.removeAllRanges();
  };

  const deleteAnno = (id) => {
    saveAnnos(annos.filter((a) => a.id !== id));
    setPopover(null);
  };

  return (
    <div
      style={{ position: 'relative' }}
      onMouseDown={() => onFocusPane?.(pane)}
      onFocusCapture={() => onFocusPane?.(pane)}
    >
      <div
        ref={previewRef}
        className="preview-area"
        onMouseUp={handleMouseUp}
        onClick={handleClick}
      >
        {annotatedBlocks.map((h, i) => (
          <ParaBlock key={i} html={h} />
        ))}
      </div>

      {annos.length > 0 && (
        <div
          style={{
            position: 'fixed',
            bottom: 'calc(var(--footer-cover, 90px) + 12px)',
            right: 16,
            background: 'var(--sf1)',
            border: '1px solid var(--bd)',
            borderRadius: 20,
            padding: '3px 10px',
            fontSize: 11,
            color: 'var(--tx2)',
            boxShadow: 'var(--nd-sm)',
            cursor: 'default',
            zIndex: 100,
          }}
        >
          🖍 {annos.filter((a) => a.type === 'marker').length}　💬{' '}
          {annos.filter((a) => a.type === 'memo').length}
        </div>
      )}

      {toolbar && (
        <div
          className="anno-toolbar"
          style={{
            left: toolbar.x - (showMemo ? 100 : 90),
            top: toolbar.y - (showMemo ? 130 : 40),
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {!showMemo ? (
            <>
              <span
                style={{
                  fontSize: 10,
                  color: 'var(--tx3)',
                  padding: '0 4px 0 2px',
                  whiteSpace: 'nowrap',
                  maxWidth: 100,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                「{toolbar.selText.slice(0, 16)}
                {toolbar.selText.length > 16 ? '…' : ''}」
              </span>
              <div
                style={{
                  width: 1,
                  background: 'var(--bd2)',
                  alignSelf: 'stretch',
                  margin: '3px 2px',
                }}
              />
              {MARKER_COLORS.map((c) => (
                <button
                  type="button"
                  key={c.color}
                  title={c.label + 'マーカー'}
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: 4,
                    border: '2px solid rgba(255,255,255,.15)',
                    background: c.color,
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                  onClick={() => commit('marker', c.color, Date.now())}
                />
              ))}
              <div
                style={{
                  width: 1,
                  background: 'var(--bd2)',
                  alignSelf: 'stretch',
                  margin: '3px 2px',
                }}
              />
              <button
                type="button"
                className="ctx-item"
                style={{ padding: '2px 7px', fontSize: 11 }}
                onClick={() => commit('memo')}
              >
                💬
              </button>
              <button
                type="button"
                className="ctx-item"
                style={{ padding: '2px 5px', fontSize: 11, opacity: 0.5 }}
                onClick={() => {
                  setToolbar(null);
                  window.getSelection()?.removeAllRanges();
                }}
              >
                ×
              </button>
            </>
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                padding: '2px',
                width: 200,
              }}
            >
              <div style={{ fontSize: 10, color: 'var(--tx3)' }}>
                「{toolbar.selText.slice(0, 22)}
                {toolbar.selText.length > 22 ? '…' : ''}」 へのメモ
              </div>
              <textarea
                ref={memoInputRef}
                className="text-input"
                style={{
                  resize: 'none',
                  height: 64,
                  fontSize: 12,
                  lineHeight: 1.5,
                  padding: '5px 8px',
                }}
                placeholder="メモを入力…"
                value={memoText}
                onChange={(e) => setMemoText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commitMemo(Date.now());
                }}
              />
              <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="btn-ghost"
                  style={{ padding: '3px 9px', fontSize: 11 }}
                  onClick={() => setShowMemo(false)}
                >
                  戻る
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  style={{ padding: '3px 10px', fontSize: 11 }}
                  onClick={() => commitMemo(Date.now())}
                >
                  保存
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {popover && (
        <div
          className="anno-popover"
          style={{
            left: Math.min(popover.x, window.innerWidth - 280),
            top: Math.min(popover.y, Math.max(8, viewportBottomLimit() - 140)),
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <div style={{ fontSize: 10, color: 'var(--tx3)', marginBottom: 5, lineHeight: 1.4 }}>
            「{popover.anno.selectedText.slice(0, 30)}
            {popover.anno.selectedText.length > 30 ? '…' : ''}」
          </div>
          <div style={{ fontSize: 13, color: 'var(--tx)', lineHeight: 1.7, minHeight: 20 }}>
            {popover.anno.note || (
              <span style={{ color: 'var(--tx3)', fontStyle: 'italic' }}>メモなし</span>
            )}
          </div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginTop: 10,
              paddingTop: 8,
              borderTop: '1px solid var(--bd)',
            }}
          >
            <span style={{ fontSize: 10, color: 'var(--tx3)' }}>
              {new Date(popover.anno.createdAt).toLocaleDateString('ja-JP')}
            </span>
            <button
              type="button"
              style={{
                background: 'transparent',
                border: 'none',
                fontSize: 11,
                cursor: 'pointer',
                color: 'var(--ac-red)',
                padding: '2px 8px',
                borderRadius: 'var(--rs)',
                fontFamily: 'inherit',
              }}
              onClick={() => deleteAnno(popover.anno.id)}
            >
              削除
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
