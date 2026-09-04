export const DEFAULT_POMODORO_NOTIFICATION = Object.freeze({ enabled: false, delivery: 'local' });

export function normalizePomodoroNotification(config) {
  return {
    enabled: config?.enabled === true,
    delivery: config?.delivery === 'remote' ? 'remote' : 'local',
  };
}

export function buildPhaseSwitchedNotificationPayload(
  previousPhase,
  nextPhase,
  delivery = 'local',
) {
  return {
    delivery,
    previousPhase: previousPhase.label,
    nextPhase: nextPhase.label,
    title: `ポモドーロ: ${nextPhase.label}`,
    body: `${previousPhase.label}が終了し、${nextPhase.label}(${nextPhase.min}分)を開始します。`,
    tag: 'pomodoro-phase-notification',
  };
}
