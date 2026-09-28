import { useEffect, useId, useRef } from 'react';
import { useApp } from '../../context/AppContext';
import { useUIStore } from '../../stores/uiStore';

export default function DeleteFileModal() {
  const { deleteFile } = useApp();
  const modal = useUIStore((s) => s.deleteFileModal);
  const setDeleteFileModal = useUIStore((s) => s.setDeleteFileModal);
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);
  const titleId = useId();

  useEffect(() => {
    if (!modal) return;
    const previousFocus = document.activeElement;
    cancelRef.current?.focus();
    return () => previousFocus?.focus?.();
  }, [modal]);

  if (!modal) return null;

  const close = () => setDeleteFileModal(null);
  const confirm = () => {
    deleteFile(modal.fileId);
    modal.onDeleted?.();
    close();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusables = dialogRef.current?.querySelectorAll('button:not([disabled])');
    if (!focusables?.length) {
      e.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const activeIdx = Array.from(focusables).indexOf(document.activeElement);
    if (activeIdx === -1) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (e.shiftKey && activeIdx === 0) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && activeIdx === focusables.length - 1) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="overlay" role="presentation" onClick={close}>
      <div
        ref={dialogRef}
        className="modal"
        style={{ maxWidth: 400 }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="mtitle">
          <span id={titleId}>「{modal.fileName}」を削除</span>
          <button type="button" className="mclose" onClick={close} aria-label="閉じる">
            ×
          </button>
        </div>
        <p style={{ margin: '16px 0 8px', fontSize: 13, color: 'var(--tx2)', lineHeight: 1.6 }}>
          このファイルを削除しますか？
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button ref={cancelRef} type="button" className="btn-ghost" onClick={close}>
            キャンセル
          </button>
          <button type="button" className="btn-primary" onClick={confirm}>
            削除
          </button>
        </div>
      </div>
    </div>
  );
}
