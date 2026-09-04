import { useState, useEffect, useRef, useMemo } from 'react';
import { viewportBottomLimit } from '../../lib/viewportMetrics';

export default function RubyEditPopup({ editor, popup, onClose }) {
  const [localBase, setLocalBase] = useState(popup?.base ?? '');
  const [localReading, setLocalReading] = useState(popup?.reading ?? '');
  // vv.height + vv.offsetTop をトリガー値として使うことで、キーボード開閉（height 変化）と
  // ピンチズームスクロール（offsetTop 変化）の両方で useMemo が再 clamp される
  const [vvBottomTrigger, setVvBottomTrigger] = useState(() => {
    const vv = window.visualViewport;
    return (vv?.height ?? window.innerHeight) + (vv?.offsetTop ?? 0);
  });
  const readingInputRef = useRef(null);
  const popupRef = useRef(null);

  useEffect(() => {
    setTimeout(() => readingInputRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    const handlePointerDown = (e) => {
      if (popupRef.current && !popupRef.current.contains(e.target)) {
        onClose();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [onClose]);

  useEffect(() => {
    if (!editor) return;
    editor.on('update', onClose);
    return () => editor.off('update', onClose);
  }, [editor, onClose]);

  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // popup 外でキーボードが開いたとき閉じる（自身の input focus による keyboard-open は除外）
  useEffect(() => {
    const html = document.documentElement;
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        const wasOpen = m.oldValue?.split(' ').includes('keyboard-open') ?? false;
        if (!wasOpen && html.classList.contains('keyboard-open')) {
          const el = popupRef.current;
          if (el && !el.contains(document.activeElement)) onCloseRef.current();
          break;
        }
      }
    });
    observer.observe(html, {
      attributes: true,
      attributeFilter: ['class'],
      attributeOldValue: true,
    });
    return () => observer.disconnect();
  }, []);

  // 画面回転など幅が変わるリサイズで位置が陳腐化するため閉じる（キーボード開閉は幅不変のため除外）
  useEffect(() => {
    let prevWidth = window.innerWidth;
    const handle = () => {
      const w = window.innerWidth;
      if (w !== prevWidth) {
        prevWidth = w;
        onCloseRef.current();
      }
    };
    window.addEventListener('resize', handle, { passive: true });
    return () => window.removeEventListener('resize', handle);
  }, []);

  // popup 自身の input focus でキーボードが開くと viewportBottomLimit が縮む（height 変化）。
  // ピンチズームでスクロールすると offsetTop が変化し viewportBottomLimit も変わる。
  // どちらも useMemo の再計算をトリガーするため、height + offsetTop を state に持つ。
  // タイピング（localBase/localReading 更新）では vv 幾何は変わらないため
  // 入力中の再計算は発生せず、リフロー回避は維持される。
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const handle = () => setVvBottomTrigger(vv.height + vv.offsetTop);
    vv.addEventListener('resize', handle);
    vv.addEventListener('scroll', handle);
    return () => {
      vv.removeEventListener('resize', handle);
      vv.removeEventListener('scroll', handle);
    };
  }, []);

  // エディタ領域のスクロールで表示位置が陳腐化するため閉じる
  useEffect(() => {
    const handleScroll = (e) => {
      if (e.target?.closest?.('.main-area')) onCloseRef.current();
    };
    window.addEventListener('scroll', handleScroll, { capture: true, passive: true });
    return () => window.removeEventListener('scroll', handleScroll, { capture: true });
  }, []);

  // 漢字・ふりがな入力のたびに再レンダーされるため位置を useMemo でキャッシュし入力中の再計算を避ける。
  // vvBottomTrigger（= vv.height + vv.offsetTop）が変化すると再 clamp される。
  const { left, top } = useMemo(() => {
    if (!popup) return { left: 0, top: 0 };
    const vw = window.visualViewport?.width ?? window.innerWidth;
    const l = Math.min(Math.max(popup.x - 100, 8), vw - 280);
    // 上に出すのが基本だが、フッター/キーボードの裏に隠れないよう下端も clamp する
    const t = Math.min(Math.max(popup.y - 140, 8), Math.max(8, viewportBottomLimit() - 220));
    return { left: l, top: t };
  }, [popup?.x, popup?.y, vvBottomTrigger]);

  if (!popup) return null;

  const handleConfirm = () => {
    if (!editor) return;
    if (!localBase.trim()) {
      handleDelete();
      return;
    }
    const node = editor.state.doc.nodeAt(popup.pos);
    if (node?.type.name !== 'ruby') return;
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.setNodeMarkup(popup.pos, null, { base: localBase.trim(), reading: localReading.trim() });
        return true;
      })
      .run();
    onClose();
  };

  const handleDelete = () => {
    if (!editor) return;
    const node = editor.state.doc.nodeAt(popup.pos);
    if (node?.type.name !== 'ruby') return;
    editor
      .chain()
      .focus()
      .command(({ tr, state }) => {
        if (localBase) {
          tr.replaceWith(popup.pos, popup.pos + node.nodeSize, state.schema.text(localBase));
        } else {
          tr.delete(popup.pos, popup.pos + node.nodeSize);
        }
        return true;
      })
      .run();
    onClose();
  };

  const handleReadingKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleConfirm();
    }
  };

  return (
    <div ref={popupRef} className="anno-popover" style={{ left: `${left}px`, top: `${top}px` }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '11px',
        }}
      >
        <div style={{ fontSize: '13px', fontWeight: '600', color: 'var(--tx)' }}>ルビ編集</div>
        <button
          type="button"
          className="mclose"
          onClick={onClose}
          aria-label="閉じる"
          style={{ padding: '4px', margin: '-4px' }}
        >
          ×
        </button>
      </div>
      <div style={{ marginBottom: '11px' }}>
        <label
          style={{ display: 'block', fontSize: '12px', color: 'var(--tx3)', marginBottom: '4px' }}
        >
          漢字
        </label>
        <input
          type="text"
          className="sinput"
          value={localBase}
          onChange={(e) => setLocalBase(e.target.value.replace(/[|}\n]/g, ''))}
          style={{ width: '100%', boxSizing: 'border-box' }}
        />
      </div>
      <div style={{ marginBottom: '11px' }}>
        <label
          style={{ display: 'block', fontSize: '12px', color: 'var(--tx3)', marginBottom: '4px' }}
        >
          ふりがな
        </label>
        <input
          ref={readingInputRef}
          type="text"
          className="sinput"
          value={localReading}
          onChange={(e) => setLocalReading(e.target.value.replace(/[|}\n]/g, ''))}
          onKeyDown={handleReadingKeyDown}
          style={{ width: '100%', boxSizing: 'border-box' }}
        />
      </div>
      <div style={{ display: 'flex', gap: '7px' }}>
        <button type="button" className="btn-primary" onClick={handleConfirm}>
          確定
        </button>
        <button type="button" className="btn-ghost" onClick={handleDelete}>
          ルビを外す
        </button>
      </div>
    </div>
  );
}
