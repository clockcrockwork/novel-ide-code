import { useState, useId } from 'react';

export default function ModuleWrapper({
  title,
  icon,
  children,
  defaultOpen = false,
  keepMounted = false,
  loading = false,
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const shouldRenderBody = open || keepMounted;

  return (
    <div className="mod">
      <button
        type="button"
        className={`mod-header${open ? ' open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={bodyId}
      >
        <span className="mod-title">
          {icon && <span style={{ marginRight: 5, opacity: 0.6 }}>{icon}</span>}
          {title}
        </span>
        <span
          style={{
            color: 'var(--tx3)',
            fontSize: 9,
            display: 'inline-block',
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform .15s',
          }}
        >
          ▼
        </span>
      </button>
      <div id={bodyId} className="mod-body" style={{ display: open ? undefined : 'none' }}>
        {shouldRenderBody && (
          <>
            {loading && (
              <div aria-hidden="true">
                <div className="skeleton-line" style={{ width: '80%' }} />
                <div className="skeleton-line" style={{ width: '60%' }} />
                <div className="skeleton-line" style={{ width: '72%' }} />
              </div>
            )}
            <div style={{ display: loading ? 'none' : 'block' }}>{children}</div>
          </>
        )}
      </div>
    </div>
  );
}
