import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import DeleteFolderModal from './DeleteFolderModal';
import { useUIStore } from '../../stores/uiStore';

const mockApp = {
  deleteFolder: vi.fn(),
};

vi.mock('../../context/AppContext', () => ({
  useApp: () => mockApp,
}));

describe('DeleteFolderModal — empty folder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ deleteFolderModal: null });
  });

  afterEach(() => {
    useUIStore.setState({ deleteFolderModal: null });
  });

  it('空フォルダは単純確認を表示し、確定で moveToParent 削除を実行する', () => {
    useUIStore.setState({
      deleteFolderModal: {
        folderId: 'folder-1',
        folderName: '空フォルダ',
        folderParentId: null,
        fileCount: 0,
      },
    });

    render(<DeleteFolderModal />);
    expect(screen.getByText('このフォルダを削除しますか？')).toBeInTheDocument();
    expect(screen.queryByText(/件のファイルがあります/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '削除' }));

    expect(mockApp.deleteFolder).toHaveBeenCalledWith('folder-1', 'moveToParent');
    expect(useUIStore.getState().deleteFolderModal).toBeNull();
  });
});
