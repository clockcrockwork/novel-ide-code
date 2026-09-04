import { useState, useEffect, useRef } from 'react';
import ModuleWrapper from '../common/ModuleWrapper';
import { useUIStore } from '../../stores/uiStore';
import {
  checkNotificationPermission,
  createLocalPomodoroNotifier,
  createNotifier,
} from '../../lib/notify';
import {
  normalizeFlowtimeNotification,
  buildDistractedNotificationPayload,
} from '../../lib/flowtimeNotification';

export default function FlowTimeMod() {
  const [elapsed, setElapsed] = useState(0);
  const [active, setActive] = useState(false);
  const [log, setLog] = useState([]);
  const ref = useRef(null);
  const t0 = useRef(null);
  const lastDistractedNotifiedAt = useRef(null);

  const flowtimeSettings = useUIStore((s) => s.settings?.notifications?.flowtime);
  const notifCfg = normalizeFlowtimeNotification(flowtimeSettings);

  useEffect(() => {
    clearInterval(ref.current);
    if (!active) return;
    t0.current = Date.now() - elapsed * 1000;
    ref.current = setInterval(() => setElapsed(Math.floor((Date.now() - t0.current) / 1000)), 1000);
    return () => clearInterval(ref.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // 離脱検知ポーリング（1分ごと）
  useEffect(() => {
    if (!active || !notifCfg.enabled) return;
    const thresholdMs = notifCfg.distractionThresholdMin * 60 * 1000;
    const cooldownMs = thresholdMs;

    const sender = createLocalPomodoroNotifier();
    const notify = createNotifier({ localSender: sender });
    const check = async () => {
      const now = Date.now();
      const lastActivity =
        Math.max(useUIStore.getState().lastEditorActivityAt ?? 0, t0.current ?? 0) || now;
      const idleMs = now - lastActivity;
      if (idleMs < thresholdMs) return;
      if (lastDistractedNotifiedAt.current && now - lastDistractedNotifiedAt.current < cooldownMs)
        return;

      if (!checkNotificationPermission()) return;
      lastDistractedNotifiedAt.current = now;
      const payload = buildDistractedNotificationPayload(idleMs / 60000, notifCfg.delivery);
      await notify('flowtime', 'distracted', payload);
    };

    const id = setInterval(check, 60 * 1000);
    return () => clearInterval(id);
  }, [active, notifCfg.enabled, notifCfg.distractionThresholdMin, notifCfg.delivery]);

  const reset = () => {
    clearInterval(ref.current);
    setActive(false);
    lastDistractedNotifiedAt.current = null;
    if (elapsed > 30) setLog((l) => [...l.slice(-4), elapsed]);
    setElapsed(0);
  };

  const fmt = (s) =>
    `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  return (
    <ModuleWrapper title="フロータイム" icon="⏱" keepMounted>
      <div style={{ textAlign: 'center', marginBottom: 10 }}>
        <div
          style={{
            fontSize: 26,
            fontWeight: 300,
            letterSpacing: '.1em',
            color: active ? 'var(--ac)' : 'var(--tx)',
            fontVariantNumeric: 'tabular-nums',
            transition: 'color .3s',
          }}
        >
          {fmt(elapsed)}
        </div>
        <div style={{ fontSize: 10, color: 'var(--tx3)', marginTop: 3 }}>
          {active ? '執筆中…' : elapsed > 0 ? '一時停止' : '未開始'}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          type="button"
          className="nb nb-text"
          style={{ flex: 1, height: 32 }}
          onClick={() => setActive((v) => !v)}
        >
          {active ? '⏸ 一時停止' : '▶ 開始'}
        </button>
        <button
          type="button"
          className="nb nb-icon"
          style={{ width: 32, height: 32, fontSize: 16 }}
          onClick={reset}
          title="保存してリセット"
        >
          ↺
        </button>
      </div>
      {log.length > 0 && (
        <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--bd)' }}>
          <div style={{ fontSize: 10, color: 'var(--tx3)', marginBottom: 4 }}>セッション履歴</div>
          {log.slice(-3).map((s, i) => (
            <div key={i} style={{ fontSize: 11, color: 'var(--tx2)', padding: '2px 0' }}>
              {fmt(s)}
            </div>
          ))}
        </div>
      )}
    </ModuleWrapper>
  );
}
