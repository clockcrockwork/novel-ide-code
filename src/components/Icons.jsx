export function GhIcon({ s = 16 }) {
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.2 11.38.6.1.82-.26.82-.57v-2c-3.34.72-4.04-1.61-4.04-1.61-.54-1.38-1.33-1.75-1.33-1.75-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.8 1.3 3.49 1 .1-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 016 0c2.28-1.55 3.29-1.23 3.29-1.23.66 1.66.25 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.8 5.63-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.22.68.82.57C20.57 21.8 24 17.3 24 12 24 5.37 18.63 0 12 0z" />
    </svg>
  );
}

export function MenuIcon() {
  return (
    <svg
      width="16"
      height="12"
      viewBox="0 0 16 12"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <rect y="0" width="16" height="1.6" rx=".8" />
      <rect y="5.2" width="11" height="1.6" rx=".8" />
      <rect y="10.4" width="14" height="1.6" rx=".8" />
    </svg>
  );
}

export function FileIcon({ s = 11 }) {
  return (
    <svg
      width={s}
      height={(s * 13) / 11}
      viewBox="0 0 11 13"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M0 1a1 1 0 011-1h6l4 4v8a1 1 0 01-1 1H1a1 1 0 01-1-1V1z" />
      <path d="M7 0v4h4" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

export function GearIcon({ s = 14 }) {
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 512 512"
      fill="currentColor"
      fillRule="evenodd"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m499.5 210-55.9-2.6c-5.1-.2-9.6-3.4-11.5-8l-11.6-27.8c-1.9-4.7-1-10.1 2.5-13.9l37.7-41.3a13 13 0 0 0-.4-18.2l-46.5-46.4c-5-5-13-5.2-18.2-.5L354.3 89a13 13 0 0 1-14 2.4L312.8 80c-4.7-2-7.9-6.5-8.1-11.6L302 12.6c-.3-7-6.1-12.6-13.1-12.6h-65.7c-7 0-12.9 5.5-13.2 12.6l-2.6 55.8c-.2 5.1-3.3 9.6-8 11.6l-27.8 11.4c-4.7 2-10.1 1-13.9-2.4l-41.3-37.7a13 13 0 0 0-18.2.5L51.8 98.2c-5 5-5.2 13-.5 18.2L89 157.7c3.5 3.8 4.4 9.2 2.4 14L80 199.2c-2 4.7-6.5 7.9-11.6 8.1L12.6 210c-7 .3-12.6 6.1-12.6 13.2v65.7c0 7 5.5 12.8 12.6 13.1l55.8 2.6c5.1.2 9.6 3.4 11.6 8l11.4 27.8c2 4.7 1 10.1-2.4 13.9l-37.7 41.3a13 13 0 0 0 .4 18.2l46.5 46.4c5 5 13 5.2 18.2.5l41.3-37.7c3.8-3.5 9.2-4.4 14-2.4l27.6 11.4c4.8 2 7.9 6.5 8.1 11.6l2.6 55.8c.3 7 6.1 12.6 13.2 12.6h65.7c7 0 12.8-5.5 13.1-12.6l2.6-55.8c.2-5.1 3.4-9.6 8-11.6l27.8-11.4c4.7-2 10.1-1 13.9 2.4l41.3 37.7a13 13 0 0 0 18.2-.5l46.4-46.4c5-5 5.2-13 .5-18.2L423 354.3a13 13 0 0 1-2.5-14l11.6-27.6c1.9-4.7 6.4-7.9 11.5-8.1l55.9-2.6c7-.3 12.5-6.1 12.5-13.2v-65.7c0-7-5.5-12.8-12.5-13.1zM256 339.6a83.6 83.6 0 1 1 0-167.2 83.6 83.6 0 0 1 0 167.2z" />
    </svg>
  );
}

export function ExportIcon({ s = 14 }) {
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M7 1v8M4 6l3 3 3-3M2 10v2a1 1 0 001 1h8a1 1 0 001-1v-2" />
    </svg>
  );
}

export function SyncIcon({ s = 14 }) {
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}

export function ChevronRight({ s = 10 }) {
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
      focusable="false"
      style={{ opacity: 0.3, flexShrink: 0 }}
    >
      <path d="M2 5h6M5 2l3 3-3 3" />
    </svg>
  );
}
