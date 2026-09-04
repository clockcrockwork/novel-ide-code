// Storage adapter for zustand persist middleware that fans out a single
// store payload across multiple legacy localStorage keys, preserving
// backward compatibility with values written by the previous useLs-based
// AppContext.
import { scheduleWrite, cancelWrite } from '../lib/lsCache';

export function makeMultiKeyStorage(keyMap) {
  const fields = Object.keys(keyMap);
  return {
    getItem: () => {
      const state = {};
      let anyFound = false;
      for (const field of fields) {
        const lsKey = keyMap[field];
        try {
          const raw = localStorage.getItem(lsKey);
          if (raw !== null) {
            state[field] = JSON.parse(raw);
            anyFound = true;
          }
        } catch {
          // ignore
        }
      }
      if (!anyFound) return null;
      return JSON.stringify({ state, version: 0 });
    },
    setItem: (_name, value) => {
      let parsed;
      try {
        parsed = JSON.parse(value);
      } catch {
        return;
      }
      const state = parsed?.state ?? {};
      for (const field of fields) {
        const lsKey = keyMap[field];
        if (!(field in state)) continue;
        scheduleWrite(lsKey, state[field]);
      }
    },
    removeItem: () => {
      for (const field of fields) {
        const lsKey = keyMap[field];
        cancelWrite(lsKey);
        try {
          localStorage.removeItem(lsKey);
        } catch {
          /* ignore */
        }
      }
    },
  };
}
