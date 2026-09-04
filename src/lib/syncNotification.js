export const DEFAULT_SYNC_NOTIFICATION = Object.freeze({
  enabled: false,
  delivery: 'toast',
});

export function normalizeSyncNotification(config) {
  return {
    enabled: config?.enabled === true,
    delivery: config?.delivery === 'browser' ? 'browser' : 'toast',
  };
}

export function buildSyncCompletePayload(delivery = 'toast') {
  return {
    delivery,
    title: '同期完了',
    body: 'GitHubへの同期が完了しました。',
    tag: 'sync-complete',
    message: '同期完了',
  };
}
