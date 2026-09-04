import { useApp } from '../../context/AppContext';
import { useUIStore } from '../../stores/uiStore';

export default function DeleteFolderModal() {
  const { deleteFolder } = useApp();
  const deleteFolderModal = useUIStore((s) => s.deleteFolderModal);
  const setDeleteFolderModal = useUIStore((s) => s.setDeleteFolderModal);

  if (!deleteFolderModal) return null;

  const { folderId, folderName, fileCount } = deleteFolderModal;

  const close = () => setDeleteFolderModal(null);

  const handle = (strategy) => {
    deleteFolder(folderId, strategy);
    close();
  };

  return (
    <div className="overlay" onClick={close}>
      <div className="modal" style={{ maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
        <div className="mtitle">
          <span>「{folderName}」を削除</span>
          <button type="button" className="mclose" onClick={close}>
            ×
          </button>
        </div>
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
