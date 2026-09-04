import { create } from 'zustand';
import { dbGet, dbPut } from '../lib/db';
import { DEFAULT_RULES } from '../lib/writingRules';

const DEFAULT_TAGS = ['ミステリー', '現代日本'];

let hydratePromise = null;

// parseLegacyJson の「キーなし」と「キーあり・JSON壊れ」を区別するセンチネル
const KEY_EXISTS_PARSE_FAILED = Symbol('key_exists_parse_failed');

function cloneRules() {
  return DEFAULT_RULES.map((rule) => ({ ...rule }));
}

function normalizeRules(value) {
  if (!Array.isArray(value)) return cloneRules();
  const incoming = new Map(
    value
      .filter((v) => v && typeof v.id === 'string')
      .map((v) => [v.id, typeof v.enabled === 'boolean' ? v.enabled : false]),
  );
  return DEFAULT_RULES.map((rule) => ({ ...rule, enabled: incoming.get(rule.id) ?? rule.enabled }));
}

function normalizeTags(value) {
  if (!Array.isArray(value)) return [...DEFAULT_TAGS];
  const unique = [];
  for (const item of value) {
    const v = String(item ?? '').trim();
    if (!v || unique.includes(v)) continue;
    unique.push(v);
  }
  return unique;
}

function parseLegacyJson(key) {
  let raw;
  try {
    // eslint-disable-next-line no-restricted-globals -- 旧 localStorage キーからのマイグレーション読み取り
    raw = localStorage.getItem(key);
  } catch {
    return null; // localStorage 不可（SecurityError 等）→ キーなし扱い
  }
  if (raw === null) return null; // キーが存在しない
  try {
    return JSON.parse(raw);
  } catch {
    return KEY_EXISTS_PARSE_FAILED; // キーはあるが JSON が壊れている → DB は使わずデフォルトへ
  }
}

export const useWritingPrefsStore = create((set, get) => ({
  rules: cloneRules(),
  tags: [...DEFAULT_TAGS],
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;
    if (hydratePromise) return hydratePromise;

    hydratePromise = (async () => {
      let dbRules, dbTags;
      let dbReadFailed = false;
      try {
        [dbRules, dbTags] = await Promise.all([
          dbGet('settings', 'rules'),
          dbGet('settings', 'tags'),
        ]);
      } catch {
        // 一時的な IndexedDB 読み取りエラー — localStorage フォールバックで続行し dbPut はスキップ
        dbReadFailed = true;
      }

      const legacyRules = parseLegacyJson('ide_rules');
      const legacyTags = parseLegacyJson('ide_tags');

      // legacyが存在する間はlegacyを正として扱う（DBは移行前の古い値を含む可能性がある）
      // KEY_EXISTS_PARSE_FAILED: キーはあるが壊れている → デフォルト使用（DB 値は使わない）
      const rulesInput =
        legacyRules === null
          ? dbRules?.value
          : legacyRules === KEY_EXISTS_PARSE_FAILED
            ? null
            : legacyRules;
      const tagsInput =
        legacyTags === null
          ? dbTags?.value
          : legacyTags === KEY_EXISTS_PARSE_FAILED
            ? null
            : legacyTags;

      const nextRules = normalizeRules(rulesInput);
      const nextTags = normalizeTags(tagsInput);

      set({ rules: nextRules, tags: nextTags, hydrated: true });

      if (!dbReadFailed) {
        let migrated = false;
        try {
          await Promise.all([
            dbPut('settings', { key: 'rules', value: nextRules }),
            dbPut('settings', { key: 'tags', value: nextTags }),
          ]);
          migrated = true;
        } catch {}

        if (migrated) {
          /* eslint-disable no-restricted-globals -- マイグレーション完了後の旧キー削除 */
          try {
            localStorage.removeItem('ide_rules');
          } catch {}
          try {
            localStorage.removeItem('ide_tags');
          } catch {}
          /* eslint-enable no-restricted-globals */
        }
      }
    })();

    try {
      await hydratePromise;
    } finally {
      hydratePromise = null;
    }
  },

  toggleRule: async (id) => {
    await get().hydrate();
    const next = get().rules.map((rule) =>
      rule.id === id ? { ...rule, enabled: !rule.enabled } : rule,
    );
    set({ rules: next });
    await dbPut('settings', { key: 'rules', value: next }).catch(console.warn);
  },

  setTags: async (updater) => {
    await get().hydrate();
    const prev = get().tags;
    const raw = typeof updater === 'function' ? updater(prev) : updater;
    const next = normalizeTags(raw);
    set({ tags: next });
    await dbPut('settings', { key: 'tags', value: next }).catch(console.warn);
  },
}));
