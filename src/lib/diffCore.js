let requestWorkerDiffLoader;
let workerPathDisabled = false;

async function requestWorkerDiff(a, b, options) {
  if (workerPathDisabled) throw new Error('worker_path_disabled');
  requestWorkerDiffLoader ??= import('./diffWorkerClient.js')
    .then((mod) => mod.requestDiff)
    .catch((err) => {
      requestWorkerDiffLoader = undefined;
      throw err;
    });
  const requestDiff = await requestWorkerDiffLoader;
  return requestDiff(a, b, options);
}

function createDiffResult(rows, meta) {
  return { rows, meta };
}

function normalizeDiffResult(result) {
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  const meta =
    result?.meta && typeof result.meta === 'object'
      ? result.meta
      : { isFallback: true, reason: 'invalid' };
  return { rows, meta };
}

function getTraceX(trace, k) {
  if (!trace) return -1;
  if (k < trace.kMin || k > trace.kMax) return -1;
  return trace.values[k - trace.kMin];
}

function backtrackMyers(aL, bL, traces) {
  let x = aL.length;
  let y = bL.length;
  const result = [];

  for (let d = traces.length - 1; d > 0; d--) {
    const prevTrace = traces[d - 1];
    const k = x - y;
    const left = getTraceX(prevTrace, k - 1);
    const down = getTraceX(prevTrace, k + 1);
    const canGoDown = k === -d || (k !== d && left < down);
    const prevK = canGoDown ? k + 1 : k - 1;
    const prevX = getTraceX(prevTrace, prevK);
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      result.push({ type: 'same', text: aL[x - 1] });
      x--;
      y--;
    }

    if (x === prevX) {
      result.push({ type: 'added', text: bL[prevY] });
      y--;
    } else {
      result.push({ type: 'removed', text: aL[prevX] });
      x--;
    }
  }

  while (x > 0 && y > 0) {
    result.push({ type: 'same', text: aL[x - 1] });
    x--;
    y--;
  }
  while (x > 0) {
    result.push({ type: 'removed', text: aL[x - 1] });
    x--;
  }
  while (y > 0) {
    result.push({ type: 'added', text: bL[y - 1] });
    y--;
  }

  return result.reverse();
}

// Returns step > 0 (advance A by step/removed), step < 0 (advance B by -step/added), or 0 (no match).
// Numeric return avoids object allocation in the fallback loop.
function findLookaheadMatch(aL, bL, i, j, LOOKAHEAD) {
  for (let step = 1; step <= LOOKAHEAD; step++) {
    if (i + step < aL.length && aL[i + step] === bL[j]) return step;
    if (j + step < bL.length && bL[j + step] === aL[i]) return -step;
  }
  return 0;
}

function coarseFallback(aL, bL) {
  const result = [];
  const LOOKAHEAD = 24;
  let i = 0;
  let j = 0;

  while (i < aL.length || j < bL.length) {
    const left = aL[i];
    const right = bL[j];

    if (left == null) {
      result.push({ type: 'added', text: right });
      j++;
      continue;
    }
    if (right == null) {
      result.push({ type: 'removed', text: left });
      i++;
      continue;
    }
    if (left === right) {
      result.push({ type: 'same', text: left });
      i++;
      j++;
      continue;
    }

    const match = findLookaheadMatch(aL, bL, i, j, LOOKAHEAD);
    if (match > 0) {
      for (let k = 0; k < match; k++) result.push({ type: 'removed', text: aL[i + k] });
      i += match;
    } else if (match < 0) {
      const step = -match;
      for (let k = 0; k < step; k++) result.push({ type: 'added', text: bL[j + k] });
      j += step;
    } else {
      result.push({ type: 'removed', text: left });
      result.push({ type: 'added', text: right });
      i++;
      j++;
    }
  }

  return result;
}

// Cache API availability at module load to avoid repeated optional-chain checks in the hot path
const nowMs =
  typeof globalThis.performance?.now === 'function'
    ? () => globalThis.performance.now()
    : () => Date.now();

// Compute x endpoint for diagonal k at step d. Returns x (>= 0) on success, -1 on timeout.
// Caller derives y = x - k. x is always >= 0 so -1 is a safe sentinel.
function computeKLine(k, d, prevTrace, aL, bL, N, M, startedAt, maxTimeMs) {
  let x;
  const xPlus = getTraceX(prevTrace, k + 1);
  if (k === -d) {
    x = xPlus;
  } else {
    const xMinus = getTraceX(prevTrace, k - 1);
    x = k !== d && xMinus < xPlus ? xPlus : xMinus + 1;
  }
  if (x < 0) x = 0;
  let y = x - k;

  let snakeSteps = 0;
  while (x < N && y < M && aL[x] === bL[y]) {
    if ((snakeSteps & 127) === 127 && nowMs() - startedAt > maxTimeMs) {
      // 128ステップに1回だけ nowMs() を呼ぶ
      return -1;
    }
    snakeSteps++;
    x++;
    y++;
  }
  return x;
}

export function computeDiff(a, b, options = {}) {
  const left = typeof a === 'string' ? a : String(a ?? '');
  const right = typeof b === 'string' ? b : String(b ?? '');
  const aL = left.split('\n');
  const bL = right.split('\n');
  const maxEditDistance = options.maxEditDistance ?? 5000;
  const maxTimeMs = options.maxTimeMs ?? 64; // 64ms ≈ 4フレーム (60fps)。Worker内なので 16ms より緩め
  const startedAt = nowMs();

  const N = aL.length;
  const M = bL.length;
  const max = N + M;
  const traces = [];
  let prevTrace = { d: -1, kMin: 1, kMax: 1, values: new Int32Array([0]) };

  for (let d = 0; d <= max; d++) {
    if (d > maxEditDistance || nowMs() - startedAt > maxTimeMs) {
      return createDiffResult(coarseFallback(aL, bL), { isFallback: true, reason: 'limit' });
    }

    const kMin = -d;
    const kMax = d;
    const values = new Int32Array(kMax - kMin + 1);

    for (let k = kMin; k <= kMax; k += 2) {
      const x = computeKLine(k, d, prevTrace, aL, bL, N, M, startedAt, maxTimeMs);
      if (x === -1)
        return createDiffResult(coarseFallback(aL, bL), { isFallback: true, reason: 'limit' });
      const y = x - k;

      values[k - kMin] = x;
      if (x >= N && y >= M) {
        const doneTrace = { d, kMin, kMax, values };
        traces.push(doneTrace);
        return createDiffResult(backtrackMyers(aL, bL, traces), { isFallback: false });
      }
    }

    prevTrace = { d, kMin, kMax, values };
    traces.push(prevTrace);
  }

  return createDiffResult(coarseFallback(aL, bL), { isFallback: true, reason: 'exhausted' });
}

export async function computeDiffAsync(a, b, options = {}) {
  const tryMainThread = () =>
    new Promise((resolve, reject) => {
      setTimeout(() => {
        try {
          resolve(normalizeDiffResult(computeDiff(a, b, options)));
        } catch (err) {
          reject(err);
        }
      }, 0);
    });

  if (typeof options.workerDiff === 'function') {
    try {
      return normalizeDiffResult(await options.workerDiff(a, b, options));
    } catch {
      // fallback to next path
    }
  }

  const { workerDiff: _workerDiff, ...workerOptions } = options;

  try {
    return normalizeDiffResult(await requestWorkerDiff(a, b, workerOptions));
  } catch (error) {
    if (error?.message === 'worker_unavailable') workerPathDisabled = true;
    return tryMainThread();
  }
}

export { normalizeDiffResult, createDiffResult, coarseFallback, backtrackMyers };
