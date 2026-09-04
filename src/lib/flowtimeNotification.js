export const DEFAULT_FLOWTIME_NOTIFICATION = Object.freeze({
  enabled: false,
  delivery: 'browser',
  distractionThresholdMin: 5,
});

export function normalizeFlowtimeNotification(config) {
  const thresholdMin = Number(config?.distractionThresholdMin);
  return {
    enabled: config?.enabled === true,
    delivery: config?.delivery === 'local' ? 'local' : 'browser',
    distractionThresholdMin: Number.isFinite(thresholdMin) && thresholdMin > 0 ? thresholdMin : 5,
  };
}

export function buildDistractedNotificationPayload(elapsedMin, delivery = 'browser') {
  return {
    delivery,
    title: '小説IDE',
    body: `フロータイムセッション中です。執筆から ${Math.round(elapsedMin)} 分が経過しています。`,
    tag: 'flowtime-distracted',
  };
}
