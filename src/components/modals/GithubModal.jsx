import { useState, useEffect, useCallback, useMemo } from 'react';
import { useApp } from '../../context/AppContext';
import { useUIStore } from '../../stores/uiStore';
import { GhIcon } from '../Icons';
import {
  listRepos,
  getRepo,
  getContents,
  getFileContent,
  listBranches,
  listPRs,
  authorizeRepo,
} from '../../lib/github';
import {
  validatePulledContent,
  pullDenyReason,
  pullWarnMessage,
  toSecurityRecord,
} from '../../lib/security/validatePulledContent';
import { safeExternalHref } from '../../lib/security/validateUrl';

function Spinner() {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 14,
        height: 14,
        border: '2px solid var(--bd)',
        borderTopColor: 'var(--ac)',
        borderRadius: '50%',
        animation: 'spin 0.7s linear infinite',
        verticalAlign: 'middle',
        marginRight: 6,
      }}
    />
  );
}

function BackBtn({ onClick, label = '← 戻る' }) {
  return (
    <button
      type="button"
      className="btn-ghost"
      style={{ fontSize: 11, padding: '3px 8px', marginBottom: 10 }}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export default function GithubModal() {
  const {
    ghUser,
    ghOpenTarget,
    loginWithGithub,
    disconnectGithub,
    openGithubModal,
    openFileFromGithub,
    openSplitFileFromGithub,
    currentFile,
    switchBranch,
    createPRFromCurrent,
    mergePRForCurrent,
  } = useApp();
  const setShowGithub = useUIStore((s) => s.setShowGithub);
  const addToast = useUIStore((s) => s.addToast);
  const ghView = useUIStore((s) => s.ghView);
  const authError = useUIStore((s) => s.authError);
  const clearAuthError = useUIStore((s) => s.clearAuthError);

  // Initialize view from the UI store (component re-mounts each open)
  const [view, setView] = useState(() => (ghUser ? ghView : 'auth'));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Repos view
  const [repos, setRepos] = useState([]);
  const [repoFilter, setRepoFilter] = useState('');

  // Files view
  const [selectedRepo, setSelectedRepo] = useState(null); // { owner, name, branch }
  const [pathStack, setPathStack] = useState([]); // array of { path, name }
  const [entries, setEntries] = useState([]);
  const [loadingEntry, setLoadingEntry] = useState(null);

  // Branch switcher view
  const [branches, setBranches] = useState([]);

  // PR list view
  const [prs, setPrs] = useState([]);

  // PR creation form
  const [prTitle, setPrTitle] = useState('');
  const [prBody, setPrBody] = useState('');
  const [prHead, setPrHead] = useState('');
  const [prBase, setPrBase] = useState('main');
  const [prCreateSuccess, setPrCreateSuccess] = useState(null);

  const currentPath = pathStack.length > 0 ? pathStack[pathStack.length - 1].path : '';

  const loadRepos = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await listRepos();
      setRepos(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadEntries = useCallback(
    async (path) => {
      if (!selectedRepo) return;
      setLoading(true);
      setError('');
      try {
        const data = await getContents(
          selectedRepo.owner,
          selectedRepo.name,
          path,
          selectedRepo.branch,
        );
        const sorted = [...data].sort((a, b) => {
          if (a.type === b.type) return a.name.localeCompare(b.name, 'ja');
          return a.type === 'dir' ? -1 : 1;
        });
        setEntries(sorted);
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    },
    [selectedRepo],
  );

  const loadBranches = useCallback(async (owner, repo) => {
    setLoading(true);
    setError('');
    try {
      await authorizeRepo(owner, repo);
      const data = await listBranches(owner, repo);
      setBranches(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPRs = useCallback(async (owner, repo) => {
    setLoading(true);
    setError('');
    try {
      await authorizeRepo(owner, repo);
      const data = await listPRs(owner, repo);
      setPrs(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const resetPRForm = useCallback((branch) => {
    setPrHead(branch || '');
    setPrTitle('');
    setPrBody('');
    setPrBase('main');
    setPrCreateSuccess(null);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- view 変化をトリガーとした非同期データ取得、派生状態ではない
    if (view === 'repos' && ghUser) loadRepos();
  }, [view, ghUser, loadRepos]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- パスナビゲーション時の非同期データ取得、派生状態ではない
    if (view === 'files' && selectedRepo) loadEntries(currentPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, selectedRepo, pathStack, loadEntries]);

  useEffect(() => {
    const gh = currentFile?.github;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- view変化時のデータ取得、派生状態ではない
    if (view === 'branches' && ghUser && gh) loadBranches(gh.owner, gh.repo);
  }, [view, ghUser, currentFile?.github, loadBranches]);

  useEffect(() => {
    const gh = currentFile?.github;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- view変化時のデータ取得、派生状態ではない
    if (view === 'prs' && ghUser && gh) loadPRs(gh.owner, gh.repo);
  }, [view, ghUser, currentFile?.github, loadPRs]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- view変化時のフォームリセット、派生状態ではない
    if (view === 'create-pr') resetPRForm(currentFile?.github?.branch);
  }, [view, resetPRForm]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSelectRepo(repo) {
    setLoading(true);
    setError('');
    try {
      await authorizeRepo(repo.owner.login, repo.name);
      const info = await getRepo(repo.owner.login, repo.name);
      setSelectedRepo({ owner: repo.owner.login, name: repo.name, branch: info.default_branch });
      setPathStack([]);
      setEntries([]);
      setView('files');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleOpenFile(entry) {
    setLoadingEntry(entry.path);
    setError('');
    try {
      const { content, sha, name } = await getFileContent(
        selectedRepo.owner,
        selectedRepo.name,
        entry.path,
        selectedRepo.branch,
      );
      // pull した EXTERNAL データを preview/エディタに渡す前に検証する（#285）
      const validation = validatePulledContent(content, name);
      if (validation.decision === 'deny') {
        setError(pullDenyReason(validation));
        return;
      }
      const opener = ghOpenTarget === 'secondary' ? openSplitFileFromGithub : openFileFromGithub;
      const ok = opener({
        name: validation.safeName,
        content,
        owner: selectedRepo.owner,
        repo: selectedRepo.name,
        path: entry.path,
        sha,
        branch: selectedRepo.branch,
        security: toSecurityRecord(validation),
      });
      if (ok === false) {
        setError('ファイルが大きすぎて開けません（上限: 500万文字）');
        return;
      }
      if (validation.decision === 'warn') {
        const msg = pullWarnMessage(validation);
        if (msg) addToast(msg, 6000);
      }
      setShowGithub(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingEntry(null);
    }
  }

  async function handleSaveHere() {
    if (!currentFile) return;
    setLoading(true);
    setError('');
    try {
      const filePath = `${currentPath ? currentPath + '/' : ''}${currentFile.name}`;
      const existing = await getFileContent(
        selectedRepo.owner,
        selectedRepo.name,
        filePath,
        selectedRepo.branch,
      ).catch(() => null);
      const ok = openFileFromGithub({
        name: currentFile.name,
        content: currentFile.content,
        owner: selectedRepo.owner,
        repo: selectedRepo.name,
        path: filePath,
        sha: existing?.sha || null,
        branch: selectedRepo.branch,
      });
      if (ok === false) {
        setError('ファイルが大きすぎて開けません（上限: 500万文字）');
        return;
      }
      setShowGithub(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleSwitchBranch(branch) {
    setLoading(true);
    setError('');
    try {
      if (await switchBranch(branch)) setShowGithub(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleMergePR(pr) {
    if (!window.confirm(`PR #${pr.number}「${pr.title}」をマージしますか？`)) return;
    setLoading(true);
    setError('');
    try {
      await mergePRForCurrent(pr.number);
      setPrs((prev) => prev.filter((p) => p.number !== pr.number));
      await switchBranch(pr.base.ref);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreatePR() {
    const title = prTitle.trim();
    const head = prHead.trim();
    const base = prBase.trim();
    if (!title) {
      setError('タイトルを入力してください。');
      return;
    }
    if (!head || !base) {
      setError('ブランチ名を入力してください。');
      return;
    }
    if (head === base) {
      setError('変更元とマージ先には異なるブランチを指定してください。');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await createPRFromCurrent({ title, body: prBody, head, base });
      setPrCreateSuccess({ url: result.html_url, number: result.number });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  const filteredRepos = useMemo(
    () =>
      repos.filter((r) =>
        `${r.owner.login}/${r.name}`.toLowerCase().includes(repoFilter.toLowerCase()),
      ),
    [repos, repoFilter],
  );

  // GitHub API 由来（EXTERNAL）の URL は href/src に使う前に検証する（audit M2）。
  const avatarSrc = safeExternalHref(ghUser?.avatar_url);
  const prSuccessUrl = safeExternalHref(prCreateSuccess?.url);

  const close = () => setShowGithub(false);

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && close()}>
      <div
        className="modal"
        style={{ maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16, flexShrink: 0 }}>
          <span className="mtitle">
            <GhIcon s={16} />
            GitHub 連携
          </span>
          {ghOpenTarget === 'secondary' && (
            <span className="tag" style={{ marginLeft: 8 }}>
              分割で開く
            </span>
          )}
          <button type="button" className="mclose" onClick={close}>
            ×
          </button>
        </div>

        {/* Auth view */}
        {view === 'auth' && (
          <div>
            <p style={{ color: 'var(--tx2)', fontSize: 13, lineHeight: 1.7, marginBottom: 20 }}>
              GitHub
              でログインして、リポジトリのファイルを直接開いたり保存できます。タブを閉じてもログイン状態が維持されます。
            </p>
            {authError && (
              <div style={{ color: 'var(--ac-red, #e74c3c)', fontSize: 12, marginBottom: 12 }}>
                GitHubログインに失敗しました。再度お試しください。
              </div>
            )}
            {error && (
              <div style={{ color: 'var(--err, #e74c3c)', fontSize: 12, marginBottom: 12 }}>
                {error}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'center', gap: 8 }}>
              <button type="button" className="btn-ghost" onClick={close}>
                キャンセル
              </button>
              <button
                type="button"
                className="btn-primary"
                style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                onClick={() => {
                  clearAuthError();
                  loginWithGithub();
                }}
              >
                <GhIcon s={14} />
                GitHub でログイン
              </button>
            </div>
          </div>
        )}

        {/* Repos view */}
        {view === 'repos' && (
          <>
            {/* User info */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 12,
                flexShrink: 0,
              }}
            >
              {avatarSrc && (
                <img
                  src={avatarSrc}
                  alt=""
                  style={{ width: 28, height: 28, borderRadius: '50%' }}
                />
              )}
              <span style={{ fontSize: 13, fontWeight: 600 }}>@{ghUser?.login}</span>
              <button
                type="button"
                className="btn-ghost"
                style={{ marginLeft: 'auto', fontSize: 11 }}
                onClick={() => {
                  disconnectGithub();
                  setView('auth');
                }}
              >
                切断
              </button>
            </div>

            {/* Current file link status */}
            {currentFile?.github && (
              <div
                style={{
                  background: 'var(--sf2)',
                  borderRadius: 'var(--r)',
                  padding: '8px 10px',
                  marginBottom: 10,
                  fontSize: 12,
                  flexShrink: 0,
                }}
              >
                <span style={{ color: 'var(--tx2)' }}>リンク済み: </span>
                <span style={{ color: 'var(--ac)', fontFamily: 'monospace', fontSize: 11 }}>
                  {currentFile.github.owner}/{currentFile.github.repo}/{currentFile.github.path}
                </span>
              </div>
            )}

            {/* Search */}
            <input
              className="sinput"
              placeholder="リポジトリを検索…"
              style={{ marginBottom: 8, flexShrink: 0 }}
              value={repoFilter}
              onChange={(e) => setRepoFilter(e.target.value)}
            />

            {error && (
              <div
                style={{
                  color: 'var(--err, #e74c3c)',
                  fontSize: 12,
                  marginBottom: 8,
                  flexShrink: 0,
                }}
              >
                {error}
              </div>
            )}

            {/* Repo list */}
            <div
              style={{
                overflowY: 'auto',
                flex: 1,
                background: 'var(--sf2)',
                borderRadius: 'var(--r)',
              }}
            >
              {loading ? (
                <div style={{ padding: 16, textAlign: 'center', color: 'var(--tx3)' }}>
                  <Spinner />
                  読み込み中…
                </div>
              ) : filteredRepos.length === 0 ? (
                <div
                  style={{ padding: 16, textAlign: 'center', color: 'var(--tx3)', fontSize: 13 }}
                >
                  リポジトリが見つかりません
                </div>
              ) : (
                filteredRepos.map((repo) => (
                  <button
                    type="button"
                    key={repo.id}
                    className="gh-list-item"
                    onClick={() => handleSelectRepo(repo)}
                  >
                    <span
                      style={{
                        flex: 1,
                        fontSize: 13,
                        fontFamily: 'monospace',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {repo.owner.login}/{repo.name}
                    </span>
                    {repo.private && (
                      <span
                        style={{
                          fontSize: 10,
                          background: 'var(--bd)',
                          borderRadius: 3,
                          padding: '1px 5px',
                          flexShrink: 0,
                        }}
                      >
                        private
                      </span>
                    )}
                    <span style={{ fontSize: 11, color: 'var(--tx3)', flexShrink: 0 }}>
                      {new Date(repo.updated_at).toLocaleDateString('ja-JP')}
                    </span>
                  </button>
                ))
              )}
            </div>
          </>
        )}

        {/* Files view */}
        {view === 'files' && selectedRepo && (
          <>
            <div style={{ flexShrink: 0 }}>
              <BackBtn
                onClick={() => {
                  setView('repos');
                  setPathStack([]);
                  setEntries([]);
                }}
                label="← リポジトリ一覧"
              />

              {/* Breadcrumb */}
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--tx2)',
                  marginBottom: 8,
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 4,
                  alignItems: 'center',
                }}
              >
                <span
                  style={{ cursor: 'pointer', color: 'var(--ac)' }}
                  onClick={() => setPathStack([])}
                >
                  {selectedRepo.owner}/{selectedRepo.name}
                </span>
                {pathStack.map((p, i) => (
                  <span key={p.path} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ color: 'var(--tx3)' }}>/</span>
                    <span
                      style={{
                        cursor: i < pathStack.length - 1 ? 'pointer' : 'default',
                        color: i < pathStack.length - 1 ? 'var(--ac)' : 'var(--tx)',
                      }}
                      onClick={() =>
                        i < pathStack.length - 1 && setPathStack(pathStack.slice(0, i + 1))
                      }
                    >
                      {p.name}
                    </span>
                  </span>
                ))}
              </div>

              {/* Save current file here button */}
              {ghOpenTarget !== 'secondary' && currentFile && !currentFile.github && (
                <button
                  type="button"
                  className="btn-ghost"
                  style={{ fontSize: 11, width: '100%', marginBottom: 8 }}
                  onClick={handleSaveHere}
                  disabled={loading}
                >
                  {loading ? (
                    <>
                      <Spinner />
                      保存中…
                    </>
                  ) : (
                    `📤 「${currentFile.name}」をここに保存`
                  )}
                </button>
              )}

              {error && (
                <div style={{ color: 'var(--err, #e74c3c)', fontSize: 12, marginBottom: 8 }}>
                  {error}
                </div>
              )}
            </div>

            {/* File list */}
            <div
              style={{
                overflowY: 'auto',
                flex: 1,
                background: 'var(--sf2)',
                borderRadius: 'var(--r)',
              }}
            >
              {loading && entries.length === 0 ? (
                <div style={{ padding: 16, textAlign: 'center', color: 'var(--tx3)' }}>
                  <Spinner />
                  読み込み中…
                </div>
              ) : (
                entries.map((entry) =>
                  entry.type === 'dir' ? (
                    <button
                      type="button"
                      key={entry.path}
                      className="gh-list-item"
                      onClick={() =>
                        setPathStack((p) => [...p, { path: entry.path, name: entry.name }])
                      }
                    >
                      <span style={{ fontSize: 12, flexShrink: 0 }}>📁</span>
                      <span
                        style={{
                          flex: 1,
                          fontSize: 12.5,
                          fontFamily: 'monospace',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {entry.name}
                      </span>
                    </button>
                  ) : (
                    <div key={entry.path} className="gh-list-item gh-list-item--file">
                      <span style={{ fontSize: 12, flexShrink: 0 }}>📄</span>
                      <span
                        style={{
                          flex: 1,
                          fontSize: 12.5,
                          fontFamily: 'monospace',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {entry.name}
                      </span>
                      {entry.name.endsWith('.md') ? (
                        <button
                          type="button"
                          className="btn-primary"
                          style={{ fontSize: 11, padding: '3px 8px', flexShrink: 0 }}
                          disabled={loadingEntry === entry.path}
                          onClick={() => handleOpenFile(entry)}
                        >
                          {loadingEntry === entry.path ? <Spinner /> : '開く'}
                        </button>
                      ) : (
                        <span style={{ fontSize: 11, color: 'var(--tx3)', flexShrink: 0 }}>
                          {entry.size > 1024
                            ? `${Math.round(entry.size / 1024)}KB`
                            : `${entry.size}B`}
                        </span>
                      )}
                    </div>
                  ),
                )
              )}
            </div>
          </>
        )}

        {/* Branches view */}
        {view === 'branches' && (
          <>
            <BackBtn onClick={() => setView('repos')} />
            {!currentFile?.github ? (
              <div style={{ color: 'var(--tx3)', fontSize: 13 }}>
                現在のファイルは GitHub に連携されていません。
              </div>
            ) : (
              <>
                <div style={{ fontSize: 12, color: 'var(--tx2)', marginBottom: 10 }}>
                  現在のブランチ:{' '}
                  <span style={{ fontFamily: 'monospace', color: 'var(--ac)' }}>
                    {currentFile.github.branch}
                  </span>
                </div>
                {error && (
                  <div style={{ color: 'var(--err, #e74c3c)', fontSize: 12, marginBottom: 8 }}>
                    {error}
                  </div>
                )}
                <div
                  style={{
                    overflowY: 'auto',
                    flex: 1,
                    background: 'var(--sf2)',
                    borderRadius: 'var(--r)',
                  }}
                >
                  {loading ? (
                    <div style={{ padding: 16, textAlign: 'center', color: 'var(--tx3)' }}>
                      <Spinner />
                      読み込み中…
                    </div>
                  ) : (
                    branches.map((b) => (
                      <button
                        type="button"
                        key={b.name}
                        className="gh-list-item"
                        disabled={b.name === currentFile.github.branch || loading}
                        onClick={() => handleSwitchBranch(b.name)}
                      >
                        <span style={{ fontFamily: 'monospace', fontSize: 12, flex: 1 }}>
                          {b.name}
                        </span>
                        {b.name === currentFile.github.branch && (
                          <span style={{ fontSize: 10, color: 'var(--ac)' }}>現在</span>
                        )}
                      </button>
                    ))
                  )}
                </div>
              </>
            )}
          </>
        )}

        {/* PRs view */}
        {view === 'prs' && (
          <>
            <BackBtn onClick={() => setView('repos')} />
            {!currentFile?.github ? (
              <div style={{ color: 'var(--tx3)', fontSize: 13 }}>
                現在のファイルは GitHub に連携されていません。
              </div>
            ) : (
              <>
                <button
                  type="button"
                  className="btn-primary"
                  style={{ fontSize: 11, marginBottom: 10, width: '100%' }}
                  onClick={() => setView('create-pr')}
                >
                  ＋ 新しい PR を作成
                </button>
                {error && (
                  <div style={{ color: 'var(--err, #e74c3c)', fontSize: 12, marginBottom: 8 }}>
                    {error}
                  </div>
                )}
                <div
                  style={{
                    overflowY: 'auto',
                    flex: 1,
                    background: 'var(--sf2)',
                    borderRadius: 'var(--r)',
                  }}
                >
                  {loading ? (
                    <div style={{ padding: 16, textAlign: 'center', color: 'var(--tx3)' }}>
                      <Spinner />
                      読み込み中…
                    </div>
                  ) : prs.length === 0 ? (
                    <div
                      style={{
                        padding: 16,
                        textAlign: 'center',
                        color: 'var(--tx3)',
                        fontSize: 13,
                      }}
                    >
                      オープンな PR はありません
                    </div>
                  ) : (
                    prs.map((pr) => (
                      <div key={pr.number} className="gh-list-item gh-list-item--file">
                        <span
                          style={{
                            flex: 1,
                            fontSize: 12.5,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          #{pr.number} {pr.title}
                        </span>
                        <button
                          type="button"
                          className="btn-primary"
                          style={{ fontSize: 11, padding: '3px 8px', flexShrink: 0 }}
                          disabled={loading}
                          onClick={() => handleMergePR(pr)}
                        >
                          マージ
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </>
        )}

        {/* Create PR view */}
        {view === 'create-pr' && (
          <>
            <BackBtn onClick={() => setView('prs')} label="← PR 一覧" />
            {!currentFile?.github ? (
              <div style={{ color: 'var(--tx3)', fontSize: 13 }}>
                現在のファイルは GitHub に連携されていません。
              </div>
            ) : prCreateSuccess ? (
              <div style={{ textAlign: 'center', padding: 20 }}>
                <div style={{ fontSize: 13, marginBottom: 12 }}>
                  PR #{prCreateSuccess.number} を作成しました
                </div>
                {prSuccessUrl && (
                  <a
                    href={prSuccessUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'var(--ac)', fontSize: 12 }}
                  >
                    GitHub で確認する →
                  </a>
                )}
                <div style={{ marginTop: 16 }}>
                  <button type="button" className="btn-ghost" onClick={close}>
                    閉じる
                  </button>
                </div>
              </div>
            ) : (
              <>
                {error && (
                  <div style={{ color: 'var(--err, #e74c3c)', fontSize: 12, marginBottom: 8 }}>
                    {error}
                  </div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <label style={{ fontSize: 11, color: 'var(--tx2)' }}>タイトル</label>
                  <input
                    className="sinput"
                    placeholder="PR のタイトル"
                    value={prTitle}
                    onChange={(e) => setPrTitle(e.target.value)}
                  />
                  <label style={{ fontSize: 11, color: 'var(--tx2)' }}>説明（任意）</label>
                  <textarea
                    className="sinput"
                    rows={3}
                    placeholder="変更内容の説明…"
                    style={{ resize: 'vertical' }}
                    value={prBody}
                    onChange={(e) => setPrBody(e.target.value)}
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <div style={{ flex: 1 }}>
                      <label style={{ fontSize: 11, color: 'var(--tx2)' }}>変更元ブランチ</label>
                      <input
                        className="sinput"
                        value={prHead}
                        onChange={(e) => setPrHead(e.target.value)}
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={{ fontSize: 11, color: 'var(--tx2)' }}>マージ先ブランチ</label>
                      <input
                        className="sinput"
                        value={prBase}
                        onChange={(e) => setPrBase(e.target.value)}
                      />
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
                  <button type="button" className="btn-ghost" onClick={() => setView('prs')}>
                    キャンセル
                  </button>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={handleCreatePR}
                    disabled={loading}
                  >
                    {loading ? (
                      <>
                        <Spinner />
                        作成中…
                      </>
                    ) : (
                      'PR を作成'
                    )}
                  </button>
                </div>
              </>
            )}
          </>
        )}

        {/* Commit error view */}
        {view === 'commit' && (
          <div>
            <BackBtn onClick={() => setView('repos')} />
            <div style={{ color: 'var(--tx2)', fontSize: 13, marginBottom: 12 }}>
              保存先:{' '}
              <span style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--ac)' }}>
                {currentFile?.github
                  ? `${currentFile.github.owner}/${currentFile.github.repo}/${currentFile.github.path}`
                  : '—'}
              </span>
            </div>
            {error && (
              <div
                style={{
                  background: 'var(--sf2)',
                  borderRadius: 'var(--r)',
                  padding: 12,
                  color: 'var(--err, #e74c3c)',
                  fontSize: 13,
                  marginBottom: 12,
                }}
              >
                {error}
              </div>
            )}
            {!currentFile?.github && (
              <div style={{ color: 'var(--tx3)', fontSize: 13 }}>
                現在のファイルは GitHub に連携されていません。
                <br />
                「GitHubから開く」か「このフォルダに保存」で連携してください。
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
              <button type="button" className="btn-ghost" onClick={close}>
                閉じる
              </button>
              {currentFile?.github && (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => openGithubModal('repos')}
                >
                  リポジトリを開く
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
