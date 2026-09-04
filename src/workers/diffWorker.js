import { computeDiff } from '../lib/diffCore';

const toErrorMessage = (error) => {
  if (typeof error?.message === 'string') return error.message;
  if (typeof error === 'string') return error;
  return 'worker_error';
};

self.onmessage = (event) => {
  const { requestId, left, right, options } = event.data || {};
  if (!requestId) return;

  try {
    const result = computeDiff(left, right, options);
    self.postMessage({ requestId, ok: true, result });
  } catch (error) {
    self.postMessage({ requestId, ok: false, error: toErrorMessage(error) });
  }
};
