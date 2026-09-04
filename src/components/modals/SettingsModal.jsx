import { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { useUIStore } from '../../stores/uiStore';
import { GearIcon } from '../Icons';
import { ensureNotificationPermission } from '../../lib/notify';
import { normalizeFlowtimeNotification } from '../../lib/flowtimeNotification';
import { normalizeSyncNotification } from '../../lib/syncNotification';
import { normalizeDeadlineNotification } from '../../lib/deadlineNotification';

const FONTS = [
  { v: 'noto-serif', l: '明朝体 (Noto Serif JP)' },
  { v: 'noto-sans', l: 'ゴシック体 (Noto Sans JP)' },
  { v: 'monospace', l: '等幅 (Monospace)' },
];
const WIDTHS = [
  { l: 'ナロー', v: 480 },
  { l: '標準', v: 680 },
  { l: 'ワイド', v: 860 },
  { l: '全幅', v: '100%' },
];

function FontSizeRows({ s, set, showWidth }) {
  return (
    <>
      <div className="srow">
        <label className="slabel" htmlFor="settings-font">
          フォント
        </label>
        <select
          id="settings-font"
          aria-label="フォント"
          className="sel"
          value={s.font}
          onChange={(e) => set({ font: e.target.value })}
        >
          {FONTS.map((f) => (
            <option key={f.v} value={f.v}>
              {f.l}
            </option>
          ))}
        </select>
      </div>
      <div className="srow">
        <label className="slabel">
          文字サイズ <span className="sval">{s.fontSize}px</span>
        </label>
        <input
          type="range"
          min={12}
          max={26}
          step={1}
          value={s.fontSize}
          onChange={(e) => set({ fontSize: +e.target.value })}
        />
      </div>
      <div className="srow">
        <label className="slabel">
          行間 <span className="sval">{s.lineHeight}</span>
        </label>
        <input
          type="range"
          min={1.2}
          max={3.5}
          step={0.1}
          value={s.lineHeight}
          onChange={(e) => set({ lineHeight: +e.target.value })}
        />
      </div>
      <div className="srow">
        <label className="slabel">
          字間 <span className="sval">{(s.letterSpacing / 100).toFixed(2)}em</span>
        </label>
        <input
          type="range"
          min={0}
          max={25}
          step={1}
          value={s.letterSpacing}
          onChange={(e) => set({ letterSpacing: +e.target.value })}
        />
      </div>
      {showWidth && (
        <div className="srow hide-m">
          <label className="slabel">エディタ幅</label>
          <div className="wbtns">
            {WIDTHS.map((w) => (
              <button
                type="button"
                key={w.l}
                className={`wbtn${s.width === w.v ? ' on' : ''}`}
                onClick={() => set({ width: w.v })}
              >
                {w.l}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

export default function SettingsModal() {
  const { settings, setSettings, DEFAULT_SETTINGS } = useApp();
  const sidebarSide = useUIStore((s) => s.sidebarSide);
  const setSidebarSide = useUIStore((s) => s.setSidebarSide);
  const showLineNumbers = useUIStore((s) => s.showLineNumbers);
  const setShowLineNumbers = useUIStore((s) => s.setShowLineNumbers);
  const splitSwapped = useUIStore((s) => s.splitSwapped);
  const setSplitSwapped = useUIStore((s) => s.setSplitSwapped);
  const colors = useUIStore((s) => s.colors);
  const setColors = useUIStore((s) => s.setColors);
  const setShowSettings = useUIStore((s) => s.setShowSettings);
  const setClearDataModal = useUIStore((s) => s.setClearDataModal);
  const setRestoreDataModal = useUIStore((s) => s.setRestoreDataModal);
  const [s, setS] = useState(settings);
  const [tab, setTab] = useState('write');

  const setW = (f) => setS((v) => ({ ...v, write: { ...v.write, ...f } }));
  const setP = (f) => setS((v) => ({ ...v, preview: { ...v.preview, ...f } }));
  const save = () => {
    setSettings((prev) => {
      const prevDl = prev.notifications?.deadline;
      const nextDl = s.notifications?.deadline;
      if (
        prevDl &&
        nextDl &&
        prevDl.deadlineAt === nextDl.deadlineAt &&
        JSON.stringify(prevDl.thresholds) === JSON.stringify(nextDl.thresholds)
      ) {
        return {
          ...s,
          notifications: {
            ...s.notifications,
            deadline: { ...nextDl, notifiedThresholds: prevDl.notifiedThresholds },
          },
        };
      }
      return s;
    });
    setShowSettings(false);
  };

  const setNotif = (key, patch) =>
    setS((v) => ({
      ...v,
      notifications: {
        ...v.notifications,
        [key]: { ...(v.notifications?.[key] ?? {}), ...patch },
      },
    }));

  const ftCfg = normalizeFlowtimeNotification(s.notifications?.flowtime);
  const syncCfg = normalizeSyncNotification(s.notifications?.sync);
  const dlCfg = normalizeDeadlineNotification(s.notifications?.deadline);

  const COLOR_ROWS = [
    { key: 'bodyText', label: '本文テキスト', dflt: '#e3dfd8' },
    { key: 'comment', label: '// コメント行', dflt: '#6a9ab0' },
    { key: 'memo', label: '/* メモ */', dflt: '#b89a6a' },
  ];

  return (
    <div
      className="overlay"
      onClick={(e) => e.target === e.currentTarget && setShowSettings(false)}
    >
      <div className="modal">
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
          <span className="mtitle">
            <GearIcon s={16} />
            設定
          </span>
          <button type="button" className="mclose" onClick={() => setShowSettings(false)}>
            ×
          </button>
        </div>

        <div className="stabs">
          {['write', 'preview', 'common', 'github', 'data'].map((t) => (
            <button
              type="button"
              key={t}
              className={`stab${tab === t ? ' on' : ''}`}
              onClick={() => setTab(t)}
            >
              {
                {
                  write: '執筆',
                  preview: 'プレビュー',
                  common: '共通',
                  github: 'GitHub',
                  data: 'データ',
                }[t]
              }
            </button>
          ))}
        </div>

        {tab === 'write' && (
          <>
            <FontSizeRows s={s.write || DEFAULT_SETTINGS.write} set={setW} showWidth />
            <div style={{ borderTop: '1px solid var(--bd)', marginTop: 4, paddingTop: 14 }}>
              <div className="slabel" style={{ marginBottom: 10 }}>
                テキストカラー
              </div>
              {COLOR_ROWS.map(({ key, label, dflt }) => (
                <div
                  key={key}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 9 }}
                >
                  <label style={{ flex: 1, fontSize: 12, color: 'var(--tx2)' }}>{label}</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: 4,
                        border: '1px solid var(--bd2)',
                        background: colors?.[key] || dflt,
                        flexShrink: 0,
                        boxShadow: 'var(--nd-sm)',
                      }}
                    />
                    <input
                      type="color"
                      value={colors?.[key] || dflt}
                      onChange={(e) => setColors((c) => ({ ...c, [key]: e.target.value }))}
                      style={{
                        width: 28,
                        height: 22,
                        border: '1px solid var(--bd)',
                        borderRadius: 4,
                        cursor: 'pointer',
                        background: 'transparent',
                        padding: 1,
                        flexShrink: 0,
                      }}
                    />
                    {colors?.[key] && (
                      <button
                        type="button"
                        onClick={() => setColors((c) => ({ ...c, [key]: '' }))}
                        style={{
                          fontSize: 10,
                          color: 'var(--tx3)',
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          padding: '0 3px',
                          fontFamily: 'inherit',
                        }}
                      >
                        ↺
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {tab === 'preview' && <FontSizeRows s={s.preview || DEFAULT_SETTINGS.preview} set={setP} />}

        {tab === 'common' && (
          <>
            <div className="srow">
              <label className="slabel">サイドバーの位置</label>
              <div className="sbtns">
                {[
                  { v: 'left', l: '◧ 左' },
                  { v: 'right', l: '▣ 右' },
                ].map((o) => (
                  <button
                    type="button"
                    key={o.v}
                    className={`wbtn${sidebarSide === o.v ? ' on' : ''}`}
                    style={{ flex: 1, padding: '8px 0', fontSize: 13 }}
                    onClick={() => setSidebarSide(o.v)}
                  >
                    {o.l}
                  </button>
                ))}
              </div>
            </div>
            <div className="srow">
              <label className="slabel">2分割表示</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 7,
                    cursor: 'pointer',
                    fontSize: 13,
                    color: 'var(--tx2)',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={splitSwapped}
                    onChange={(e) => setSplitSwapped(e.target.checked)}
                    style={{ accentColor: 'var(--ac)', width: 14, height: 14 }}
                  />
                  参照とメインの位置を入れ替える
                </label>
              </div>
            </div>
            <div className="srow">
              <label className="slabel">行番号</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 7,
                    cursor: 'pointer',
                    fontSize: 13,
                    color: 'var(--tx2)',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={showLineNumbers}
                    onChange={(e) => setShowLineNumbers(e.target.checked)}
                    style={{ accentColor: 'var(--ac)', width: 14, height: 14 }}
                  />
                  執筆モードで行番号を表示
                </label>
              </div>
            </div>
            <div className="srow">
              <label className="slabel" style={{ color: 'var(--tx3)', fontSize: 10 }}>
                コメント表記
              </label>
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--tx2)',
                  lineHeight: 1.7,
                  background: 'var(--sf2)',
                  borderRadius: 'var(--rs)',
                  padding: '9px 12px',
                }}
              >
                <div>
                  <span
                    style={{
                      color: 'var(--hl-comment)',
                      fontStyle: 'italic',
                      fontFamily: 'monospace',
                    }}
                  >
                    //
                  </span>{' '}
                  から始まる行 — 執筆時のみ表示、プレビューで非表示
                </div>
                <div style={{ marginTop: 5 }}>
                  <span style={{ color: 'var(--hl-memo)', fontFamily: 'monospace' }}>
                    {'/*...*/'}
                  </span>
                  {' — インラインメモ、プレビューで非表示。旧式メモもこの表記に統一されます'}
                </div>
              </div>
            </div>

            <div style={{ borderTop: '1px solid var(--bd)', marginTop: 12, paddingTop: 14 }}>
              <div className="slabel" style={{ marginBottom: 12 }}>
                通知
              </div>

              {/* フロータイム離脱検知 */}
              <div
                className="srow"
                style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}
              >
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 7,
                    cursor: 'pointer',
                    fontSize: 13,
                    color: 'var(--tx2)',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={ftCfg.enabled}
                    onChange={async (e) => {
                      const checked = e.target.checked;
                      if (checked) await ensureNotificationPermission();
                      setNotif('flowtime', { enabled: checked });
                    }}
                    style={{ accentColor: 'var(--ac)', width: 14, height: 14 }}
                  />
                  フロータイム中の離脱を通知
                </label>
                {ftCfg.enabled && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      marginLeft: 21,
                      fontSize: 12,
                      color: 'var(--tx3)',
                    }}
                  >
                    <span>離脱しきい値</span>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={ftCfg.distractionThresholdMin}
                      onChange={(e) =>
                        setNotif('flowtime', {
                          distractionThresholdMin: Math.max(1, Number(e.target.value) || 5),
                        })
                      }
                      style={{
                        width: 52,
                        fontSize: 12,
                        padding: '3px 6px',
                        borderRadius: 'var(--rs)',
                        border: '1px solid var(--bd)',
                        background: 'var(--sf)',
                        color: 'var(--tx)',
                      }}
                    />
                    <span>分</span>
                  </div>
                )}
              </div>

              {/* 同期完了 */}
              <div
                className="srow"
                style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 6, marginTop: 8 }}
              >
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 7,
                    cursor: 'pointer',
                    fontSize: 13,
                    color: 'var(--tx2)',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={syncCfg.enabled}
                    onChange={async (e) => {
                      const checked = e.target.checked;
                      if (checked && syncCfg.delivery === 'browser')
                        await ensureNotificationPermission();
                      setNotif('sync', { enabled: checked });
                    }}
                    style={{ accentColor: 'var(--ac)', width: 14, height: 14 }}
                  />
                  GitHub同期完了を通知
                </label>
                {syncCfg.enabled && (
                  <div style={{ display: 'flex', gap: 4, marginLeft: 21 }}>
                    {[
                      { v: 'toast', l: 'アプリ内' },
                      { v: 'browser', l: 'OS通知' },
                    ].map((o) => (
                      <button
                        type="button"
                        key={o.v}
                        onClick={async () => {
                          if (o.v === 'browser') await ensureNotificationPermission();
                          setNotif('sync', { delivery: o.v });
                        }}
                        style={{
                          padding: '4px 10px',
                          fontSize: 11,
                          fontFamily: 'inherit',
                          cursor: 'pointer',
                          borderRadius: 'var(--rs)',
                          background: syncCfg.delivery === o.v ? 'var(--ac-bg)' : 'var(--sf2)',
                          border: `1px solid ${syncCfg.delivery === o.v ? 'var(--ac)' : 'var(--bd)'}`,
                          color: syncCfg.delivery === o.v ? 'var(--ac)' : 'var(--tx3)',
                        }}
                      >
                        {o.l}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* 締め切り */}
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 7,
                    cursor: 'pointer',
                    fontSize: 13,
                    color: 'var(--tx2)',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={dlCfg.enabled}
                    onChange={async (e) => {
                      const checked = e.target.checked;
                      if (checked && dlCfg.delivery === 'browser')
                        await ensureNotificationPermission();
                      setNotif('deadline', { enabled: checked });
                    }}
                    style={{ accentColor: 'var(--ac)', width: 14, height: 14 }}
                  />
                  締め切り通知
                </label>
                {dlCfg.enabled && (
                  <div
                    style={{
                      marginLeft: 21,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                      fontSize: 12,
                      color: 'var(--tx3)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ whiteSpace: 'nowrap' }}>締め切り日時</span>
                      <input
                        type="datetime-local"
                        value={dlCfg.deadlineAt ? dlCfg.deadlineAt.slice(0, 16) : ''}
                        onChange={(e) =>
                          setNotif('deadline', {
                            deadlineAt: e.target.value || null,
                            notifiedThresholds: [],
                          })
                        }
                        style={{
                          flex: 1,
                          fontSize: 12,
                          padding: '3px 6px',
                          borderRadius: 'var(--rs)',
                          border: '1px solid var(--bd)',
                          background: 'var(--sf)',
                          color: 'var(--tx)',
                        }}
                      />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ whiteSpace: 'nowrap' }}>通知タイミング（分前）</span>
                      <input
                        type="text"
                        defaultValue={dlCfg.thresholds.join(', ')}
                        onBlur={(e) => {
                          const vals = e.target.value
                            .split(',')
                            .map((x) => Number(x.trim()))
                            .filter((n) => Number.isFinite(n) && n >= 0);
                          if (vals.length) {
                            setNotif('deadline', { thresholds: vals, notifiedThresholds: [] });
                            e.target.value = [...new Set(vals)].sort((a, b) => b - a).join(', ');
                          }
                        }}
                        style={{
                          flex: 1,
                          fontSize: 12,
                          padding: '3px 6px',
                          borderRadius: 'var(--rs)',
                          border: '1px solid var(--bd)',
                          background: 'var(--sf)',
                          color: 'var(--tx)',
                        }}
                      />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ whiteSpace: 'nowrap' }}>確認間隔</span>
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={dlCfg.checkIntervalMin}
                        onChange={(e) =>
                          setNotif('deadline', {
                            checkIntervalMin: Math.max(1, Number(e.target.value) || 1),
                          })
                        }
                        style={{
                          width: 52,
                          fontSize: 12,
                          padding: '3px 6px',
                          borderRadius: 'var(--rs)',
                          border: '1px solid var(--bd)',
                          background: 'var(--sf)',
                          color: 'var(--tx)',
                        }}
                      />
                      <span>分</span>
                    </div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {[
                        { v: 'browser', l: 'OS通知' },
                        { v: 'toast', l: 'アプリ内' },
                      ].map((o) => (
                        <button
                          type="button"
                          key={o.v}
                          onClick={async () => {
                            if (o.v === 'browser') await ensureNotificationPermission();
                            setNotif('deadline', { delivery: o.v });
                          }}
                          style={{
                            padding: '4px 10px',
                            fontSize: 11,
                            fontFamily: 'inherit',
                            cursor: 'pointer',
                            borderRadius: 'var(--rs)',
                            background: dlCfg.delivery === o.v ? 'var(--ac-bg)' : 'var(--sf2)',
                            border: `1px solid ${dlCfg.delivery === o.v ? 'var(--ac)' : 'var(--bd)'}`,
                            color: dlCfg.delivery === o.v ? 'var(--ac)' : 'var(--tx3)',
                          }}
                        >
                          {o.l}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {tab === 'github' && (
          <>
            <div className="srow">
              <label className="slabel">コミットメッセージ</label>
              <input
                className="sinput"
                value={s.github?.commitMessage ?? DEFAULT_SETTINGS.github.commitMessage}
                onChange={(e) =>
                  setS((v) => ({ ...v, github: { ...v.github, commitMessage: e.target.value } }))
                }
                placeholder="原稿を更新"
              />
            </div>
            <div
              style={{
                fontSize: 11,
                color: 'var(--tx3)',
                lineHeight: 1.7,
                background: 'var(--sf2)',
                borderRadius: 'var(--rs)',
                padding: '8px 12px',
              }}
            >
              使用できる変数:
              <br />
              <code style={{ fontFamily: 'monospace' }}>{'{filename}'}</code> — ファイル名（例:
              第一章.md）
              <br />
              <code style={{ fontFamily: 'monospace' }}>{'{date}'}</code> — 日付（例: 2026-05-05）
              <br />
              <code style={{ fontFamily: 'monospace' }}>{'{time}'}</code> — 時刻（例: 14:30）
            </div>
          </>
        )}

        {tab === 'data' && (
          <>
            <div className="slabel" style={{ marginBottom: 8 }}>
              バックアップから復元
            </div>
            <p style={{ fontSize: 12, color: 'var(--tx2)', lineHeight: 1.7, margin: '0 0 12px' }}>
              「全データバックアップ (.json)」でエクスポートしたファイルから、この端末のデータを
              復元します。現在のデータは復元内容で完全に置き換えられます。
            </p>
            <button
              type="button"
              className="btn-ghost"
              style={{ marginBottom: 24 }}
              onClick={() => setRestoreDataModal({})}
            >
              バックアップから復元…
            </button>

            <div className="slabel" style={{ marginBottom: 8 }}>
              ローカルデータの削除
            </div>
            <p style={{ fontSize: 12, color: 'var(--tx2)', lineHeight: 1.7, margin: '0 0 12px' }}>
              この端末（IndexedDB と localStorage）に保存された novel-ide
              の本文・ファイル・フォルダ・設定・連携情報をすべて削除し、初期状態に戻します。GitHub
              に push 済みの内容は影響を受けません。
            </p>
            <button
              type="button"
              style={{
                padding: '8px 14px',
                background: 'none',
                border: '1px solid var(--err, #e74c3c)',
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: 13,
                color: 'var(--err, #e74c3c)',
                fontFamily: 'inherit',
              }}
              onClick={() => setClearDataModal({})}
            >
              ローカルデータをすべて削除
            </button>
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
          <button type="button" className="btn-ghost" onClick={() => setShowSettings(false)}>
            キャンセル
          </button>
          <button type="button" className="btn-primary" onClick={save}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
