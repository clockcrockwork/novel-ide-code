import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import ModuleWrapper from '../common/ModuleWrapper';
import { useApp } from '../../context/AppContext';
import { uiActions } from '../../stores/uiStore';
import {
  createNotifier,
  createLocalPomodoroNotifier,
  ensureNotificationPermission,
} from '../../lib/notify';
import {
  DEFAULT_POMODORO_NOTIFICATION,
  normalizePomodoroNotification,
  buildPhaseSwitchedNotificationPayload,
} from '../../lib/pomodoroNotification';

const PHASES = [
  { label: '集中', min: 25, color: 'var(--ac)' },
  { label: '休憩', min: 5, color: 'oklch(.68 .1 200)' },
  { label: '長休憩', min: 15, color: 'oklch(.68 .1 160)' },
];

export default function PomodoroMod() {
  const { settings, setSettings } = useApp();
  const pomodoroNotification = normalizePomodoroNotification(
    settings?.notifications?.pomodoro ?? DEFAULT_POMODORO_NOTIFICATION,
  );
  const [ph, setPh] = useState(0);
  const [secs, setSecs] = useState(25 * 60);
  const [running, setRunning] = useState(false);
  const [cycles, setCycles] = useState(0);
  const timerRef = useRef(null);
  const deadlineRef = useRef(null);
  const phRef = useRef(0);
  const secsRef = useRef(25 * 60);
  const transitioningRef = useRef(false);
  const notificationRef = useRef(pomodoroNotification);

  useEffect(() => {
    phRef.current = ph;
  }, [ph]);

  useEffect(() => {
    secsRef.current = secs;
  }, [secs]);

  useEffect(() => {
    notificationRef.current = pomodoroNotification;
  }, [pomodoroNotification]);

  const notify = useMemo(
    () =>
      createNotifier({
        localSender: createLocalPomodoroNotifier({
          onNotifyClick: () => uiActions.setSidebarOpen(true),
        }),
        remoteSender: async () => false,
        logger: (...args) => {
          if (import.meta.env.DEV) console.debug(...args);
        },
      }),
    [],
  );

  const persistNotification = useCallback(
    (enabled) => {
      setSettings((s) => ({
        ...s,
        notifications: {
          ...s.notifications,
          pomodoro: normalizePomodoroNotification({
            ...s.notifications?.pomodoro,
            enabled,
          }),
        },
      }));
    },
    [setSettings],
  );

  const setNotificationEnabled = useCallback(
    async (enabled) => {
      if (!enabled) {
        persistNotification(false);
        return;
      }
      const granted = await ensureNotificationPermission();
      persistNotification(granted);
    },
    [persistNotification],
  );

  const transitionPhase = useCallback(() => {
    if (transitioningRef.current) return;
    transitioningRef.current = true;

    clearInterval(timerRef.current);
    deadlineRef.current = null;
    setRunning(false);

    const currentPhase = phRef.current;
    const next = (currentPhase + 1) % PHASES.length;
    const prevPhase = PHASES[currentPhase];
    const nextPhase = PHASES[next];

    if (currentPhase === 0) setCycles((c) => c + 1);
    const nextSecs = nextPhase.min * 60;
    phRef.current = next;
    secsRef.current = nextSecs;
    setPh(next);
    setSecs(nextSecs);

    const latestNotification = notificationRef.current;
    if (latestNotification.enabled) {
      void notify(
        'pomodoro',
        'phase-switched',
        buildPhaseSwitchedNotificationPayload(prevPhase, nextPhase, latestNotification.delivery),
      );
    }

    queueMicrotask(() => {
      transitioningRef.current = false;
    });
  }, [notify]);

  useEffect(() => {
    clearInterval(timerRef.current);
    if (!running) return;

    deadlineRef.current = Date.now() + secsRef.current * 1000;

    const tick = () => {
      const remaining = Math.max(0, Math.ceil((deadlineRef.current - Date.now()) / 1000));
      setSecs(remaining);
      if (remaining <= 0) queueMicrotask(() => transitionPhase());
    };

    tick();
    timerRef.current = setInterval(tick, 250);

    return () => clearInterval(timerRef.current);
  }, [running, transitionPhase]);

  const switchPh = (p) => {
    clearInterval(timerRef.current);
    deadlineRef.current = null;
    transitioningRef.current = false;
    const nextSecs = PHASES[p].min * 60;
    phRef.current = p;
    secsRef.current = nextSecs;
    setPh(p);
    setSecs(nextSecs);
    setRunning(false);
  };
  const reset = () => {
    clearInterval(timerRef.current);
    deadlineRef.current = null;
    transitioningRef.current = false;
    const nextSecs = PHASES[phRef.current].min * 60;
    secsRef.current = nextSecs;
    setSecs(nextSecs);
    setRunning(false);
  };

  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');
  const pct = (1 - secs / (PHASES[ph].min * 60)) * 100;

  return (
    <ModuleWrapper title="ポモドーロ" icon="🍅" defaultOpen={true} keepMounted>
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          marginBottom: 10,
          fontSize: 11,
          color: 'var(--tx2)',
        }}
      >
        <input
          type="checkbox"
          checked={Boolean(pomodoroNotification.enabled)}
          onChange={(e) => {
            void setNotificationEnabled(e.target.checked);
          }}
        />
        フェーズ切替時に通知する
      </label>
      <div style={{ display: 'flex', gap: 3, marginBottom: 10 }}>
        {PHASES.map((p, i) => (
          <button
            type="button"
            key={i}
            onClick={() => switchPh(i)}
            style={{
              flex: 1,
              padding: '4px 0',
              fontSize: 10,
              fontFamily: 'inherit',
              cursor: 'pointer',
              borderRadius: 'var(--rs)',
              background: ph === i ? 'var(--ac-bg)' : 'var(--sf2)',
              border: `1px solid ${ph === i ? 'var(--ac)' : 'var(--bd)'}`,
              color: ph === i ? 'var(--ac)' : 'var(--tx3)',
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div style={{ textAlign: 'center', marginBottom: 4 }}>
        <div
          style={{
            fontSize: 10,
            color: 'var(--tx3)',
            letterSpacing: '.07em',
            textTransform: 'uppercase',
            marginBottom: 6,
          }}
        >
          {PHASES[ph].label}
          {cycles > 0 && ` — ${cycles}サイクル完了`}
        </div>
        <div
          style={{
            fontSize: 32,
            fontWeight: 300,
            letterSpacing: '.1em',
            color: 'var(--tx)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {mm}:{ss}
        </div>
      </div>
      <div className="progress-bar" style={{ marginBottom: 12 }}>
        <div className="progress-fill" style={{ width: pct + '%', background: PHASES[ph].color }} />
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          type="button"
          className="nb nb-text"
          style={{ flex: 1, height: 32 }}
          onClick={() => setRunning((v) => !v)}
        >
          {running ? '⏸ 一時停止' : '▶ 開始'}
        </button>
        <button
          type="button"
          className="nb nb-icon"
          style={{ width: 32, height: 32, fontSize: 16 }}
          onClick={reset}
          title="リセット"
        >
          ↺
        </button>
      </div>
    </ModuleWrapper>
  );
}
