import { useEffect, useRef } from 'react';
import { useUIStore } from '../../stores/uiStore';

export default function PasteConfirmModal() {
  const modal = useUIStore((s) => s.pasteConfirmModal);
  const setPasteConfirmModal = useUIStore((s) => s.setPasteConfirmModal);
  const modalRef = useRef(null);

  useEffect(() => {
    if (!modal) return;
    // モーダルを開く前のフォーカス要素を記録し、閉じた後に戻す（WAI-ARIA APG）。
    // autoFocus は React の commit 後・useEffect 前に実行されるため JSX 側では使わず
    // ここで先に previousFocus を取得してから手動フォーカスする。
    const previousFocus = document.activeElement;
    // btn-primary（変換して貼り付け）を優先してフォーカスし、×ボタンへの誤フォーカスを防ぐ
    (
      modalRef.current?.querySelector('.btn-primary') ?? modalRef.current?.querySelector('button')
    )?.focus();

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        setPasteConfirmModal(null);
        return;
      }
      if (e.key === 'Tab') {
        if (!modalRef.current) return;
        const focusables = modalRef.current.querySelectorAll('button, [tabindex="0"]');
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const activeEl = document.activeElement;
        if (!modalRef.current.contains(activeEl)) {
          first.focus();
          e.preventDefault();
          return;
        }
        if (e.shiftKey) {
          if (activeEl === first) {
            last.focus();
            e.preventDefault();
          }
        } else {
          if (activeEl === last) {
            first.focus();
            e.preventDefault();
          }
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus();
    };
  }, [modal, setPasteConfirmModal]);

  if (!modal) return null;

  const { warnSummary, onConfirm, onCancel } = modal;

  const close = () => setPasteConfirmModal(null);

  return (
    <div className="overlay" onClick={close}>
      <div
        ref={modalRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="paste-confirm-title"
        style={{ maxWidth: 400 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mtitle">
          <span id="paste-confirm-title">貼り付けの確認</span>
          <button type="button" className="mclose" onClick={close}>
            ×
          </button>
        </div>
        {warnSummary && (
          <p
            style={{
              margin: '16px 0 0',
              fontSize: 13,
              color: 'var(--warn, #e8a838)',
              lineHeight: 1.6,
            }}
          >
            不可視文字が含まれています: {warnSummary}
          </p>
        )}
        <p style={{ margin: '12px 0 0', fontSize: 13, color: 'var(--tx2)', lineHeight: 1.6 }}>
          貼り付けたテキスト内に記法が見つかりました。スタイルに変換して貼り付けますか？
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 }}>
          <button type="button" className="btn-primary" onClick={onConfirm}>
            変換して貼り付け
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
            onClick={onCancel}
          >
            そのまま貼り付け
          </button>
          <button
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
      </div>
    </div>
  );
}
