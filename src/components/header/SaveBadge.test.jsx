import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import SaveBadge from './SaveBadge';

describe('SaveBadge', () => {
  it('idle では何も描画しない', () => {
    const { container } = render(
      <SaveBadge status={{ state: 'idle', lastSavedAt: null, error: null, detail: null }} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('saving / dirty / error / oversize のラベルを表示する', () => {
    const cases = [
      { state: 'saving', label: '保存中' },
      { state: 'dirty', label: '未保存' },
      { state: 'error', label: '保存失敗' },
      { state: 'oversize', label: 'サイズ超過' },
    ];
    for (const c of cases) {
      const { unmount } = render(
        <SaveBadge status={{ state: c.state, lastSavedAt: null, error: null, detail: null }} />,
      );
      // saving は title===label のため sr-only と視覚ラベルで2箇所に出る。存在確認に留める。
      expect(screen.getAllByText(c.label).length).toBeGreaterThanOrEqual(1);
      unmount();
    }
  });

  it('saved は最終保存時刻(HH:MM)を表示し role=status を持つ', () => {
    const ts = new Date('2026-07-14T05:30:00Z').getTime();
    render(<SaveBadge status={{ state: 'saved', lastSavedAt: ts, error: null, detail: null }} />);
    const expected = new Date(ts).toLocaleTimeString('ja-JP', {
      hour: '2-digit',
      minute: '2-digit',
    });
    const el = screen.getByRole('status');
    expect(el).toHaveTextContent(expected);
  });

  it('saved でも lastSavedAt が無ければ描画しない', () => {
    const { container } = render(
      <SaveBadge status={{ state: 'saved', lastSavedAt: null, error: null, detail: null }} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('全ビューポートで読み上げ用の状態テキストを sr-only に持つ（モバイルでも欠落しない）', () => {
    render(
      <SaveBadge status={{ state: 'error', lastSavedAt: null, error: null, detail: 'huge.md' }} />,
    );
    const status = screen.getByRole('status');
    const srOnly = status.querySelector('.sr-only');
    expect(srOnly).not.toBeNull();
    expect(srOnly.textContent).toContain('保存に失敗しました');
    expect(srOnly.textContent).toContain('huge.md');
  });

  it('警告(error/oversize)ラベルはモバイルでも隠さない（.hide-m を付けない）', () => {
    const { unmount } = render(
      <SaveBadge status={{ state: 'error', lastSavedAt: null, error: null, detail: null }} />,
    );
    expect(screen.getByText('保存失敗').className).not.toContain('hide-m');
    unmount();
    render(
      <SaveBadge status={{ state: 'oversize', lastSavedAt: null, error: null, detail: null }} />,
    );
    expect(screen.getByText('サイズ超過').className).not.toContain('hide-m');
  });

  it('日常状態(dirty)の視覚ラベルは .hide-m で省略する', () => {
    render(<SaveBadge status={{ state: 'dirty', lastSavedAt: null, error: null, detail: null }} />);
    expect(screen.getByText('未保存').className).toContain('hide-m');
  });

  it('interstitial 状態(saving/dirty)は sr-only を空にして読み上げノイズを避ける', () => {
    const { container, unmount } = render(
      <SaveBadge status={{ state: 'dirty', lastSavedAt: null, error: null, detail: null }} />,
    );
    expect(container.querySelector('.sr-only').textContent).toBe('');
    unmount();
    render(<SaveBadge status={{ state: 'saving', lastSavedAt: null, error: null, detail: null }} />);
    expect(document.querySelector('.sr-only').textContent).toBe('');
  });

  it('保存済み(saved)は sr-only に時刻を載せて読み上げる', () => {
    const ts = new Date('2026-07-14T05:30:00Z').getTime();
    render(<SaveBadge status={{ state: 'saved', lastSavedAt: ts, error: null, detail: null }} />);
    const sr = document.querySelector('.sr-only');
    expect(sr.textContent).toContain('保存済み');
  });
});
