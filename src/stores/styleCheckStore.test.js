import { describe, it, expect, beforeEach } from 'vitest';
import { useStyleCheckStore } from './styleCheckStore';

describe('styleCheckStore.setResults — ownerId 追跡 (#330)', () => {
  beforeEach(() => {
    useStyleCheckStore.setState({ results: [], ownerId: null });
  });

  it('初期状態の ownerId は null', () => {
    expect(useStyleCheckStore.getState().ownerId).toBe(null);
  });

  it('setResults は結果と所有者 pane を記録する', () => {
    const found = [{ ruleId: 'a', from: 1, to: 2, severity: 'warning', message: 'x' }];
    useStyleCheckStore.getState().setResults(found, 'primary');
    expect(useStyleCheckStore.getState().results).toBe(found);
    expect(useStyleCheckStore.getState().ownerId).toBe('primary');
  });

  it('結果クリア時に ownerId を null へリセットする', () => {
    useStyleCheckStore.getState().setResults([{ ruleId: 'a', from: 1, to: 2 }], 'secondary');
    useStyleCheckStore.getState().setResults([], null);
    expect(useStyleCheckStore.getState().results).toEqual([]);
    expect(useStyleCheckStore.getState().ownerId).toBe(null);
  });
});
