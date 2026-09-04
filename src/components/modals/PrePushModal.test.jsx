import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import PrePushModal from './PrePushModal';
import { useUIStore } from '../../stores/uiStore';

// #394 G3: pull は local の github.sha を保持する（src/lib/sync.js の mergePulledGithub）。
// この保持が正しくないと、isFirstPush（github.sha == null && remote === null）と
// isRemoteAhead（remote !== null && remote.sha !== github.sha）の判定が誤発火する
// （sha が意図せず null になった state で isFirstPush が誤って true になる等）。
// ここでは PrePushModal 自身のこの 2 条件をロックする。

vi.mock('../../lib/github', () => ({
  getFileContent: vi.fn(),
  getRepo: vi.fn(),
}));
vi.mock('../../lib/diffCore', () => ({
  computeDiffAsync: vi.fn().mockResolvedValue({ rows: [], meta: {} }),
}));

import { getFileContent, getRepo } from '../../lib/github';

const FIRST_PUSH_LABEL = '初めてこのリポジトリに書き込むことを確認しました';
const REMOTE_AHEAD_LABEL = 'リモートの変更を上書きすることを確認しました';

function setModal(file) {
  useUIStore.setState({
    prePushModal: { file, commitMessage: 'msg', onConfirm: vi.fn(), onCancel: vi.fn() },
  });
}

describe('PrePushModal — github.sha の isFirstPush / isRemoteAhead 判定（#394 G3）', () => {
  afterEach(() => {
    useUIStore.setState({ prePushModal: null });
    vi.clearAllMocks();
  });

  it('github.sha が null でも remote が実在すれば isRemoteAhead を要求し、isFirstPush は出さない', async () => {
    getFileContent.mockResolvedValue({ content: 'remote content', sha: 'remote-sha' });
    getRepo.mockResolvedValue({ default_branch: 'main' });
    setModal({
      id: 'a', name: 'a.md', content: 'local content',
      github: { owner: 'o', repo: 'r', branch: 'main', path: 'a.md', sha: null },
    });

    render(<PrePushModal />);

    await waitFor(() => expect(screen.getByText(REMOTE_AHEAD_LABEL)).toBeInTheDocument());
    expect(screen.queryByText(FIRST_PUSH_LABEL)).toBeNull();
  });

  it('github.sha が null で remote が不在（初回 push）なら isFirstPush を要求し、isRemoteAhead は出さない', async () => {
    getFileContent.mockRejectedValue(new Error('リソースが見つかりません。'));
    getRepo.mockResolvedValue(null);
    setModal({
      id: 'a', name: 'a.md', content: 'local content',
      github: { owner: 'o', repo: 'r', branch: 'main', path: 'a.md', sha: null },
    });

    render(<PrePushModal />);

    await waitFor(() => expect(screen.getByText(FIRST_PUSH_LABEL)).toBeInTheDocument());
    expect(screen.queryByText(REMOTE_AHEAD_LABEL)).toBeNull();
  });

  it('github.sha が local の値を保持していれば、remote の sha と一致する限り isRemoteAhead を出さない', async () => {
    getFileContent.mockResolvedValue({ content: 'same content', sha: 'same-sha' });
    getRepo.mockResolvedValue({ default_branch: 'main' });
    setModal({
      id: 'a', name: 'a.md', content: 'same content',
      github: { owner: 'o', repo: 'r', branch: 'main', path: 'a.md', sha: 'same-sha' },
    });

    render(<PrePushModal />);

    await waitFor(() => expect(screen.getByText('差分なし')).toBeInTheDocument());
    expect(screen.queryByText(REMOTE_AHEAD_LABEL)).toBeNull();
    expect(screen.queryByText(FIRST_PUSH_LABEL)).toBeNull();
  });
});
