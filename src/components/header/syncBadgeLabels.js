// errorCategory 別のラベル。件数だけの文言（「N 件のファイルを同期できませんでした」）では
// 422 / 5xx / 403 が同一表示になり、「待てば直る」「権限を直す」「データが受け付けられない」の
// 区別が利用者に届かない。ラベルで種別を、title で行動指示を出す。
export const ERROR_LABEL = {
  conflict: '再同期が必要',
  auth: '再ログインが必要',
  forbidden: '権限・制限エラー',
  unprocessable: '同期データエラー',
  workspace_inconsistent: '同期を中止',
  corrupt: '同期データ破損',
  internal: '同期を中止',
  // upstream は GitHub 側の障害と worker 自身のレートリミット（429）の両方を含むため、
  // 原因を GitHub に帰属させない。詳細文言も同じ方針（syncErrors.js の CATEGORY_MESSAGE）。
  upstream: '時間をおいて再試行',
  network: '通信エラー',
  too_large: 'サイズ超過',
  server: '同期失敗',
  // remote が新しい formatVersion を宣言しており、この client では安全に書き込めない（#609 A-2）。
  protocol_upgrade_required: 'アプリの更新が必要',
};
