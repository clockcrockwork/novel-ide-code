import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import DeleteFileModal from './DeleteFileModal';
import { useUIStore } from '../../stores/uiStore';

describe('DeleteFileModal', () => {
  beforeEach(() => {
    useUIStore.setState({ deleteFileModal: null });
  });

  afterEach(() => {
    useUIStore.setState({ deleteFileModal: null });
  });

  it('キャンセルでは削除 callback を呼ばない', () => {
    const onConfirm = vi.fn();
    useUIStore.setState({
      deleteFileModal: { fileId: 'f1', fileName: '第一章.md', onConfirm },
    });

    render(<DeleteFileModal />);
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(useUIStore.getState().deleteFileModal).toBeNull();
  });

  it('削除確定で callback を1回だけ呼んで閉じる', () => {
    const onConfirm = vi.fn();
    useUIStore.setState({
      deleteFileModal: { fileId: 'f1', fileName: '第一章.md', onConfirm },
    });

    render(<DeleteFileModal />);
    fireEvent.click(screen.getByRole('button', { name: '削除' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(useUIStore.getState().deleteFileModal).toBeNull();
  });
});
