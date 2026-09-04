import { useState, useEffect } from 'react';
import { onSaveStatusChange, getSaveStatus } from '../lib/saveStatus';

export function useSaveStatus() {
  const [status, setStatus] = useState(getSaveStatus);

  useEffect(() => onSaveStatusChange(setStatus), []);

  return status;
}
