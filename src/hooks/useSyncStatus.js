import { useState, useEffect } from 'react';
import { onSyncStatusChange, getSyncStatus } from '../lib/sync';

export function useSyncStatus() {
  const [status, setStatus] = useState(getSyncStatus);

  useEffect(() => onSyncStatusChange(setStatus), []);

  return status;
}
