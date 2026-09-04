const LOCAL_DEFAULT_TITLE = '小説IDE';
const LOCAL_DEFAULT_TAG_PREFIX = 'pomodoro';

const toSafeText = (value, fallback) => {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, 120);
};

const safePermission = () => {
  if (typeof Notification === 'undefined') return 'denied';
  return Notification.permission;
};

const logDebug = (...args) => {
  if (import.meta.env.DEV) console.debug(...args);
};

export async function ensureNotificationPermission() {
  if (typeof Notification === 'undefined') return false;
  const current = safePermission();
  if (current === 'granted') return true;
  if (current === 'denied') return false;
  if (typeof Notification.requestPermission !== 'function') return false;
  try {
    const result = await Notification.requestPermission();
    return result === 'granted';
  } catch (error) {
    logDebug('[notify] requestPermission failed', error);
    return false;
  }
}

export function checkNotificationPermission() {
  return safePermission() === 'granted';
}

export function createLocalPomodoroNotifier({ onNotifyClick } = {}) {
  const handleClick = () => {
    try {
      window.focus?.();
    } catch {}
    try {
      onNotifyClick?.();
    } catch (error) {
      logDebug('[notify] onNotifyClick failed', error);
    }
  };

  return async function sendLocalPomodoro(event, payload = {}) {
    try {
      if (typeof window === 'undefined' || typeof Notification === 'undefined') return false;
      const granted = await ensureNotificationPermission();
      if (!granted) return false;

      const title = toSafeText(payload.title, LOCAL_DEFAULT_TITLE);
      const body = toSafeText(payload.body, event);
      const tag = toSafeText(payload.tag, `${LOCAL_DEFAULT_TAG_PREFIX}-${event}`);
      const notification = new Notification(title, { body, tag });
      notification.onclick = handleClick;
      return true;
    } catch (error) {
      logDebug('[notify] local notification failed', error);
      return false;
    }
  };
}

export function createNotifier({
  localSender,
  toastSender,
  remoteSender = async () => false,
  logger = null,
} = {}) {
  return async function notify(module, event, payload = {}) {
    const delivery = payload.delivery || 'local';
    logger?.('[notify]', { module, event, delivery });

    if (delivery === 'toast') return toastSender ? toastSender(payload) : false;
    if (delivery === 'browser' || delivery === 'local')
      return localSender ? localSender(event, payload) : false;
    if (delivery === 'remote') return remoteSender(module, event, payload);
    return false;
  };
}
