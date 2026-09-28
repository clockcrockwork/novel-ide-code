import { useEffect, useId, useRef } from 'react';
import { useApp } from '../../context/AppContext';
import { useUIStore } from '../../stores/uiStore';

export default function DeleteFolderModal() {
  const { deleteFolder } = useApp();
  const deleteFolderModal = useUIStore((s) => s.deleteFolderModal);
  const setDeleteFolderModal = useUIStore((s) => s.setDeleteFolderModal);
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);
  const titleId = useId();

  useEffect(() => {
    if (!deleteFolderModal) return;
    const previousFocus = document.activeElement;
    cancelRef.current?.focus();
    return () => previousFocus?.focus?.();
  }, [deleteFolderModal]);

  if (!deleteFolderModal) return null;

  const { folderId, folderName, fileCount } = deleteFolderModal;
  const isEmpty = fileCount === 0;

  const close = () => setDeleteFolderModal(null);

  const handle = (strategy) => {
    deleteFolder(folderId, strategy);
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
          <span id={titleId}>「{folderName}」を削除</span>
          <button type="button" className="mclose" onClick={close} aria-label="閉じる">
            ×
          </button>
        </div>
        {isEmpty ? (
          <>
            <p style={{ margin: '16px 0 8px', fontSize: 13, color: 'var(--tx2)', lineHeight: 1.6 }}>
              この空のフォルダを削除しますか？
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button ref={cancelRef} type="button" className="btn-ghost" onClick={close}>
                キャンセル
              </button>
              <button type="button" className="btn-primary" onClick={() => handle('moveToParent')}>
                削除
              </button>
            </div>
          </>
        ) : (
          <>
            <p style={{ margin: '16px 0 8px', fontSize: 13, color: 'var(--tx2)', lineHeight: 1.6 }}>
              中に <strong>{fileCount}</strong> 件のファイルがあります。
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 }}>
              <button type="button" className="btn-primary" onClick={() => handle('moveToParent')}>
                ファイルとサブフォルダを上の階層に移動して削除
              </button>
              <button
                type="button"
                style={{
                  padding: '7px 14px',
                  background: 'none',
                  border: '1px solid var(--bd)',
                  borderRadius: 6,
                  cursor: 'pointer',
                  fontSize: 13,
                  color: 'var(--tx)',
                  fontFamily: 'inherit',
                }}
                onClick={() => handle('deleteAll')}
              >
                ファイルも一緒に削除
              </button>
              <button
                ref={cancelRef}
                type="button"
                style={{
                  padding: '7px 14px',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 13,
                  color: 'var(--tx3)',
                  fontFamily: 'inherit',
                }}
                onClick={close}
              >
                キャンセル
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
