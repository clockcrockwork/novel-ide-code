// 起動時の /auth/refresh 応答から、ghUser の反映方法・401 ハンドラの登録可否・自動同期の
// 起動可否・認証エラー表示の要否を判定する純関数（AppContext から分離してテスト可能にする）。
//
// 背景: ghUser は uiStore の persist（localStorage）から同期的に復元されるため、
// 「セッション切れのログイン済みユーザー」は refresh の結果を待たずログイン済みとして
// 描画される。refresh の結果と復元済み ghUser の有無を掛け合わせて分岐する。
//
// authResult === 'success'（OAuth 直後）のときは、refresh が失敗すれば
// 既存のエラー表示（setAuthError / setShowGithub）を維持する。
export function resolveAuthRefreshOutcome({ refreshOk, user, hadGhUser, authResult }) {
  const sessionValid = Boolean(refreshOk) && Boolean(user);
  if (sessionValid) {
    return {
      setUser: user,
      clearSession: false,
      registerHandler: true,
      triggerSync: true,
      showAuthError: false,
    };
  }
  return {
    setUser: null,
    clearSession: Boolean(hadGhUser),
    registerHandler: false,
    triggerSync: false,
    showAuthError: authResult === 'success',
  };
}
