import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import HeadingJumpMod from './HeadingJumpMod';

// virtua（VirtualList の基盤）は ResizeObserver を要求するが jsdom にはないため no-op で補う。
beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

// useEditorJump も内部で useApp を使うため、AppContext をモックすれば両方カバーできる。
const mockState = { currentFile: { content: '' }, editorRef: { current: null } };
vi.mock('../../context/AppContext', () => ({
  useApp: () => mockState,
}));

// テスト間で mockState の状態が漏れないよう毎回初期化する。
beforeEach(() => {
  mockState.currentFile = { content: '' };
  mockState.editorRef = { current: null };
});

function makeHeadings(n) {
  return Array.from({ length: n }, (_, i) => `# 見出し${i + 1}`).join('\n');
}

describe('HeadingJumpMod の仮想化しきい値', () => {
  test('見出しなしのとき「見出しなし」を表示', () => {
    mockState.currentFile = { content: '本文のみ\n' };
    render(<HeadingJumpMod />);
    expect(screen.getByText('見出しなし')).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  test('しきい値以下のときは素の button 群（listbox 化しない）', () => {
    mockState.currentFile = { content: makeHeadings(3) };
    render(<HeadingJumpMod />);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /見出し1/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /見出し3/ })).toBeInTheDocument();
  });

  test('しきい値を超えると VirtualList（role=listbox）に切り替わる', () => {
    mockState.currentFile = { content: makeHeadings(60) };
    render(<HeadingJumpMod />);
    expect(screen.getByRole('listbox', { name: '見出し一覧' })).toBeInTheDocument();
  });
});
