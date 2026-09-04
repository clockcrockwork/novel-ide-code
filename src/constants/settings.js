import { DEFAULT_POMODORO_NOTIFICATION } from '../lib/pomodoroNotification';
import { DEFAULT_FLOWTIME_NOTIFICATION } from '../lib/flowtimeNotification';
import { DEFAULT_SYNC_NOTIFICATION } from '../lib/syncNotification';
import { DEFAULT_DEADLINE_NOTIFICATION } from '../lib/deadlineNotification';

export const DEFAULT_SETTINGS = {
  write: {
    font: 'noto-serif',
    fontSize: 16,
    lineHeight: 2,
    letterSpacing: 5,
    width: 680,
  },
  preview: {
    font: 'noto-serif',
    fontSize: 17,
    lineHeight: 2.2,
    letterSpacing: 3,
  },
  github: { commitMessage: '原稿を更新' },
  notifications: {
    pomodoro: DEFAULT_POMODORO_NOTIFICATION,
    flowtime: DEFAULT_FLOWTIME_NOTIFICATION,
    sync: DEFAULT_SYNC_NOTIFICATION,
    deadline: DEFAULT_DEADLINE_NOTIFICATION,
  },
  replacementProfiles: {
    // sites: { id, name, rubyFormat?: 'none'|'kakuyomu'|'pixiv'|'novelup'|'custom', customRuby?: string }[]
    sites: [],
    // rows: { id, original, patterns: { [siteId]: string } }[]
    rows: [],
  },
};
