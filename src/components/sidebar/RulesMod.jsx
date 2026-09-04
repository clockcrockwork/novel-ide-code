import { useState, useCallback } from 'react';
import { useApp } from '../../context/AppContext';
import { applyWritingRules } from '../../lib/writingRules';
import { useWritingPrefs } from '../../hooks/useWritingPrefs';
import ModuleWrapper from '../common/ModuleWrapper';

function RulesBody() {
  const { currentFile, updateContent, activePane } = useApp();
  const content = currentFile?.content || '';
  const paneDisabled = activePane === 'secondary';

  const { rules, toggleRule, hydrated } = useWritingPrefs();
  const [lastApplied, setLastApplied] = useState('');

  const disabled = paneDisabled || !hydrated;

  const apply = useCallback(() => {
    if (disabled) return;
    const result = applyWritingRules(content, rules);
    if (result !== content) {
      updateContent(result);
      setLastApplied(
        new Date().toLocaleTimeString('ja-JP', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
      );
    }
  }, [content, rules, updateContent, disabled]);

  const anyEnabled = rules.some((r) => r.enabled);

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1, marginBottom: 10 }}>
        {rules.map((r) => (
          <label
            key={r.id}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              padding: '7px 8px',
              borderRadius: 'var(--rs)',
              cursor: hydrated ? 'pointer' : 'default',
              transition: 'background var(--t)',
              background: r.enabled ? 'var(--ac-bg)' : 'transparent',
              border: `1px solid ${r.enabled ? 'oklch(.72 .1 48/.25)' : 'transparent'}`,
              opacity: hydrated ? 1 : 0.5,
            }}
          >
            <input
              type="checkbox"
              checked={r.enabled}
              disabled={!hydrated}
              onChange={() => toggleRule(r.id)}
              style={{
                accentColor: 'var(--ac)',
                width: 13,
                height: 13,
                cursor: hydrated ? 'pointer' : 'default',
                marginTop: 2,
                flexShrink: 0,
              }}
            />
            <div>
              <div
                style={{
                  fontSize: 12,
                  color: r.enabled ? 'var(--tx)' : 'var(--tx2)',
                  fontWeight: r.enabled ? 600 : 400,
                }}
              >
                {r.label}
              </div>
              <div style={{ fontSize: 10, color: 'var(--tx3)', marginTop: 1, lineHeight: 1.4 }}>
                {r.desc}
              </div>
            </div>
          </label>
        ))}
      </div>
      <div
        style={{
          borderTop: '1px solid var(--bd)',
          paddingTop: 8,
          display: 'flex',
          gap: 5,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <button
          type="button"
          className="btn-primary"
          style={{ padding: '4px 11px', fontSize: 11, opacity: anyEnabled && !disabled ? 1 : 0.45 }}
          disabled={!anyEnabled || disabled}
          onClick={apply}
        >
          今すぐ適用
        </button>
      </div>
      {paneDisabled && (
        <div style={{ fontSize: 10, color: 'var(--tx3)', marginTop: 6 }}>
          参照ペインではルールを適用できません
        </div>
      )}
      {lastApplied && (
        <div style={{ fontSize: 10, color: 'var(--tx3)', marginTop: 6, textAlign: 'right' }}>
          適用: {lastApplied}
        </div>
      )}
    </>
  );
}

export default function RulesMod() {
  return (
    <ModuleWrapper title="執筆ルール" icon="⚙">
      <RulesBody />
    </ModuleWrapper>
  );
}
