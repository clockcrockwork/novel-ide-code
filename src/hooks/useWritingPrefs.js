import { useEffect } from 'react';
import { useWritingPrefsStore } from '../stores/writingPrefsStore';

export function useWritingPrefs() {
  const rules = useWritingPrefsStore((s) => s.rules);
  const tags = useWritingPrefsStore((s) => s.tags);
  const setTags = useWritingPrefsStore((s) => s.setTags);
  const toggleRule = useWritingPrefsStore((s) => s.toggleRule);
  const hydrated = useWritingPrefsStore((s) => s.hydrated);
  const hydrate = useWritingPrefsStore((s) => s.hydrate);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  return { rules, tags, setTags, toggleRule, hydrated };
}
