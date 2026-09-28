import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import NameInputModalHost from './NameInputModalHost';
import { useUIStore } from '../../stores/uiStore';

const mockApp = {
  createWork: vi.fn(),
  renameFile: vi.fn(),
  createFolder: vi.fn(),
};

vi.mock('../../context/AppContext', () => ({
  useApp: () => mockApp,
}));

describe('NameInputModalHost — folder mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ nameInputModal: null });
  });

  afterEach(() => {
    useUIStore.setState({ nameInputModal: null });
  });

  it('folder 作成成功時だけ onCreated を呼んで閉じる', async () => {
    const onCreated = vi.fn();
    mockApp.createFolder.mockResolvedValue({ ok: true, folderId: 'folder-1' });
    useUIStore.setState({
      nameInputModal: { mode: 'folder', parentId: null, onCreated },
    });

    render(<NameInputModalHost />);
    fireEvent.change(screen.getByRole('textbox', { name: '新規フォルダを作成' }), {
      target: { value: '資料' },
    });
    fireEvent.click(screen.getByRole('button', { name: '作成' }));

    await waitFor(() => expect(mockApp.createFolder).toHaveBeenCalledWith('資料', null));
    expect(onCreated).toHaveBeenCalledWith({ ok: true, folderId: 'folder-1' });
    await waitFor(() => expect(useUIStore.getState().nameInputModal).toBeNull());
  });

  it('folder 作成失敗時はエラーを表示し、onCreated を呼ばず閉じない', async () => {
    const onCreated = vi.fn();
    mockApp.createFolder.mockResolvedValue({ ok: false, reason: 'フォルダの保存に失敗しました' });
    useUIStore.setState({
      nameInputModal: { mode: 'folder', parentId: 'parent-1', onCreated },
    });

    render(<NameInputModalHost />);
    fireEvent.change(screen.getByRole('textbox', { name: 'サブフォルダを作成' }), {
      target: { value: '子' },
    });
    fireEvent.click(screen.getByRole('button', { name: '作成' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('フォルダの保存に失敗しました');
    expect(mockApp.createFolder).toHaveBeenCalledWith('子', 'parent-1');
    expect(onCreated).not.toHaveBeenCalled();
    expect(useUIStore.getState().nameInputModal).not.toBeNull();
  });
});
