import { useApp } from '../../context/AppContext';
import { useUIStore } from '../../stores/uiStore';
import NameInputModal from './NameInputModal';

// NameInputModal のグローバル mount（DeleteFolderModal と同方式）。
// FileDropdown（.fdrop）は transform + overflow:hidden を持つため、内側で描画すると
// overlay の position:fixed がドロップダウン基準になりクリップされる。
export default function NameInputModalHost() {
  const { createWork, renameFile } = useApp();
  const nameInputModal = useUIStore((s) => s.nameInputModal);
  const setNameInputModal = useUIStore((s) => s.setNameInputModal);

  if (!nameInputModal) return null;

  const close = () => setNameInputModal(null);

  if (nameInputModal.mode === 'work') {
    return (
      <NameInputModal title="新規作品を作成" submitLabel="作成" onSubmit={createWork} onClose={close} />
    );
  }
  if (nameInputModal.mode === 'rename') {
    return (
      <NameInputModal
        title="名前を変更"
        initialValue={nameInputModal.initial}
        submitLabel="変更"
        onSubmit={(name) => renameFile(nameInputModal.fileId, name)}
        onClose={close}
      />
    );
  }
  return null;
}
