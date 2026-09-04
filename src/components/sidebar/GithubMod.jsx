import { useApp } from '../../context/AppContext';
import ModuleWrapper from '../common/ModuleWrapper';
import { GhIcon } from '../Icons';

function GithubBody() {
  const { currentFile, ghUser, openGithubModal } = useApp();
  const gh = currentFile?.github;

  if (!ghUser) {
    return (
      <button
        type="button"
        className="btn-ghost"
        style={{ width: '100%', fontSize: 11 }}
        onClick={() => openGithubModal('auth')}
      >
        <GhIcon s={12} /> GitHub にログイン
      </button>
    );
  }

  if (!gh) {
    return (
      <div style={{ color: 'var(--tx3)', fontSize: 12, lineHeight: 1.6 }}>
        このファイルはまだ GitHub に連携されていません。
        <br />
        <button
          type="button"
          className="btn-ghost"
          style={{ fontSize: 11, marginTop: 6 }}
          onClick={() => openGithubModal('repos')}
        >
          リポジトリから開く
        </button>
      </div>
    );
  }

  return (
    <>
      <div style={{ fontSize: 11, color: 'var(--tx2)', marginBottom: 6, lineHeight: 1.5 }}>
        <span
          style={{
            fontFamily: 'monospace',
            color: 'var(--ac)',
            fontSize: 10,
            display: 'block',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={`${gh.owner}/${gh.repo}`}
        >
          {gh.owner}/{gh.repo}
        </span>
        <br />
        <span style={{ color: 'var(--tx3)' }}>ブランチ: </span>
        <span style={{ fontFamily: 'monospace', fontSize: 11 }}>{gh.branch}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <button
          type="button"
          className="btn-ghost"
          style={{ fontSize: 11 }}
          onClick={() => openGithubModal('branches')}
        >
          ブランチを切り替える
        </button>
        <button
          type="button"
          className="btn-ghost"
          style={{ fontSize: 11 }}
          onClick={() => openGithubModal('prs')}
        >
          PR を確認・作成する
        </button>
      </div>
    </>
  );
}

export default function GithubMod() {
  return (
    <ModuleWrapper title="GitHub" icon={<GhIcon s={12} />}>
      <GithubBody />
    </ModuleWrapper>
  );
}
