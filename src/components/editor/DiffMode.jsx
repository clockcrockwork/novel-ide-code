import { useEffect, useMemo, useReducer, useRef, useCallback } from 'react';
import { VList } from 'virtua';
import { useApp } from '../../context/AppContext';
import { computeDiffAsync } from '../../lib/markdown';

const initialDiffState = { rows: [], isLoading: false, isFallback: false };

function diffReducer(state, action) {
  switch (action.type) {
    case 'start':
      return { rows: [], isLoading: true, isFallback: false };
    case 'success':
      return { rows: action.rows, isLoading: false, isFallback: action.isFallback };
    case 'error':
      return { rows: [], isLoading: false, isFallback: true };
    default:
      return state;
  }
}

export default function DiffMode({ content, diffBase }) {
  const {
    conflictData,
    resolveConflictLocal,
    resolveConflictRemote,
    resolveConflictBoth,
    currentFile,
    openGithubModal,
  } = useApp();
  const [diffState, dispatchDiff] = useReducer(diffReducer, initialDiffState);
  const leftRef = useRef(null);
  const rightRef = useRef(null);
  const syncingRef = useRef(false);

  const handleLeftScroll = useCallback((offset) => {
    if (syncingRef.current) {
      syncingRef.current = false;
      return;
    }
    const target = rightRef.current;
    if (!target || Math.abs(target.scrollOffset - offset) < 0.5) return;
    syncingRef.current = true;
    target.scrollTo(offset);
  }, []);

  const handleRightScroll = useCallback((offset) => {
    if (syncingRef.current) {
      syncingRef.current = false;
      return;
    }
    const target = leftRef.current;
    if (!target || Math.abs(target.scrollOffset - offset) < 0.5) return;
    syncingRef.current = true;
    target.scrollTo(offset);
  }, []);

  const isConflict = conflictData != null;
  const leftContent = isConflict ? conflictData.local.content : diffBase || '';
  const rightContent = isConflict ? conflictData.remote.content : content;
  const leftLabel = isConflict ? 'ローカル' : 'BASE';
  const rightLabel = isConflict ? 'リモート' : '現在';

  useEffect(() => {
    let cancelled = false;
    dispatchDiff({ type: 'start' });
    computeDiffAsync(leftContent, rightContent)
      .then(({ rows, meta }) => {
        if (cancelled) return;
        dispatchDiff({ type: 'success', rows, isFallback: Boolean(meta?.isFallback) });
      })
      .catch(() => {
        if (cancelled) return;
        dispatchDiff({ type: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [leftContent, rightContent]);

  const { rows: diffRows, isLoading: diffLoading, isFallback: diffFallback } = diffState;
  const leftRows = useMemo(
    () => diffRows.map((d) => (d.type === 'added' ? { type: 'empty', text: '' } : d)),
    [diffRows],
  );
  const rightRows = useMemo(
    () => diffRows.map((d) => (d.type === 'removed' ? { type: 'empty', text: '' } : d)),
    [diffRows],
  );

  const skeletonBar = (w) => (
    <div
      style={{
        height: 14,
        borderRadius: 3,
        background: 'var(--sf3)',
        opacity: 0.5,
        marginBottom: 6,
        width: w,
      }}
    />
  );

  return (
    <div className="diff-wrapper">
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexShrink: 0 }}
      >
        {isConflict ? (
          <>
            <span
              style={{
                fontSize: 10,
                letterSpacing: '.07em',
                textTransform: 'uppercase',
                fontWeight: 700,
                color: 'var(--ac-red, #e74c3c)',
              }}
            >
              競合
            </span>
            <span style={{ fontSize: 11, color: 'var(--tx2)' }}>
              「{conflictData.fileName}」をどちらの版にするか選択してください
            </span>
          </>
        ) : (
          <>
            <span
              style={{
                fontSize: 10,
                letterSpacing: '.07em',
                textTransform: 'uppercase',
                fontWeight: 700,
                color: 'var(--tx3)',
              }}
            >
              差分表示
            </span>
            <span style={{ fontSize: 11, color: 'var(--tx3)' }}>スナップショット → 現在</span>
            {currentFile?.github && (
              <button
                type="button"
                className="btn-ghost"
                style={{ fontSize: 11, marginLeft: 'auto' }}
                onClick={() => openGithubModal('create-pr')}
              >
                PR として送る
              </button>
            )}
          </>
        )}
      </div>

      {diffFallback && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--tx3)',
            marginBottom: 8,
            padding: '4px 8px',
            background: 'var(--sf2)',
            borderRadius: 'var(--rs)',
            border: '1px solid var(--bd)',
            flexShrink: 0,
          }}
        >
          長文のため簡易差分で表示しています（完全一致ではありません）
        </div>
      )}

      {diffLoading ? (
        <div className="diff-container">
          <div className="diff-panel">
            <div className="diff-label">{leftLabel}</div>
            {skeletonBar('72%')}
            {skeletonBar('88%')}
            {skeletonBar('60%')}
            {skeletonBar('80%')}
          </div>
          <div className="diff-panel">
            <div className="diff-label">{rightLabel}</div>
            {skeletonBar('80%')}
            {skeletonBar('64%')}
            {skeletonBar('90%')}
            {skeletonBar('70%')}
          </div>
        </div>
      ) : (
        <div className="diff-container">
          <div className="diff-panel">
            <div className="diff-label">{leftLabel}</div>
            <VList
              ref={leftRef}
              onScroll={handleLeftScroll}
              tabIndex={0}
              role="region"
              aria-label={leftLabel}
              style={{ flex: 1 }}
            >
              {leftRows.map((d, i) => (
                <div key={i} className={`diff-line diff-${d.type}`}>
                  {d.text || ' '}
                </div>
              ))}
            </VList>
          </div>
          <div className="diff-panel">
            <div className="diff-label">{rightLabel}</div>
            <VList
              ref={rightRef}
              onScroll={handleRightScroll}
              tabIndex={0}
              role="region"
              aria-label={rightLabel}
              style={{ flex: 1 }}
            >
              {rightRows.map((d, i) => (
                <div key={i} className={`diff-line diff-${d.type}`}>
                  {d.text || ' '}
                </div>
              ))}
            </VList>
          </div>
        </div>
      )}

      {isConflict && (
        <div
          style={{
            display: 'flex',
            gap: 8,
            marginTop: 20,
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <button type="button" className="btn-primary" onClick={resolveConflictLocal}>
            自分の版を使う
          </button>
          <button type="button" className="btn-primary" onClick={resolveConflictRemote}>
            リモートを使う
          </button>
          <button type="button" className="btn-ghost" onClick={resolveConflictBoth}>
            両方保存
          </button>
        </div>
      )}
    </div>
  );
}
