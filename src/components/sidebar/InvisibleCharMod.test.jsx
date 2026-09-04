import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import InvisibleCharMod from './InvisibleCharMod';

const mockState = { currentFile: { id: 'f1', content: '' }, updateFileContent: vi.fn(), activePane: 'primary' };
vi.mock('../../context/AppContext', () => ({
  useApp: () => mockState,
}));

const addToast = vi.fn();
vi.mock('../../stores/uiStore', () => ({
  useUIStore: (sel) => sel({ addToast }),
}));

function openModule() {
  // ModuleWrapper は defaultOpen=false。ヘッダーを押して body を展開する。
  fireEvent.click(screen.getByRole('button', { name: /文字チェック/ }));
}

beforeEach(() => {
  mockState.currentFile = { id: 'f1', content: '' };
  mockState.updateFileContent = vi.fn();
  mockState.activePane = 'primary';
  addToast.mockClear();
});

describe('InvisibleCharMod', () => {
  test('検出なしのとき「検出されていません」を表示する', () => {
    mockState.currentFile = { id: 'f1', content: '普通の文章' };
    render(<InvisibleCharMod />);
    openModule();
    expect(screen.getByText('不可視文字・制御文字は検出されていません。')).toBeInTheDocument();
  });

  test('deny / warn の件数を表示する', () => {
    // RLO(deny) ×1, ZWSP(warn) ×1
    mockState.currentFile = { id: 'f1', content: 'a‮b​c' };
    render(<InvisibleCharMod />);
    openModule();
    expect(screen.getByText('危険な制御文字（1）')).toBeInTheDocument();
    expect(screen.getByText('不可視文字（1）')).toBeInTheDocument();
  });

  test('「危険な制御文字を除去」で updateFileContent が修正後テキストで呼ばれる', () => {
    mockState.currentFile = { id: 'f1', content: 'a‮b' };
    render(<InvisibleCharMod />);
    openModule();
    fireEvent.click(screen.getByRole('button', { name: '危険な制御文字を除去' }));
    expect(mockState.updateFileContent).toHaveBeenCalledWith('f1', 'ab');
    expect(addToast).toHaveBeenCalled();
  });

  test('検出されるが自動修正対象外（結合文字の連続）はトーストで通知し本文を変えない', () => {
    // 6 個の結合文字 → warn として検出されるが fixInvisibleChars は対象外。
    mockState.currentFile = { id: 'f1', content: 'e' + '́'.repeat(6) };
    render(<InvisibleCharMod />);
    openModule();
    fireEvent.click(screen.getByRole('button', { name: '不可視文字を正規化・除去' }));
    expect(mockState.updateFileContent).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith('自動修正できる文字はありませんでした');
  });

  test('該当 severity が無いボタンは disabled', () => {
    // deny のみ → warn ボタンは disabled
    mockState.currentFile = { id: 'f1', content: 'a‮b' };
    render(<InvisibleCharMod />);
    openModule();
    expect(screen.getByRole('button', { name: '不可視文字を正規化・除去' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '危険な制御文字を除去' })).toBeEnabled();
  });

  test('secondary ペインのときは両ボタンが disabled', () => {
    mockState.currentFile = { id: 'f1', content: 'a‮b​c' };
    mockState.activePane = 'secondary';
    render(<InvisibleCharMod />);
    openModule();
    expect(screen.getByRole('button', { name: '危険な制御文字を除去' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '不可視文字を正規化・除去' })).toBeDisabled();
  });
});
