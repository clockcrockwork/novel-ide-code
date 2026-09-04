import { describe, it, expect } from 'vitest';
import {
  normalizePomodoroNotification,
  buildPhaseSwitchedNotificationPayload,
  DEFAULT_POMODORO_NOTIFICATION,
} from './pomodoroNotification';

describe('normalizePomodoroNotification', () => {
  it('不正入力は厳格にデフォルトへ正規化する', () => {
    expect(normalizePomodoroNotification(null)).toEqual(DEFAULT_POMODORO_NOTIFICATION);
    expect(normalizePomodoroNotification({ enabled: 'x', delivery: 'invalid' })).toEqual(
      DEFAULT_POMODORO_NOTIFICATION,
    );
  });

  it('enabled が boolean true の場合だけ true を維持する', () => {
    expect(normalizePomodoroNotification({ enabled: true, delivery: 'local' })).toEqual({
      enabled: true,
      delivery: 'local',
    });
    expect(normalizePomodoroNotification({ enabled: false, delivery: 'local' })).toEqual(
      DEFAULT_POMODORO_NOTIFICATION,
    );
  });

  it('delivery remote を保持する', () => {
    expect(normalizePomodoroNotification({ enabled: true, delivery: 'remote' })).toEqual({
      enabled: true,
      delivery: 'remote',
    });
  });
});

describe('buildPhaseSwitchedNotificationPayload', () => {
  it('フェーズ切替payloadを組み立てる', () => {
    const payload = buildPhaseSwitchedNotificationPayload(
      { label: '集中', min: 25 },
      { label: '休憩', min: 5 },
      'local',
    );
    expect(payload).toMatchObject({
      delivery: 'local',
      previousPhase: '集中',
      nextPhase: '休憩',
    });
    expect(payload.title).toContain('休憩');
    expect(payload.body).toContain('5分');
    expect(payload.tag).toBe('pomodoro-phase-notification');
  });
});
