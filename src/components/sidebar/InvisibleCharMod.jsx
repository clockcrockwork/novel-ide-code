import { useMemo } from 'react';
import { useUIStore } from '../../stores/uiStore';
import ModuleWrapper from '../common/ModuleWrapper';
import { useApp } from '../../context/AppContext';
import { summarizeFindings, fixInvisibleChars } from '../../lib/security/invisibleCharFix';

function FindingList({ items }) {
  return (
    <ul role="list" style={{ listStyle: 'none', margin: '4px 0 8px', padding: 0 }}>
      {items.map((it) => (
        <li
          key={it.label}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: 11,
            color: 'var(--tx2)',
            padding: '2px 0',
          }}
        >
          <span>{it.label}</span>
          <span style={{ color: 'var(--tx3)' }}>×{it.count}</span>
        </li>
      ))}
    </ul>
  );
}

function InvisibleCharBody() {
  const { currentFile, updateFileContent, activePane } = useApp();
  const addToast = useUIStore((s) => s.addToast);
  const content = currentFile?.content || '';
  const fileId = currentFile?.id || null;
  const isSecondary = activePane === 'secondary';

  const summary = useMemo(() => summarizeFindings(content), [content]);
  const hasAny = summary.denyTotal > 0 || summary.warnTotal > 0;

  const applyFix = (severities, successPrefix) => {
    if (!fileId) return;
    const { text, fixed } = fixInvisibleChars(content, severities);
    if (!fixed) {
      // 検出はされるが自動修正対象外（例: 過剰な結合文字の連続）のケース。無反応を避けて通知する。
      addToast('自動修正できる文字はありませんでした');
      return;
    }
    updateFileContent(fileId, text);
    addToast(`${successPrefix} ${fixed} 件を修正しました`);
  };

  if (!fileId) {
    return <p style={{ fontSize: 11, color: 'var(--tx3)', margin: 0 }}>ファイルを開いてください。</p>;
  }

  if (!hasAny) {
    return (
      <p style={{ fontSize: 11, color: 'var(--tx3)', margin: 0 }}>
        不可視文字・制御文字は検出されていません。
      </p>
    );
  }

  return (
    <>
      {summary.denyTotal > 0 && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--ac-red)' }}>
            危険な制御文字（{summary.denyTotal}）
          </div>
          <FindingList items={summary.deny} />
        </div>
      )}
      {summary.warnTotal > 0 && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--tx3)' }}>
            不可視文字（{summary.warnTotal}）
          </div>
          <FindingList items={summary.warn} />
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <button
          type="button"
          className="btn-ghost"
          disabled={summary.denyTotal === 0 || isSecondary}
          onClick={() => applyFix(['deny'], '危険な制御文字')}
          style={{ fontSize: 11, padding: '5px 7px' }}
        >
          危険な制御文字を除去
        </button>
        <button
          type="button"
          className="btn-ghost"
          disabled={summary.warnTotal === 0 || isSecondary}
          onClick={() => applyFix(['warn'], '不可視文字')}
          style={{ fontSize: 11, padding: '5px 7px' }}
        >
          不可視文字を正規化・除去
        </button>
      </div>
    </>
  );
}

export default function InvisibleCharMod() {
  return (
    <ModuleWrapper title="文字チェック" icon="🔎">
      <InvisibleCharBody />
    </ModuleWrapper>
  );
}
