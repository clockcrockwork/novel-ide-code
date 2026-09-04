/* eslint-disable react-refresh/only-export-components */
import { StrictMode, useState, useEffect, useRef, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import VirtualList from '../src/components/common/VirtualList.jsx';

const SCENARIOS = {
  default: { label: 'デフォルト (10K行)', rows: 10_000, mode: 'short' },
  large: { label: '大量行 (50K行)', rows: 50_000, mode: 'short' },
  totalChars: { label: '総文字数 500K字 (5K行)', rows: 5_000, mode: 'long' },
  longLine: { label: '超長行 500字/行 (1K行)', rows: 1_000, mode: 'vlong' },
  mixed: { label: '可変高さ混在 (20K行)', rows: 20_000, mode: 'mixed' },
};

function buildItems(rows, mode) {
  return Array.from({ length: rows }, (_, i) => {
    let text;
    if (mode === 'short') {
      text =
        i % 3 === 0
          ? `行 ${i + 1}: ${'あいうえおかきくけこさしすせそ'.repeat(4)}`
          : `行 ${i + 1}: テキスト`;
    } else if (mode === 'long') {
      text = `行 ${i + 1}: ${'あいうえお'.repeat(20)}`;
    } else if (mode === 'vlong') {
      text = `行 ${i + 1}: ${'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほ'.repeat(16)}`;
    } else {
      // mixed: 10%超長行, 20%長行, 残り短行
      if (i % 10 === 0) {
        text = `行 ${i + 1}: ${'あいうえおかきくけこ'.repeat(20)}`;
      } else if (i % 5 === 0) {
        text = `行 ${i + 1}: ${'あいうえお'.repeat(10)}`;
      } else {
        text = `行 ${i + 1}: テキスト`;
      }
    }
    const extra =
      i % 10 === 0 ? `補足: これは長い補足テキストです。行番号は ${i + 1} です。` : null;
    return { id: i, text, extra };
  });
}

function computeStats(items) {
  let totalChars = 0;
  let maxLen = 0;
  for (const item of items) {
    const len = item.text.length + (item.extra?.length ?? 0);
    totalChars += len;
    if (item.text.length > maxLen) maxLen = item.text.length;
  }
  return { totalChars, maxLen };
}

function Row({ item }) {
  return (
    <div
      style={{ padding: '6px 12px', borderBottom: '1px solid #333', fontSize: 13, lineHeight: 1.5 }}
    >
      <div>{item.text}</div>
      {item.extra && <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{item.extra}</div>}
    </div>
  );
}

function Bench() {
  const [scenarioKey, setScenarioKey] = useState('default');
  const [renderMs, setRenderMs] = useState(null);
  const [fpsLog, setFpsLog] = useState([]);
  const [measuring, setMeasuring] = useState(false);
  const listRef = useRef(null);
  const rafRef = useRef(null);
  const fpsAccRef = useRef([]);

  const scenario = SCENARIOS[scenarioKey];

  const items = useMemo(
    () => buildItems(scenario.rows, scenario.mode),
    [scenario.rows, scenario.mode],
  );
  const stats = useMemo(() => computeStats(items), [items]);

  // シナリオ切替・初回ロード時に描画時間を計測（resets happen in onChange handler）
  useEffect(() => {
    const t0 = performance.now();
    const rafId = requestAnimationFrame(() => {
      setRenderMs((performance.now() - t0).toFixed(1));
    });
    return () => cancelAnimationFrame(rafId);
  }, [scenarioKey]);

  const measureFps = () => {
    if (!listRef.current) return;
    setMeasuring(true);
    setFpsLog([]);
    fpsAccRef.current = [];

    let frame = 0;
    let lastTime = performance.now();
    let scrollPos = 0;
    const SCROLL_STEP = 200;
    const MAX_FRAMES = 120;

    const tick = (now) => {
      frame++;
      const delta = now - lastTime;
      const fps = delta > 0 ? Math.round(1000 / delta) : 0;
      lastTime = now;
      fpsAccRef.current.push(fps);

      if (frame % 10 === 0) {
        setFpsLog([...fpsAccRef.current.slice(-30)]);
      }

      scrollPos += SCROLL_STEP;
      listRef.current?.scrollTo(scrollPos);

      if (frame < MAX_FRAMES) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        setFpsLog([...fpsAccRef.current]);
        setMeasuring(false);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  const avgFps =
    fpsLog.length > 1
      ? Math.round(fpsLog.slice(1).reduce((a, b) => a + b, 0) / (fpsLog.length - 1))
      : null;
  const minFps = fpsLog.length > 1 ? Math.min(...fpsLog.slice(1)) : null;

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', height: '100dvh', padding: 16, gap: 12 }}
    >
      <h1 style={{ fontSize: 16, fontWeight: 700 }}>VirtualList Benchmark</h1>

      {/* シナリオ選択 */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 13 }}>
        {Object.entries(SCENARIOS).map(([key, s]) => (
          <label
            key={key}
            style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}
          >
            <input
              type="radio"
              name="scenario"
              value={key}
              checked={scenarioKey === key}
              onChange={() => {
                setScenarioKey(key);
                setRenderMs(null);
                setFpsLog([]);
              }}
            />
            {s.label}
          </label>
        ))}
      </div>

      {/* データ統計 */}
      <div style={{ display: 'flex', gap: 20, fontSize: 12, color: '#aaa' }}>
        <span>
          行数: <strong style={{ color: '#ddd' }}>{items.length.toLocaleString()}</strong>
        </span>
        <span>
          総文字数: <strong style={{ color: '#ddd' }}>{stats.totalChars.toLocaleString()}</strong>
        </span>
        <span>
          最長行: <strong style={{ color: '#ddd' }}>{stats.maxLen.toLocaleString()} 字</strong>
        </span>
      </div>

      {/* 計測パネル */}
      <div style={{ display: 'flex', gap: 24, fontSize: 13, alignItems: 'center' }}>
        <div>
          <span style={{ color: '#888' }}>初期描画: </span>
          <strong style={{ color: renderMs !== null ? '#4caf50' : '#888' }}>
            {renderMs !== null ? `${renderMs} ms` : '計測中…'}
          </strong>
        </div>
        <div>
          <span style={{ color: '#888' }}>スクロール FPS (avg/min): </span>
          <strong
            style={{
              color: avgFps
                ? avgFps >= 55
                  ? '#4caf50'
                  : avgFps >= 30
                    ? '#ff9800'
                    : '#f44336'
                : '#888',
            }}
          >
            {avgFps ? `${avgFps} / ${minFps}` : '未計測'}
          </strong>
        </div>
        <button
          type="button"
          onClick={measureFps}
          disabled={measuring}
          style={{
            padding: '4px 12px',
            cursor: measuring ? 'default' : 'pointer',
            background: '#333',
            color: '#eee',
            border: '1px solid #555',
            borderRadius: 4,
          }}
        >
          {measuring ? '計測中…' : 'FPS 計測開始'}
        </button>
      </div>

      {fpsLog.length > 0 && (
        <div style={{ fontSize: 11, color: '#888' }}>
          FPS ログ (直近30フレーム): {fpsLog.slice(-30).join(', ')}
        </div>
      )}

      <div style={{ flex: 1, overflow: 'hidden' }}>
        <VirtualList
          ref={listRef}
          items={items}
          renderItem={(item) => <Row item={item} />}
          getItemKey={(item) => item.id}
          height="100%"
          overscan={5}
          scrollRestorationKey={`bench-${scenarioKey}`}
        />
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById('root'));
root.render(
  <StrictMode>
    <Bench />
  </StrictMode>,
);
