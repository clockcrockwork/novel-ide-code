import { useMemo } from 'react';
import ModuleWrapper from '../common/ModuleWrapper';
import VirtualList from '../common/VirtualList';
import { useApp } from '../../context/AppContext';
import { useEditorJump } from '../../hooks/useEditorJump';

// 見出し数がこれを超えたら VirtualList（高さ制限スクロール）に切り替える。
// 以下なら従来どおり素の map でインライン表示し、サイドバー内に固定高スクロール箱を作らない。
const HEADING_VIRTUALIZE_THRESHOLD = 50;

function headingRowStyle(lv) {
  const isH1 = lv === 1;
  const isH2 = lv === 2;
  return {
    display: 'flex',
    alignItems: 'baseline',
    gap: 5,
    width: '100%',
    textAlign: 'left',
    fontFamily: 'inherit',
    cursor: 'pointer',
    padding: `5px 6px 5px ${(lv - 1) * 12 + 6}px`,
    background: 'transparent',
    border: 'none',
    borderRadius: 'var(--rs)',
    borderLeft: `2px solid ${isH1 ? 'var(--ac)' : isH2 ? 'color-mix(in srgb, var(--ac) 30%, transparent)' : 'var(--bd)'}`,
    color: isH1 ? 'var(--tx)' : isH2 ? 'var(--tx2)' : 'var(--tx3)',
    fontSize: isH1 ? 13 : isH2 ? 12 : 11,
    fontWeight: isH1 ? 600 : 400,
    marginBottom: 1,
    transition: 'all .12s',
  };
}

function HeadingInner({ lv, text }) {
  const isH1 = lv === 1;
  return (
    <>
      <span
        style={{
          fontSize: 9,
          fontFamily: 'monospace',
          flexShrink: 0,
          color: isH1 ? 'var(--ac)' : 'var(--tx3)',
          opacity: isH1 ? 1 : 0.7,
        }}
      >
        H{lv}
      </span>
      <span style={{ flex: 1 }}>{text}</span>
    </>
  );
}

function HeadingJumpBody() {
  const { currentFile, editorRef } = useApp();
  const { jumpToPos } = useEditorJump();
  const content = currentFile?.content || '';
  const headings = useMemo(() => {
    const result = [];
    (content || '').split('\n').forEach((line) => {
      const m = line.match(/^(#{1,3})\s+(.+)/);
      if (m) result.push({ lv: m[1].length, text: m[2] });
    });
    return result;
  }, [content]);

  const jump = (headingText, level) => {
    const editor = editorRef?.current;
    if (!editor) return;

    let targetPos = null;
    editor.state.doc.descendants((node, pos) => {
      if (targetPos !== null) return false;
      if (node.type.name === 'heading' && node.attrs.level === level) {
        let text = '';
        node.forEach((child) => {
          if (child.isText) text += child.text;
        });
        if (text === headingText) {
          targetPos = pos + 1;
          return false;
        }
      }
    });

    if (targetPos !== null) jumpToPos(targetPos);
  };

  if (headings.length === 0) {
    return (
      <div style={{ color: 'var(--tx3)', fontSize: 12, textAlign: 'center', padding: '8px 0' }}>
        見出しなし
      </div>
    );
  }

  // 見出しが多い長編は VirtualList で仮想化（読み取り専用リスト・CLAUDE.md #26）。
  if (headings.length > HEADING_VIRTUALIZE_THRESHOLD) {
    return (
      <VirtualList
        items={headings}
        height="min(60vh, 480px)"
        ariaLabel="見出し一覧"
        // VirtualList はクリック activation 直後に listbox コンテナへ focus() するため、
        // jump（エディタへ focus）を rAF で 1 フレーム遅らせて後勝ちにする（ジャンプ先で即入力可能に保つ）。
        onItemActivate={(h) => requestAnimationFrame(() => jump(h.text, h.lv))}
        renderItem={(h) => (
          <div style={headingRowStyle(h.lv)}>
            <HeadingInner lv={h.lv} text={h.text} />
          </div>
        )}
      />
    );
  }

  return (
    <>
      {headings.map((h, i) => (
        <button
          type="button"
          key={i}
          onClick={() => jump(h.text, h.lv)}
          style={headingRowStyle(h.lv)}
        >
          <HeadingInner lv={h.lv} text={h.text} />
        </button>
      ))}
    </>
  );
}

export default function HeadingJumpMod() {
  return (
    <ModuleWrapper title="見出しジャンプ" icon="§" defaultOpen={true}>
      <HeadingJumpBody />
    </ModuleWrapper>
  );
}
