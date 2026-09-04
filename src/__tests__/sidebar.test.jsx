import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ModuleWrapper from '../components/common/ModuleWrapper';
import FlowTimeMod from '../components/sidebar/FlowTimeMod';
import PomodoroMod from '../components/sidebar/PomodoroMod';

vi.mock('../context/AppContext', () => ({
  useApp: () => ({
    settings: {},
    setSettings: vi.fn(),
  }),
}));

// --- ModuleWrapper ---

describe('ModuleWrapper', () => {
  test('defaultOpen={false} のときコンテンツが非表示', () => {
    render(
      <ModuleWrapper title="テスト" defaultOpen={false}>
        <span>中身</span>
      </ModuleWrapper>,
    );
    expect(screen.queryByText('中身')).not.toBeInTheDocument();
  });

  test('defaultOpen={true} のときコンテンツが表示', () => {
    render(
      <ModuleWrapper title="テスト" defaultOpen={true}>
        <span>中身</span>
      </ModuleWrapper>,
    );
    expect(screen.getByText('中身')).toBeInTheDocument();
  });

  test('ヘッダークリックで開閉トグル', () => {
    render(
      <ModuleWrapper title="テスト" defaultOpen={false}>
        <span>中身</span>
      </ModuleWrapper>,
    );
    expect(screen.queryByText('中身')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /テスト/ }));
    expect(screen.getByText('中身')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /テスト/ }));
    expect(screen.queryByText('中身')).not.toBeInTheDocument();
  });

  test('keepMounted={true} — 閉じても children が DOM に残る', () => {
    render(
      <ModuleWrapper title="テスト" defaultOpen={true} keepMounted={true}>
        <span>マウント維持</span>
      </ModuleWrapper>,
    );
    fireEvent.click(screen.getByRole('button', { name: /テスト/ }));
    expect(screen.getByText('マウント維持')).toBeInTheDocument();
    expect(screen.getByText('マウント維持')).not.toBeVisible();
  });

  test('keepMounted={false} — 閉じると children がアンマウント', () => {
    render(
      <ModuleWrapper title="テスト" defaultOpen={true} keepMounted={false}>
        <span>アンマウント確認</span>
      </ModuleWrapper>,
    );
    fireEvent.click(screen.getByRole('button', { name: /テスト/ }));
    expect(screen.queryByText('アンマウント確認')).not.toBeInTheDocument();
  });

  test('icon prop が表示される', () => {
    render(
      <ModuleWrapper title="テスト" icon="⏱" defaultOpen={false}>
        <span>中身</span>
      </ModuleWrapper>,
    );
    expect(screen.getByText('⏱')).toBeInTheDocument();
  });
});

// --- FlowTimeMod (依存なし) ---

describe('FlowTimeMod', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('エラーなくマウントできる', () => {
    expect(() => render(<FlowTimeMod />)).not.toThrow();
  });

  test('開始ボタンが描画されている', () => {
    render(<FlowTimeMod />);
    fireEvent.click(screen.getByRole('button', { name: /フロータイム/ }));
    expect(screen.getByRole('button', { name: /開始/ })).toBeInTheDocument();
  });
});

// --- PomodoroMod (useApp をモック済み) ---

describe('PomodoroMod', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('エラーなくマウントできる', () => {
    expect(() => render(<PomodoroMod />)).not.toThrow();
  });

  test('タイマー表示が描画されている', () => {
    render(<PomodoroMod />);
    expect(screen.getByText(/25:00/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /開始/ })).toBeInTheDocument();
  });
});
