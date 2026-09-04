import { useState, useEffect, useLayoutEffect, useMemo } from 'react';
import ModuleWrapper from '../common/ModuleWrapper';
import { useApp } from '../../context/AppContext';
import { useEditorJump } from '../../hooks/useEditorJump';
import { useUIStore } from '../../stores/uiStore';
import { findNthOccurrencePmPos } from '../../lib/tiptap';

function AnnotationListBody() {
  const { annosRef, saveAnnosRef, setSharedAnnosRef, editorRef, switchMode, currentFile } =
    useApp();
  const { jumpToRange } = useEditorJump();
  const mode = useUIStore((s) => s.mode);
  const [annos, setAnnos] = useState([]);

  useEffect(() => {
    if (setSharedAnnosRef) setSharedAnnosRef.current = setAnnos;
    return () => {
      if (setSharedAnnosRef) setSharedAnnosRef.current = null;
    };
  }, [setSharedAnnosRef]);

  // ファイル切り替え・マウント時にペイント前同期してチラつきを防ぐ
  useLayoutEffect(() => {
    setAnnos(annosRef?.current ?? []);
  }, [currentFile?.id, annosRef]);

  const sorted = useMemo(() => [...annos].sort((a, b) => b.createdAt - a.createdAt), [annos]);

  const handleJump = (anno) => {
    if (mode !== 'write') switchMode('write');
    requestAnimationFrame(() => {
      const editor = editorRef?.current;
      let from = anno.from,
        to = anno.to;
      if (from == null || to == null) {
        const doc = editor?.state?.doc;
        if (!doc) return;
        const pos = findNthOccurrencePmPos(doc, anno.selectedText, anno.occurrenceIdx ?? 0);
        if (!pos) return;
        ({ from, to } = pos);
      }
      jumpToRange(from, to);
    });
  };

  const handleDelete = (id) => {
    const save = saveAnnosRef?.current;
    if (!save) return;
    save(annos.filter((a) => a.id !== id));
  };

  const markerCount = annos.filter((a) => a.type === 'marker').length;
  const memoCount = annos.filter((a) => a.type === 'memo').length;

  return (
    <>
      {annos.length > 0 && (
        <div
          style={{ display: 'flex', gap: 6, marginBottom: 8, fontSize: 11, color: 'var(--tx3)' }}
        >
          {markerCount > 0 && <span>マーカー {markerCount}件</span>}
          {memoCount > 0 && <span>メモ {memoCount}件</span>}
        </div>
      )}
      {sorted.length === 0 && (
        <div style={{ color: 'var(--tx3)', fontSize: 12, textAlign: 'center', padding: '8px 0' }}>
          アノテーションなし
        </div>
      )}
      {sorted.map((anno) => (
        <div
          key={anno.id}
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 6,
            padding: '5px 6px',
            marginBottom: 3,
            background: 'var(--sf2)',
            borderRadius: 'var(--rs)',
            borderLeft: `2px solid ${anno.type === 'marker' ? anno.color : 'var(--ac)'}`,
          }}
        >
          <span style={{ fontSize: 11, flexShrink: 0, marginTop: 1, color: 'var(--tx2)' }}>
            {anno.type === 'marker' ? '🖍' : '💬'}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 12,
                color: 'var(--tx)',
                fontWeight: 500,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {anno.selectedText.length > 30
                ? anno.selectedText.slice(0, 30) + '…'
                : anno.selectedText}
            </div>
            {anno.type === 'memo' && anno.note && (
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--tx3)',
                  marginTop: 2,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {anno.note.length > 40 ? anno.note.slice(0, 40) + '…' : anno.note}
              </div>
            )}
            {anno.from == null && (
              <div style={{ fontSize: 10, color: 'var(--tx3)', marginTop: 1 }}>位置不明</div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
            <button
              type="button"
              className="nb nb-icon"
              style={{ fontSize: 11, width: 22, height: 22 }}
              title="ジャンプ"
              onClick={() => handleJump(anno)}
            >
              ↗
            </button>
            <button
              type="button"
              className="nb nb-icon"
              style={{ fontSize: 11, width: 22, height: 22 }}
              title="削除"
              onClick={() => handleDelete(anno.id)}
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

export default function AnnotationListMod() {
  return (
    <ModuleWrapper title="手動校正一覧" icon="📋" defaultOpen={false}>
      <AnnotationListBody />
    </ModuleWrapper>
  );
}
