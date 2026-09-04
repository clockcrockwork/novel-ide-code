import { useEffect, useReducer, useRef, Fragment } from 'react';
import { useUIStore, uiActions } from '../../stores/uiStore';
import { getFileContent, getRepo } from '../../lib/github';
import { computeDiffAsync } from '../../lib/diffCore';
import { safeExternalHref } from '../../lib/security/validateUrl';

const MAX_DIFF_ROWS = 50;

const initialState = {
  phase: 'loading', // 'loading' | 'confirm' | 'committing' | 'success'
  remoteInfo: null, // null | { remote: {content,sha}|null, defaultBranch: string|null }
  diffRows: [],
  isFallbackDiff: false,
  fetchError: null, // null | string — リモート取得失敗時のメッセージ
  commitUrl: null,
  error: null,
  checkedFirst: false,
  checkedAhead: false,
};

function reducer(state, action) {
  switch (action.type) {
    case 'FETCH_START':
      return { ...initialState };
    case 'FETCH_SUCCESS':
      return {
        ...state,
        phase: 'confirm',
        remoteInfo: action.remoteInfo,
        diffRows: action.diffRows,
        isFallbackDiff: action.isFallback,
      };
    case 'FETCH_ERROR':
      return {
        ...state,
        phase: 'confirm',
        remoteInfo: { remote: null, defaultBranch: null },
        diffRows: [],
        isFallbackDiff: false,
        fetchError: 'リモート情報の取得に失敗しました。ネットワーク状態を確認してください。',
      };
    case 'COMMITTING':
      return { ...state, phase: 'committing', error: null };
    case 'COMMIT_SUCCESS':
      return { ...state, phase: 'success', commitUrl: action.url };
    case 'COMMIT_ERROR':
      return { ...state, phase: 'confirm', error: action.error };
    case 'SET_CHECKED_FIRST':
      return { ...state, checkedFirst: action.value };
    case 'SET_CHECKED_AHEAD':
      return { ...state, checkedAhead: action.value };
    default:
      return state;
  }
}

export default function PrePushModal() {
  const modal = useUIStore((s) => s.prePushModal);
  const modalRef = useRef(null);
  const phaseRef = useRef('loading');
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => { phaseRef.current = state.phase; }, [state.phase]);

  useEffect(() => {
    if (!modal) {
      dispatch({ type: 'FETCH_START' });
      return;
    }
    let cancelled = false;
    dispatch({ type: 'FETCH_START' });
    const { github } = modal.file;
    Promise.all([
      getFileContent(github.owner, github.repo, github.path, github.branch).catch((err) => {
        if (err.message === 'リソースが見つかりません。') return null;
        throw err;
      }),
      getRepo(github.owner, github.repo).catch(() => null),
    ])
      .then(async ([remote, repoInfo]) => {
        if (cancelled) return;
        const result = await computeDiffAsync(remote?.content ?? '', modal.file.content);
        if (cancelled) return;
        dispatch({
          type: 'FETCH_SUCCESS',
          remoteInfo: { remote, defaultBranch: repoInfo?.default_branch ?? null },
          diffRows: result.rows ?? [],
          isFallback: result.meta?.isFallback ?? false,
        });
      })
      .catch(() => {
        if (cancelled) return;
        dispatch({ type: 'FETCH_ERROR' });
      });
    return () => { cancelled = true; };
  }, [modal]);

  useEffect(() => {
    if (!modal) return;
    const previousFocus = document.activeElement;
    const onKeyDown = (e) => {
      const p = phaseRef.current;
      if (e.key === 'Escape' && p !== 'committing' && p !== 'loading') {
        modal.onCancel();
        return;
      }
      if (e.key === 'Tab' && modalRef.current) {
        const focusables = modalRef.current.querySelectorAll(
          'button:not([disabled]), input:not([disabled]), a[href]',
        );
        if (focusables.length === 0) { e.preventDefault(); return; }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (!modalRef.current.contains(active)) {
          first.focus();
          e.preventDefault();
          return;
        }
        if (e.shiftKey) {
          if (active === first) { last.focus(); e.preventDefault(); }
        } else {
          if (active === last) { first.focus(); e.preventDefault(); }
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus();
    };
  }, [modal]);

  useEffect(() => {
    if (state.phase !== 'confirm' && state.phase !== 'success') return;
    const btn =
      modalRef.current?.querySelector('.btn-primary:not([disabled])') ??
      modalRef.current?.querySelector('button');
    btn?.focus();
  }, [state.phase]);

  if (!modal) return null;

  const { file, commitMessage } = modal;
  const { github } = file;
  const { phase, remoteInfo, diffRows, isFallbackDiff, fetchError, commitUrl, error, checkedFirst, checkedAhead } = state;

  // commit URL は GitHub API 由来（EXTERNAL）。href に使う前に検証する（audit M2）。
  const safeCommitUrl = safeExternalHref(commitUrl);

  const remote = remoteInfo?.remote ?? null;
  const defaultBranch = remoteInfo?.defaultBranch ?? null;
  const isFirstPush = phase !== 'loading' && !fetchError && github.sha == null && remote === null;
  const isRemoteAhead = phase !== 'loading' && !fetchError && remote !== null && remote.sha !== github.sha;
  const isMainBranch = defaultBranch !== null && github.branch === defaultBranch;
  const removedCount = diffRows.filter((r) => r.type === 'removed').length;
  const isDestructive = removedCount > 20;
  const visibleRows = diffRows.slice(0, MAX_DIFF_ROWS);
  const hiddenCount = diffRows.length - visibleRows.length;
  const canSubmit = !fetchError && (!isFirstPush || checkedFirst) && (!isRemoteAhead || checkedAhead);

  const close = () => modal.onCancel();

  const handleConfirm = async () => {
    dispatch({ type: 'COMMITTING' });
    try {
      const url = await modal.onConfirm(remote !== null ? remote.sha : null);
      dispatch({ type: 'COMMIT_SUCCESS', url: url ?? null });
    } catch (e) {
      dispatch({ type: 'COMMIT_ERROR', error: e.message ?? 'エラーが発生しました' });
    }
  };

  return (
    <div
      className="overlay"
      role="presentation"
      onClick={phase === 'committing' ? undefined : close}
    >
      <div
        ref={modalRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pre-push-title"
        style={{ maxWidth: 520, width: '100%' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mtitle">
          <span id="pre-push-title">GitHubに保存</span>
          {phase !== 'committing' && phase !== 'loading' && (
            <button type="button" className="mclose" onClick={close}>
              ×
            </button>
          )}
        </div>

        {phase === 'loading' && (
          <p style={{ margin: '24px 0', fontSize: 13, color: 'var(--tx2)', textAlign: 'center' }}>
            リモートを確認中…
          </p>
        )}

        {(phase === 'confirm' || phase === 'committing') && (
          <>
            <dl style={dlStyle}>
              {[
                ['リポジトリ', `${github.owner}/${github.repo}`],
                ['ブランチ', github.branch],
                ['パス', github.path],
                ['コミット', commitMessage],
              ].map(([label, value]) => (
                <Fragment key={label}>
                  <dt style={dtStyle}>{label}</dt>
                  <dd style={ddStyle}>{value}</dd>
                </Fragment>
              ))}
            </dl>

            {isMainBranch && (
              <p style={warnStyle}>⚠️ デフォルトブランチ（{defaultBranch}）に直接 push します</p>
            )}
            {isRemoteAhead && (
              <p style={{ ...warnStyle, color: 'var(--ac-red, #e05c5c)' }}>
                ❗ リモートが更新されています（sha 不一致）。上書きすると変更が失われる可能性があります。
              </p>
            )}
            {isDestructive && (
              <p style={warnStyle}>⚠️ 大幅な削除が含まれます（{removedCount} 行削除）</p>
            )}

            {diffRows.length > 0 && (
              <div style={diffContainerStyle}>
                <div style={diffHeaderStyle}>
                  差分プレビュー{isFallbackDiff ? '（簡易）' : ''}
                </div>
                <div style={diffBodyStyle}>
                  {visibleRows.map((row, i) => (
                    <div
                      key={i}
                      className={`diff-line diff-${row.type}`}
                      style={{ paddingLeft: 8 }}
                    >
                      {row.type === 'added' ? '+' : row.type === 'removed' ? '−' : ' '}
                      {row.text}
                    </div>
                  ))}
                  {hiddenCount > 0 && (
                    <div style={{ padding: '2px 8px', fontSize: 11, color: 'var(--tx3)' }}>
                      …さらに {hiddenCount} 行
                    </div>
                  )}
                </div>
              </div>
            )}
            {diffRows.length === 0 && phase === 'confirm' && (
              <p style={{ margin: '12px 0 0', fontSize: 13, color: 'var(--tx3)' }}>差分なし</p>
            )}

            {isFirstPush && (
              <label style={checkStyle}>
                <input
                  type="checkbox"
                  checked={checkedFirst}
                  disabled={phase === 'committing'}
                  onChange={(e) => dispatch({ type: 'SET_CHECKED_FIRST', value: e.target.checked })}
                />
                <span>初めてこのリポジトリに書き込むことを確認しました</span>
              </label>
            )}
            {isRemoteAhead && (
              <label style={checkStyle}>
                <input
                  type="checkbox"
                  checked={checkedAhead}
                  disabled={phase === 'committing'}
                  onChange={(e) => dispatch({ type: 'SET_CHECKED_AHEAD', value: e.target.checked })}
                />
                <span>リモートの変更を上書きすることを確認しました</span>
              </label>
            )}

            {fetchError && (
              <p style={{ margin: '12px 0 0', fontSize: 13, color: 'var(--warn, #e8a838)' }}>
                ⚠️ {fetchError}
              </p>
            )}

            {error && (
              <p style={{ margin: '12px 0 0', fontSize: 13, color: 'var(--ac-red, #e05c5c)' }}>
                {error}
              </p>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="btn-ghost"
                onClick={close}
                disabled={phase === 'committing'}
              >
                キャンセル
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={handleConfirm}
                disabled={!canSubmit || phase === 'committing'}
              >
                {phase === 'committing' ? '保存中…' : '保存する'}
              </button>
            </div>
          </>
        )}

        {phase === 'success' && (
          <div style={{ margin: '24px 0 16px', textAlign: 'center' }}>
            <p style={{ fontSize: 14, color: 'var(--tx)', marginBottom: 12 }}>
              ✓ GitHubに保存しました
            </p>
            {safeCommitUrl && (
              <a
                href={safeCommitUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontSize: 12, color: 'var(--ac)', wordBreak: 'break-all', display: 'block' }}
              >
                {safeCommitUrl}
              </a>
            )}
            <div style={{ marginTop: 16 }}>
              <button type="button" className="btn-primary" onClick={() => uiActions.setPrePushModal(null)}>
                閉じる
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const dlStyle = {
  margin: '16px 0 0',
  fontSize: 12,
  lineHeight: 1.8,
  display: 'grid',
  gridTemplateColumns: 'auto 1fr',
  gap: '0 12px',
};

const dtStyle = { color: 'var(--tx3)', whiteSpace: 'nowrap' };

const ddStyle = {
  margin: 0,
  color: 'var(--tx)',
  fontFamily: 'monospace',
  overflowWrap: 'anywhere',
};

const warnStyle = {
  margin: '10px 0 0',
  fontSize: 12,
  color: 'var(--warn, #e8a838)',
  lineHeight: 1.5,
};

const checkStyle = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  marginTop: 10,
  fontSize: 13,
  color: 'var(--tx)',
  cursor: 'pointer',
  lineHeight: 1.5,
};

const diffContainerStyle = {
  marginTop: 12,
  border: '1px solid var(--bd)',
  borderRadius: 6,
  overflow: 'hidden',
};

const diffHeaderStyle = {
  padding: '4px 8px',
  fontSize: 11,
  color: 'var(--tx3)',
  background: 'var(--bg2)',
  borderBottom: '1px solid var(--bd)',
};

const diffBodyStyle = {
  maxHeight: 180,
  overflowY: 'auto',
  padding: '4px 0',
  fontFamily: 'monospace',
  fontSize: 12,
};
