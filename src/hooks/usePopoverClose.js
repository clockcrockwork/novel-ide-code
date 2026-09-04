import { useEffect } from 'react';

export function usePopoverClose(onClose) {
  useEffect(() => {
    if (!onClose) return;
    window.addEventListener('resize', onClose);
    window.addEventListener('scroll', onClose, true);
    return () => {
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);
}
