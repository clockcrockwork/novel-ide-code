import { useState, useEffect } from 'react';
import { useApp } from '../../context/AppContext';
import ModuleWrapper from '../common/ModuleWrapper';
import { workerFetch, workerFetchWithCSRF } from '../../lib/workerClient';
import { dbGet } from '../../lib/db';

function DevicesBody() {
  const { ghUser } = useApp();
  // null = 読み込み中、false = エラー、array = データ
  const [devices, setDevices] = useState(null);
  const [myDeviceId, setMyDeviceId] = useState(null);
  const [meta, setMeta] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    dbGet('meta', 'deviceId')
      .then((r) => setMyDeviceId(r?.value ?? null))
      .catch(console.warn);
  }, []);

  useEffect(() => {
    if (!ghUser) return undefined;
    let cancelled = false;
    workerFetch('/sync/devices')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((data) => {
        if (cancelled) return;
        setMeta(data);
        setDevices(Object.values(data.devices ?? {}));
      })
      .catch(() => {
        if (!cancelled) setDevices(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ghUser, reloadKey]);

  const removeDevice = async (id) => {
    const target = devices?.find((d) => d.id === id);
    if (!target) return;
    if (!window.confirm(`デバイス「${target.name}」を削除しますか？`)) return;
    const r = await workerFetchWithCSRF(`/sync/devices/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _branch: meta?._branch }),
    }).catch(() => null);
    if (!r) {
      window.alert('通信エラーが発生しました。');
      return;
    }
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      window.alert(`削除に失敗しました: ${err.error || r.status}`);
      return;
    }
    setReloadKey((k) => k + 1);
  };

  if (!ghUser) {
    return <div style={{ fontSize: 12, color: 'var(--tx3)' }}>GitHub 未接続</div>;
  }

  if (devices === null) {
    return <div style={{ fontSize: 12, color: 'var(--tx3)' }}>読み込み中…</div>;
  }

  if (devices === false) {
    return (
      <div style={{ fontSize: 12, color: 'var(--ac-red, #e74c3c)' }}>読み込みに失敗しました</div>
    );
  }

  if (!devices.length) {
    return (
      <div style={{ fontSize: 12, color: 'var(--tx3)' }}>デバイスなし（同期後に表示されます）</div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {devices.map((d) => {
        const isMe = d.id === myDeviceId;
        const lastSeen = d.lastSeenAt
          ? new Date(d.lastSeenAt).toLocaleString('ja-JP', {
              month: 'numeric',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })
          : '不明';
        return (
          <div
            key={d.id}
            style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 11 }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: isMe ? 'var(--ac)' : 'var(--tx)',
                }}
              >
                {d.name}
                {isMe ? '（このデバイス）' : ''}
              </div>
              <div style={{ color: 'var(--tx3)', fontSize: 10 }}>最終同期: {lastSeen}</div>
            </div>
            {myDeviceId !== null && !isMe && (
              <button
                type="button"
                className="btn-ghost"
                style={{ fontSize: 10, padding: '2px 6px', flexShrink: 0 }}
                onClick={() => removeDevice(d.id)}
              >
                削除
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function DevicesMod() {
  return (
    <ModuleWrapper title="デバイス">
      <DevicesBody />
    </ModuleWrapper>
  );
}
