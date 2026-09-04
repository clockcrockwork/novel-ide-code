export const DEFAULT_DEADLINE_NOTIFICATION = Object.freeze({
  enabled: false,
  delivery: 'browser',
  deadlineAt: null,
  thresholds: [1440, 60, 0],
  checkIntervalMin: 1,
  notifiedThresholds: [],
});

export function normalizeDeadlineNotification(config) {
  const thresholds = Array.isArray(config?.thresholds)
    ? [...new Set(config.thresholds.map(Number))]
        .filter((n) => Number.isFinite(n) && n >= 0)
        .sort((a, b) => b - a)
    : [1440, 60, 0];
  const intervalMin = Number(config?.checkIntervalMin);
  return {
    enabled: config?.enabled === true,
    delivery: config?.delivery === 'toast' ? 'toast' : 'browser',
    deadlineAt: typeof config?.deadlineAt === 'string' ? config.deadlineAt : null,
    thresholds,
    checkIntervalMin: Number.isFinite(intervalMin) && intervalMin >= 1 ? intervalMin : 1,
    notifiedThresholds: Array.isArray(config?.notifiedThresholds) ? config.notifiedThresholds : [],
  };
}

export function isThresholdReached(deadlineAt, thresholdMin, now = Date.now()) {
  if (!deadlineAt) return false;
  const deadlineMs = new Date(deadlineAt).getTime();
  if (!Number.isFinite(deadlineMs)) return false;
  const triggerMs = deadlineMs - thresholdMin * 60 * 1000;
  return now >= triggerMs;
}

export function buildDeadlinePayload(deadlineAt, thresholdMin, delivery = 'browser') {
  const labels = {
    1440: '24時間前',
    60: '1時間前',
    0: '締め切り到来',
  };
  const label = labels[thresholdMin] ?? `${thresholdMin}分前`;
  const date = new Date(deadlineAt);
  const dateStr =
    deadlineAt && !isNaN(date.getTime())
      ? date.toLocaleString('ja-JP', {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '';
  return {
    delivery,
    title: `締め切り: ${label}`,
    body: dateStr ? `締め切り（${dateStr}）まで${label}です。` : `締め切りまで${label}です。`,
    tag: `deadline-${thresholdMin}`,
  };
}
