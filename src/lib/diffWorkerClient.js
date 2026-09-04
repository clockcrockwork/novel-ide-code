function sanitizeWorkerOptions(options) {
  const sanitized = {};
  for (const [key, value] of Object.entries(options || {})) {
    if (typeof value === 'function') continue;
    sanitized[key] = value;
  }
  return sanitized;
}

let workerInstance = null;
let workerAvailable = true;
let seq = 1;
const pending = new Map();

function disposeWorker(reason) {
  const worker = workerInstance;
  if (!worker) return;
  worker.onerror = null;
  worker.onmessage = null;
  worker.onmessageerror = null;
  worker.terminate();
  workerInstance = null;
  rejectAllPending(reason);
}

function cleanupRequest(requestId) {
  const task = pending.get(requestId);
  if (!task) return null;
  pending.delete(requestId);
  clearTimeout(task.timer);
  return task;
}

function rejectAllPending(reason) {
  const tasks = Array.from(pending.values());
  pending.clear();
  for (const task of tasks) {
    clearTimeout(task.timer);
    task.reject(new Error(reason));
  }
}

function getWorker() {
  if (!workerAvailable) throw new Error('worker_unavailable');
  if (workerInstance) return workerInstance;
  if (typeof Worker !== 'function') {
    workerAvailable = false;
    throw new Error('worker_unavailable');
  }

  let worker;
  try {
    worker = new Worker(new URL('../workers/diffWorker.js', import.meta.url), { type: 'module' });
  } catch (error) {
    workerAvailable = false;
    throw error;
  }

  worker.onmessage = (event) => {
    const { requestId, ok, result, error } = event.data || {};
    if (!requestId) return;

    const task = cleanupRequest(requestId);
    if (!task) return;

    if (ok) {
      task.resolve(result);
      return;
    }

    task.reject(new Error(error || 'worker_error'));
  };

  worker.onerror = () => disposeWorker('worker_crashed');
  worker.onmessageerror = () => disposeWorker('worker_message_error');

  workerInstance = worker;
  return workerInstance;
}

export function requestDiff(left, right, options = {}) {
  const timeoutMs = options.workerTimeoutMs ?? 30000;

  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = getWorker();
    } catch (error) {
      reject(error);
      return;
    }

    const requestId = seq++;
    const timer = setTimeout(() => {
      if (!pending.has(requestId)) return;
      disposeWorker('worker_timeout');
    }, timeoutMs);

    pending.set(requestId, { resolve, reject, timer });

    const workerOptions = sanitizeWorkerOptions(options);

    try {
      worker.postMessage({ requestId, left, right, options: workerOptions });
    } catch (error) {
      cleanupRequest(requestId);
      reject(error);
    }
  });
}
