import { useState, useEffect } from 'react';
import ModuleWrapper from '../common/ModuleWrapper';
import { useApp } from '../../context/AppContext';
import { useEditorJump } from '../../hooks/useEditorJump';
import { useUIStore } from '../../stores/uiStore';
import { useStyleCheckStore } from '../../stores/styleCheckStore';
import { ALL_RULES, runStyleChecks, CATEGORY } from '../../lib/styleRules';
import { styleCheckPluginKey } from '../../lib/tiptap';

const COLOR_TX3 = 'var(--tx3)';

const SEVERITY_COLOR = {
  warning: 'oklch(.72 .1 48)',
  suggestion: COLOR_TX3,
};

const CATEGORY_LABEL = {
  [CATEGORY.NOTATION]: '表記',
  [CATEGORY.SYNTAX]: '記法',
  [CATEGORY.KINSOKU]: '禁則',
  [CATEGORY.STYLE]: '文体',
};

const CATEGORIES_ORDER = [
  CATEGORY.NOTATION,
  CATEGORY.SYNTAX,
  CATEGORY.KINSOKU,
  CATEGORY.STYLE,
];

const RULES_BY_CATEGORY = CATEGORIES_ORDER.map((cat) => ({
  cat,
  rules: ALL_RULES.filter((r) => r.category === cat),
}));

function StyleCheckBody() {
  const { editorRef, switchMode, setActivePane } = useApp();
  const { jumpToRange } = useEditorJump();
  const { results, ownerId, isRunning, enabledRuleIds, setResults, setRunning, toggleRule } =
    useStyleCheckStore();
  const mode = useUIStore((s) => s.mode);
  const [showRules, setShowRules] = useState(false);
  const [pendingJump, setPendingJump] = useState(null);

  const handleRun = () => {
    setRunning(true);
    setTimeout(() => {
      const editor = editorRef?.current;
      if (!editor || editor.isDestroyed) {
        setRunning(false);
        return;
      }
      const found = runStyleChecks(editor.state.doc, enabledRuleIds);
      setResults(found, editor.storage.styleCheck.editorId);
      setRunning(false);
      editor.view.dispatch(editor.state.tr.setMeta(styleCheckPluginKey, found));
    }, 0);
  };

  const handleJump = (r) => {
    if (mode !== 'write') switchMode('write');
    // 所有 pane を active にしてからジャンプする。editorRef.current の更新は
    // EditorBox の passive effect 経由で非同期に走るため、ここでは即ジャンプせず
    // pendingJump に積み、所有 pane の editor が editorRef に載るのを待つ（#331）。
    if (ownerId) setActivePane(ownerId);
    setPendingJump({ from: r.from, to: r.to });
  };

  useEffect(() => {
    if (!pendingJump) return undefined;
    let raf = 0;
    let frames = 0;
    const tryJump = () => {
      const editor = editorRef?.current;
      const ownerReady = !ownerId || editor?.storage?.styleCheck?.editorId === ownerId;
      if (!ownerReady && frames < 20) {
        frames += 1;
        raf = requestAnimationFrame(tryJump);
        return;
      }
      const { from, to } = pendingJump;
      setPendingJump(null);
      // 所有 pane の editor が editorRef に載らないまま 20 フレーム超過した場合は
      // 切替前の誤った editor へのジャンプを避けるため何もしない（#331）。
      if (ownerReady) jumpToRange(from, to);
    };
    raf = requestAnimationFrame(tryJump);
    return () => cancelAnimationFrame(raf);
  }, [pendingJump, ownerId, editorRef, jumpToRange]);

  const warnCount = results.filter((r) => r.severity === 'warning').length;
  const sugCount = results.filter((r) => r.severity === 'suggestion').length;

  return (
    <>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <button
          type="button"
          className="btn-primary"
          style={{ flex: 1 }}
          onClick={handleRun}
          disabled={isRunning}
        >
          {isRunning ? 'チェック中…' : 'チェック実行'}
        </button>
        <button
          type="button"
          className="nb nb-icon"
          style={{ width: 28, fontSize: 13 }}
          title="ルール設定"
          onClick={() => setShowRules((v) => !v)}
          aria-pressed={showRules}
        >
          ⚙
        </button>
      </div>

      {showRules && (
        <div
          style={{
            marginBottom: 10,
            padding: '8px 10px',
            background: 'var(--sf2)',
            borderRadius: 'var(--rs)',
            fontSize: 11,
          }}
        >
          {RULES_BY_CATEGORY.map(({ cat, rules }) => (
            <div key={cat} style={{ marginBottom: 6 }}>
              <div
                style={{
                  fontWeight: 700,
                  color: COLOR_TX3,
                  marginBottom: 3,
                  fontSize: 10,
                  textTransform: 'uppercase',
                  letterSpacing: '.06em',
                }}
              >
                {CATEGORY_LABEL[cat]}
              </div>
              {rules.map((rule) => (
                <label
                  key={rule.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    marginBottom: 2,
                    cursor: 'pointer',
                    color: 'var(--tx)',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={enabledRuleIds.includes(rule.id)}
                    onChange={() => toggleRule(rule.id)}
                  />
                  {rule.label}
                </label>
              ))}
            </div>
          ))}
        </div>
      )}

      {results.length > 0 && (
        <div style={{ fontSize: 11, color: COLOR_TX3, marginBottom: 6 }}>
          {warnCount > 0 && <span style={{ marginRight: 8 }}>⚠ {warnCount}件</span>}
          {sugCount > 0 && <span>💡 {sugCount}件</span>}
        </div>
      )}

      {results.length === 0 && !isRunning && (
        <div style={{ fontSize: 12, color: COLOR_TX3, textAlign: 'center', padding: '4px 0' }}>
          —
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {results.map((r) => (
          <button
            key={r.ruleId + '-' + r.from + '-' + r.to}
            type="button"
            className="nb"
            onClick={() => handleJump(r)}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '5px 8px',
              background: 'var(--sf2)',
              borderRadius: 'var(--rs)',
              borderLeft: `2px solid ${SEVERITY_COLOR[r.severity] ?? 'var(--bd)'}`,
              cursor: 'pointer',
            }}
          >
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: SEVERITY_COLOR[r.severity],
                marginBottom: 1,
              }}
            >
              {r.message}
              {r.suggestion && (
                <span style={{ fontWeight: 400, marginLeft: 4 }}>→ {r.suggestion}</span>
              )}
            </div>
            <div
              style={{
                fontSize: 10,
                color: COLOR_TX3,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {r.text}
            </div>
          </button>
        ))}
      </div>
    </>
  );
}

export default function StyleCheckMod() {
  // 結果の無効化は所有ペインの docChanged（StyleCheckExtension）に一本化している。
  // ファイル切替も EditorBox の setContent が docChanged を生むため拡張側でクリアされる（#331）。
  return (
    <ModuleWrapper title="スタイルチェック" icon="✔" defaultOpen={false}>
      <StyleCheckBody />
    </ModuleWrapper>
  );
}
