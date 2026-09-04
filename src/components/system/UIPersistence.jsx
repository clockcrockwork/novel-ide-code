import { useEffect } from 'react';
import { useUIStore } from '../../stores/uiStore';
import { dbPut } from '../../lib/db';

// Mounted once near the root. Mirrors persisted UI preferences into IndexedDB
// (matching the previous AppContext behavior) and applies DOM side effects
// for theme.
export default function UIPersistence() {
  const theme = useUIStore((s) => s.theme);
  const sidebarSide = useUIStore((s) => s.sidebarSide);
  const showLineNumbers = useUIStore((s) => s.showLineNumbers);
  const colors = useUIStore((s) => s.colors);
  const splitSwapped = useUIStore((s) => s.splitSwapped);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    dbPut('settings', { key: 'theme', value: theme }).catch(console.warn);
  }, [theme]);
  useEffect(() => {
    dbPut('settings', { key: 'sidebarSide', value: sidebarSide }).catch(console.warn);
  }, [sidebarSide]);
  useEffect(() => {
    dbPut('settings', { key: 'showLineNumbers', value: showLineNumbers }).catch(console.warn);
  }, [showLineNumbers]);
  useEffect(() => {
    dbPut('settings', { key: 'colors', value: colors }).catch(console.warn);
  }, [colors]);
  useEffect(() => {
    dbPut('meta', { key: 'splitSwapped', value: splitSwapped }).catch(console.warn);
  }, [splitSwapped]);

  return null;
}
