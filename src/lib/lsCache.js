const DEBOUNCE_MS = 300;
const pending = new Map(); // key → raw value (JSON.stringify deferred to flush)
let timer = null;

function flush() {
  clearTimeout(timer);
  timer = null;
  for (const [k, v] of pending) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* quota etc. */
    }
  }
  pending.clear();
}

function onVisibilityChange() {
  if (document.visibilityState === 'hidden') flush();
}

export function scheduleWrite(key, value) {
  pending.set(key, value);
  clearTimeout(timer);
  timer = setTimeout(flush, DEBOUNCE_MS);
}

export function getStorage(key, fallback) {
  if (pending.has(key)) return pending.get(key);
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function cancelWrite(key) {
  pending.delete(key);
  if (pending.size === 0 && timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

// prefix で始まる pending 書き込みをまとめて破棄する（clearLocalData.js が localStorage
// キー削除の直前に呼ぶ）。破棄せずに削除だけ行うと、その後の beforeunload/pagehide で
// flush() が走り、削除したはずのキーが古い値のまま書き戻ってしまう。
export function cancelWritesByPrefix(prefix) {
  for (const key of Array.from(pending.keys())) {
    if (key.startsWith(prefix)) cancelWrite(key);
  }
}

window.addEventListener('beforeunload', flush);
window.addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', onVisibilityChange);

// Vite HMR: flush pending writes then clean up listeners to prevent duplicates
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    flush();
    window.removeEventListener('beforeunload', flush);
    window.removeEventListener('pagehide', flush);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  });
}
