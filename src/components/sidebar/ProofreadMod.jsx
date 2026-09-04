import { useEffect, useRef, useState } from 'react';
import ModuleWrapper from '../common/ModuleWrapper';
import { useApp } from '../../context/AppContext';

const PROOFREAD_DELAY_MS = 900;

const TYPE = {
  warn: { color: 'oklch(.72 .1 48)', label: '注意' },
  info: { color: 'oklch(.7 .08 220)', label: '情報' },
  error: { color: 'var(--ac-red)', label: 'エラー' },
};

function ProofreadBody() {
  const { currentFile } = useApp();
  const content = currentFile?.content || '';
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState(null);
  const timeoutRef = useRef(null);

  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    [],
  );

  const run = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setRunning(true);
    setResults(null);
    timeoutRef.current = setTimeout(() => {
      const issues = [];
      (content || '').split('\n').forEach((line, li) => {
        if (/([、。，．])\1+/.test(line)) {
          issues.push({
            type: 'warn',
            msg: '読点・句点の連続',
            excerpt: line.slice(0, 24),
            line: li + 1,
          });
        }
        if (line.replace(/[#*\s]/g, '').length > 120) {
          issues.push({
            type: 'info',
            msg: '長文（120字超）',
            excerpt: line.slice(0, 20) + '…',
            line: li + 1,
          });
        }
        if (/([ぁ-んァ-ヶー一-鿿])\1{2,}/.test(line)) {
          issues.push({
            type: 'warn',
            msg: '同じ文字の連続',
            excerpt: line.slice(0, 24),
            line: li + 1,
          });
        }
      });
      if (issues.length === 0 && (content || '').length > 50) {
        issues.push({ type: 'info', msg: '問題は見つかりませんでした', excerpt: '', line: null });
      }
      timeoutRef.current = null;
      setResults(issues);
      setRunning(false);
    }, PROOFREAD_DELAY_MS);
  };

  return (
    <>
      <button
        type="button"
        className="btn-primary"
        style={{ width: '100%', marginBottom: results ? 10 : 0 }}
        onClick={run}
        disabled={running}
      >
        {running ? '校正中…' : '校正を実行'}
      </button>
      {results && results.length === 0 && (
        <div style={{ color: 'var(--tx3)', fontSize: 12, textAlign: 'center', padding: '6px 0' }}>
          問題なし
        </div>
      )}
      {results &&
        results.map((r, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              gap: 6,
              padding: '6px 8px',
              marginBottom: 3,
              background: 'var(--sf2)',
              borderRadius: 'var(--rs)',
              borderLeft: `2px solid ${TYPE[r.type]?.color || 'var(--bd)'}`,
            }}
          >
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: TYPE[r.type]?.color }}>
                {r.msg}
              </div>
              {r.line && (
                <div style={{ fontSize: 10, color: 'var(--tx3)', marginTop: 1 }}>
                  {r.line}行目{r.excerpt && `: ${r.excerpt}`}
                </div>
              )}
            </div>
          </div>
        ))}
    </>
  );
}

export default function ProofreadMod() {
  return (
    <ModuleWrapper title="簡易校正" icon="📝">
      <ProofreadBody />
    </ModuleWrapper>
  );
}
