import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import DeleteFileModal from './DeleteFileModal';
import { useUIStore } from '../../stores/uiStore';

const mockApp = {
  deleteFile: vi.fn(),
};

vi.mock('../../context/AppContext', () => ({
  useApp: () => mockApp,
}));

describe('DeleteFileModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ deleteFileModal: null });
  });

  afterEach(() => {
    useUIStore.setState({ deleteFileModal: null });
  });

  it('キャンセルでは削除を呼ばない', () => {
    const onDeleted = vi.fn();
    useUIStore.setState({
      deleteFileModal: { fileId: 'f1', fileName: '第一章.md', onDeleted },
    });

    render(<DeleteFileModal />);
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));

    expect(mockApp.deleteFile).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(useUIStore.getState().deleteFileModal).toBeNull();
  });

  it('削除確定時に current AppContext の deleteFile を使い、完了callbackを呼んで閉じる', () => {
    const onDeleted = vi.fn();
    useUIStore.setState({
      deleteFileModal: { fileId: 'f1', fileName: '第一章.md', onDeleted },
    });

    render(<DeleteFileModal />);
    fireEvent.click(screen.getByRole('button', { name: '削除' }));

    expect(mockApp.deleteFile).toHaveBeenCalledTimes(1);
    expect(mockApp.deleteFile).toHaveBeenCalledWith('f1');
    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(useUIStore.getState().deleteFileModal).toBeNull();
  });
});
