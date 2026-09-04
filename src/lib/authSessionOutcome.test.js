import { describe, it, expect } from 'vitest';
import { resolveAuthRefreshOutcome } from './authSessionOutcome';

const USER = { login: 'octocat' };

describe('resolveAuthRefreshOutcome', () => {
  it('セッション有効（200 + user）: setUser / registerHandler / triggerSync を返し、hadGhUser には依存しない', () => {
    const withoutPrior = resolveAuthRefreshOutcome({
      refreshOk: true,
      user: USER,
      hadGhUser: false,
      authResult: null,
    });
    expect(withoutPrior).toEqual({
      setUser: USER,
      clearSession: false,
      registerHandler: true,
      triggerSync: true,
      showAuthError: false,
    });

    const withPrior = resolveAuthRefreshOutcome({
      refreshOk: true,
      user: USER,
      hadGhUser: true,
      authResult: null,
    });
    expect(withPrior).toEqual(withoutPrior);
  });

  it('セッション失効（refresh 失敗 かつ hadGhUser=true）: clearSession のみ true。ログインモーダルは開かない', () => {
    const outcome = resolveAuthRefreshOutcome({
      refreshOk: false,
      user: null,
      hadGhUser: true,
      authResult: null,
    });
    expect(outcome).toEqual({
      setUser: null,
      clearSession: true,
      registerHandler: false,
      triggerSync: false,
      showAuthError: false,
    });
  });

  it('未ログイン（refresh 失敗 かつ hadGhUser=false）: 何もしない', () => {
    const outcome = resolveAuthRefreshOutcome({
      refreshOk: false,
      user: null,
      hadGhUser: false,
      authResult: null,
    });
    expect(outcome).toEqual({
      setUser: null,
      clearSession: false,
      registerHandler: false,
      triggerSync: false,
      showAuthError: false,
    });
  });

  it('authResult === "success" かつ refresh 失敗なら hadGhUser に関わらず showAuthError を立てる', () => {
    const withoutPrior = resolveAuthRefreshOutcome({
      refreshOk: false,
      user: null,
      hadGhUser: false,
      authResult: 'success',
    });
    expect(withoutPrior.showAuthError).toBe(true);
    expect(withoutPrior.clearSession).toBe(false);

    const withPrior = resolveAuthRefreshOutcome({
      refreshOk: false,
      user: null,
      hadGhUser: true,
      authResult: 'success',
    });
    expect(withPrior.showAuthError).toBe(true);
    expect(withPrior.clearSession).toBe(true);
  });

  it('refreshOk=true でも user が falsy ならセッション有効扱いにしない', () => {
    const outcome = resolveAuthRefreshOutcome({
      refreshOk: true,
      user: null,
      hadGhUser: true,
      authResult: null,
    });
    expect(outcome.setUser).toBeNull();
    expect(outcome.clearSession).toBe(true);
    expect(outcome.registerHandler).toBe(false);
  });
});
