import { useState, useEffect } from 'react';
import { useUIStore } from '../../stores/uiStore';
import { clearAllLocalData } from '../../lib/clearLocalData';

export default function ClearDataModal() {
  const clearDataModal = useUIStore((s) => s.clearDataModal);
  const setClearDataModal = useUIStore((s) => s.setClearDataModal);
  const addToast = useUIStore((s) => s.addToast);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!clearDataModal) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && !busy) setClearDataModal(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [clearDataModal, busy, setClearDataModal]);

  if (!clearDataModal) return null;

  const close = () => {
    if (!busy) setClearDataModal(null);
  };

  const handleDelete = async () => {
    setBusy(true);
    try {
      await clearAllLocalData(); // 成功時はリロードするため以降は実行されない
    } catch (e) {
      console.error('ローカルデータ削除に失敗しました', e);
      addToast('ローカルデータの削除に失敗しました。');
      setBusy(false);
      setClearDataModal(null);
    }
  };

  return (
    <div className="overlay" onClick={close}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        <div className="mtitle">
          <span>ローカルデータをすべて削除</span>
          <button type="button" className="mclose" onClick={close} disabled={busy}>
            ×
          </button>
        </div>
        <p style={{ margin: '16px 0 8px', fontSize: 13, color: 'var(--tx2)', lineHeight: 1.7 }}>
          この端末に保存された <strong>本文・ファイル・フォルダ・設定・連携情報</strong>{' '}
          をすべて削除し、初期状態に戻します。
          <br />
          <strong style={{ color: 'var(--err, #e74c3c)' }}>この操作は取り消せません。</strong>
          GitHub に push 済みの内容は影響を受けません。
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 }}>
          <button
            type="button"
            style={{
              padding: '8px 14px',
              background: 'var(--err, #e74c3c)',
              border: 'none',
              borderRadius: 6,
              cursor: busy ? 'default' : 'pointer',
              fontSize: 13,
              color: '#fff',
              fontFamily: 'inherit',
              opacity: busy ? 0.7 : 1,
            }}
            onClick={handleDelete}
            disabled={busy}
          >
            {busy ? '削除中…' : 'すべて削除する'}
          </button>
          <button
            type="button"
            style={{
              padding: '7px 14px',
              background: 'none',
              border: 'none',
              cursor: busy ? 'default' : 'pointer',
              fontSize: 13,
              color: 'var(--tx3)',
              fontFamily: 'inherit',
            }}
            onClick={close}
            disabled={busy}
          >
            キャンセル
          </button>
        </div>
      </div>
    </div>
  );
}
