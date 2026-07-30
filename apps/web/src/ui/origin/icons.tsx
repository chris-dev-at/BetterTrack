import type { ReactNode, SVGProps } from 'react';

/**
 * Origin stroke icon set (REAL_APP_REDESIGN_PROMPT.md): minimal 24×24 line
 * glyphs, 1.6px stroke, round caps — quiet enough to sit inside 34px controls
 * and the navigation rail. Drawn in-house so the GUI ships no icon dependency.
 */
const PATHS: Record<string, ReactNode> = {
  home: (
    <>
      <path d="M4 10.5 12 4l8 6.5" />
      <path d="M6 9.5V20h12V9.5" />
      <path d="M10 20v-5h4v5" />
    </>
  ),
  portfolios: (
    <>
      <rect x="4" y="7.5" width="16" height="12" rx="1.5" />
      <path d="M8 7.5V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v1.5" />
      <path d="M4 12.5h16" />
    </>
  ),
  workbench: (
    <>
      <path d="M5 7h14" />
      <path d="M5 12h14" />
      <path d="M5 17h14" />
      <circle cx="9" cy="7" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="15" cy="12" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="7.5" cy="17" r="1.7" fill="currentColor" stroke="none" />
    </>
  ),
  assets: (
    <>
      <path d="M4 19V5" />
      <path d="M4 19h16" />
      <path d="m6.5 14.5 3.5-4 3 2.5 4.5-6" />
    </>
  ),
  people: (
    <>
      <circle cx="9" cy="8.5" r="3" />
      <path d="M3.8 19c.6-3 2.6-4.5 5.2-4.5s4.6 1.5 5.2 4.5" />
      <path d="M15.5 5.9a3 3 0 0 1 0 5.2" />
      <path d="M16.6 14.8c2 .5 3.2 1.9 3.6 4.2" />
    </>
  ),
  sparkles: (
    <>
      <path d="M11 4.5 12.6 9l4.4 1.6-4.4 1.6L11 16.5l-1.6-4.3-4.4-1.6L9.4 9Z" />
      <path d="m17.8 14.6.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7Z" />
    </>
  ),
  inbox: (
    <>
      <path d="M4 13.5V17a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3.5" />
      <path d="M4 13.5 6.2 6a1.5 1.5 0 0 1 1.4-1h8.8a1.5 1.5 0 0 1 1.4 1l2.2 7.5" />
      <path d="M4 13.5h4.5l1.2 2h4.6l1.2-2H20" />
    </>
  ),
  grid: (
    <>
      <rect x="4.5" y="4.5" width="6" height="6" rx="1" />
      <rect x="13.5" y="4.5" width="6" height="6" rx="1" />
      <rect x="4.5" y="13.5" width="6" height="6" rx="1" />
      <rect x="13.5" y="13.5" width="6" height="6" rx="1" />
    </>
  ),
  link: (
    <>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.6l-1.2 1.2" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.6l1.2-1.2" />
    </>
  ),
  search: (
    <>
      <circle cx="10.8" cy="10.8" r="5.8" />
      <path d="m15.3 15.3 4.2 4.2" />
    </>
  ),
  bell: (
    <>
      <path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2.5H4.5Z" />
      <path d="M10 19a2 2 0 0 0 4 0" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  minus: <path d="M5 12h14" />,
  x: (
    <>
      <path d="m6 6 12 12" />
      <path d="M18 6 6 18" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  'chevron-down': <path d="m6 9.5 6 6 6-6" />,
  'chevron-up': <path d="m6 14.5 6-6 6 6" />,
  'chevron-right': <path d="m9.5 6 6 6-6 6" />,
  'chevron-left': <path d="m14.5 6-6 6 6 6" />,
  'arrow-right': (
    <>
      <path d="M4.5 12h15" />
      <path d="m13.5 6 6 6-6 6" />
    </>
  ),
  'arrow-left': (
    <>
      <path d="M19.5 12h-15" />
      <path d="m10.5 6-6 6 6 6" />
    </>
  ),
  'arrow-up-right': (
    <>
      <path d="M7 17 17 7" />
      <path d="M9 7h8v8" />
    </>
  ),
  eye: (
    <>
      <path d="M3.5 12S6.5 6.5 12 6.5 20.5 12 20.5 12 17.5 17.5 12 17.5 3.5 12 3.5 12Z" />
      <circle cx="12" cy="12" r="2.6" />
    </>
  ),
  'eye-off': (
    <>
      <path d="M5.5 8.2A13 13 0 0 0 3.5 12s3 5.5 8.5 5.5a8.8 8.8 0 0 0 3.7-.8" />
      <path d="M9.2 6.9A8.7 8.7 0 0 1 12 6.5c5.5 0 8.5 5.5 8.5 5.5a13.4 13.4 0 0 1-2.1 2.9" />
      <path d="M10.2 10.2a2.6 2.6 0 0 0 3.6 3.6" />
      <path d="m5 5 14 14" />
    </>
  ),
  sliders: (
    <>
      <path d="M6.5 5v6" />
      <path d="M6.5 15v4" />
      <path d="M12 5v2" />
      <path d="M12 11v8" />
      <path d="M17.5 5v8" />
      <path d="M17.5 17v2" />
      <circle cx="6.5" cy="13" r="2" />
      <circle cx="12" cy="9" r="2" />
      <circle cx="17.5" cy="15" r="2" />
    </>
  ),
  calendar: (
    <>
      <rect x="4.5" y="6" width="15" height="13.5" rx="1.5" />
      <path d="M4.5 10.5h15" />
      <path d="M8.5 4v3.5" />
      <path d="M15.5 4v3.5" />
    </>
  ),
  document: (
    <>
      <path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20Z" />
      <path d="M14 3.5V8h4.5" />
      <path d="M9.5 12.5h5" />
      <path d="M9.5 16h5" />
    </>
  ),
  files: (
    <>
      <path d="M5 8.5V19a1.5 1.5 0 0 0 1.5 1.5H16" />
      <path d="M8.5 4h5.6l4.4 4.4V16a1.5 1.5 0 0 1-1.5 1.5H8.5A1.5 1.5 0 0 1 7 16V5.5A1.5 1.5 0 0 1 8.5 4Z" />
    </>
  ),
  upload: (
    <>
      <path d="M12 15V4.5" />
      <path d="m7.5 9 4.5-4.5L16.5 9" />
      <path d="M5 15v3.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15" />
    </>
  ),
  download: (
    <>
      <path d="M12 4.5V15" />
      <path d="m7.5 11 4.5 4.5L16.5 11" />
      <path d="M5 16v2.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V16" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3.5 19 6v5.5c0 4.6-3 7.7-7 9-4-1.3-7-4.4-7-9V6Z" />
      <path d="m9 11.8 2.2 2.2L15.5 9.5" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="14.5" r="3.8" />
      <path d="m11 11.5 8.5-8.5" />
      <path d="M16 7l2.5 2.5" />
      <path d="m13.5 9.5 2 2" />
    </>
  ),
  wallet: (
    <>
      <path d="M4 7.5A1.5 1.5 0 0 1 5.5 6H17v2" />
      <rect x="4" y="8" width="16" height="11" rx="1.5" />
      <path d="M15.5 13.5H20" />
      <circle cx="15.7" cy="13.5" r="0.4" fill="currentColor" stroke="none" />
    </>
  ),
  cash: (
    <>
      <rect x="3.5" y="7" width="17" height="10.5" rx="1.5" />
      <circle cx="12" cy="12.2" r="2.6" />
      <path d="M6.3 9.8v.01" />
      <path d="M17.7 14.6v.01" />
    </>
  ),
  percent: (
    <>
      <path d="M18.5 5.5l-13 13" />
      <circle cx="7.5" cy="7.5" r="2.5" />
      <circle cx="16.5" cy="16.5" r="2.5" />
    </>
  ),
  bolt: <path d="M13 3.5 5.5 13H11l-.8 7.5L18.5 11H13Z" />,
  pulse: <path d="M3.5 12.5H7l2.5-6 4.5 11 2.5-5h4" />,
  scale: (
    <>
      <path d="M12 4.5v15" />
      <path d="M7 6.5h10" />
      <path d="M7 6.5 4.5 12a2.8 2.8 0 0 0 5.4 0Z" />
      <path d="M17 6.5 14.5 12a2.8 2.8 0 0 0 5.4 0Z" />
      <path d="M9 19.5h6" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="7.5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="0.8" fill="currentColor" stroke="none" />
    </>
  ),
  lock: (
    <>
      <rect x="6" y="10.5" width="12" height="9" rx="1.5" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
      <path d="M12 14v2.5" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M4 12h16" />
      <path d="M12 4a12.6 12.6 0 0 1 0 16 12.6 12.6 0 0 1 0-16Z" />
    </>
  ),
  refresh: (
    <>
      <path d="M19 12a7 7 0 1 1-2.05-4.95" />
      <path d="M19 3.5V7h-3.5" />
    </>
  ),
  trash: (
    <>
      <path d="M5 7h14" />
      <path d="M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7" />
      <path d="M6.5 7 7.5 19a1.5 1.5 0 0 0 1.5 1.4h6A1.5 1.5 0 0 0 16.5 19l1-12" />
      <path d="M10 11v5.5" />
      <path d="M14 11v5.5" />
    </>
  ),
  pen: (
    <>
      <path d="m14.5 5.5 4 4L8 20H4v-4Z" />
      <path d="m12.5 7.5 4 4" />
    </>
  ),
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  star: <path d="m12 4.5 2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L4.8 9.8l5-.7Z" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  filter: <path d="M4.5 6h15l-6 7v5.5l-3-1.5V13Z" />,
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="1.5" />
      <path d="M5.5 15.5H4.5v-10a1 1 0 0 1 1-1h10v1" />
    </>
  ),
  code: (
    <>
      <path d="m8.5 8-4.5 4 4.5 4" />
      <path d="m15.5 8 4.5 4-4.5 4" />
    </>
  ),
  webhook: (
    <>
      <circle cx="6.5" cy="17" r="2.8" />
      <circle cx="17.5" cy="17" r="2.8" />
      <circle cx="12" cy="7" r="2.8" />
      <path d="M10.6 9.4 7.5 14.4" />
      <path d="m13.4 9.4 3.1 5" />
      <path d="M9.3 17h5.4" />
    </>
  ),
  terminal: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="1.5" />
      <path d="m7 9.5 3 2.5-3 2.5" />
      <path d="M12.5 14.5H17" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="2.8" />
      <path d="M5 6v12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8V6" />
      <path d="M5 12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8" />
    </>
  ),
  cloud: <path d="M7 18.5a4 4 0 0 1-.6-8A5.5 5.5 0 0 1 17 8.6a4.5 4.5 0 0 1 .5 8.9Z" />,
  printer: (
    <>
      <path d="M7 9V4.5h10V9" />
      <rect x="4" y="9" width="16" height="7.5" rx="1.5" />
      <path d="M7 14h10v5.5H7Z" />
    </>
  ),
  logout: (
    <>
      <path d="M14 4.5H6.5A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5H14" />
      <path d="M10 12h9.5" />
      <path d="m16 8.5 3.5 3.5-3.5 3.5" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5.5 19.5c.8-3.4 3.3-5 6.5-5s5.7 1.6 6.5 5" />
    </>
  ),
  message: <path d="M4.5 5.5h15v10.5h-9L6 20v-4H4.5Z" />,
  warning: (
    <>
      <path d="M12 4 3.5 19h17Z" />
      <path d="M12 10v4" />
      <circle cx="12" cy="16.6" r="0.5" fill="currentColor" stroke="none" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 11v5" />
      <circle cx="12" cy="8" r="0.6" fill="currentColor" stroke="none" />
    </>
  ),
  mail: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />
      <path d="m4.5 7.5 7.5 5.5 7.5-5.5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="2.8" />
      <path d="M12 3.8 13 6a6.3 6.3 0 0 1 2.4 1l2.3-.8 1.6 2.7-1.7 1.7a6.3 6.3 0 0 1 0 2.8l1.7 1.7-1.6 2.7-2.3-.8a6.3 6.3 0 0 1-2.4 1l-1 2.3-1-2.3a6.3 6.3 0 0 1-2.4-1l-2.3.8-1.6-2.7 1.7-1.7a6.3 6.3 0 0 1 0-2.8L5.1 8.9l1.6-2.7 2.3.8a6.3 6.3 0 0 1 2.4-1Z" />
    </>
  ),
  share: (
    <>
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="17.5" cy="6" r="2.5" />
      <circle cx="17.5" cy="18" r="2.5" />
      <path d="m8.3 10.8 7-3.6" />
      <path d="m8.3 13.2 7 3.6" />
    </>
  ),
  'trending-up': (
    <>
      <path d="m3.5 17 5.5-5.5 3.5 3.5 7.5-8" />
      <path d="M15 7h5v5" />
    </>
  ),
  'trending-down': (
    <>
      <path d="m3.5 7 5.5 5.5L12.5 9l7.5 8" />
      <path d="M15 17h5v-5" />
    </>
  ),
  layers: (
    <>
      <path d="M12 3.5 20 8l-8 4.5L4 8Z" />
      <path d="m4 12.5 8 4.5 8-4.5" />
      <path d="m4 16.5 8 4.5 8-4.5" transform="translate(0 -0.5)" />
    </>
  ),
  pie: (
    <>
      <path d="M12 4a8 8 0 1 0 8 8h-8Z" />
      <path d="M14.5 3.9A8 8 0 0 1 20.1 9.5H14.5Z" />
    </>
  ),
  play: <path d="M8 5.5v13l10-6.5Z" />,
  book: (
    <>
      <path d="M5 5.5A1.5 1.5 0 0 1 6.5 4H19v14.5H6.8A1.8 1.8 0 0 0 5 20.3Z" />
      <path d="M19 18.5H6.8A1.8 1.8 0 0 0 5 20.3" />
    </>
  ),
  fork: (
    <>
      <circle cx="7" cy="6" r="2.2" />
      <circle cx="17" cy="6" r="2.2" />
      <circle cx="12" cy="18" r="2.2" />
      <path d="M7 8.2V10a3 3 0 0 0 3 3h4a3 3 0 0 0 3-3V8.2" />
      <path d="M12 13v2.8" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="3.6" />
      <path d="M12 3.5V5M12 19v1.5M3.5 12H5m14 0h1.5M6 6l1.1 1.1M16.9 16.9 18 18M6 18l1.1-1.1M16.9 7.1 18 6" />
    </>
  ),
  moon: <path d="M19.5 13.5A7.5 7.5 0 1 1 10.5 4.5a6 6 0 0 0 9 9Z" />,
  drag: (
    <>
      <circle cx="9" cy="6.5" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="15" cy="6.5" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="9" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="15" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="9" cy="17.5" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="15" cy="17.5" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  menu: (
    <>
      <path d="M4.5 7h15" />
      <path d="M4.5 12h15" />
      <path d="M4.5 17h15" />
    </>
  ),
  collapse: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
      <path d="M9.5 4.5v15" />
      <path d="m14.5 10-2 2 2 2" />
    </>
  ),
  // ── Portfolio kinds (R2) — one glyph per `portfolioKinds.ts` kind, plus the
  // group (MIRRORCHAIN) trio. Appended at the end on purpose: new entries never
  // shift the existing map, keeping parallel branches merge-clean.
  'user-lock': (
    <>
      <circle cx="10" cy="8" r="3.2" />
      <path d="M4.2 19.2c.7-3.1 3-4.7 5.8-4.7.6 0 1.2.1 1.8.2" />
      <rect x="13.5" y="15" width="7" height="5.5" rx="1" />
      <path d="M15.3 15v-1.4a1.7 1.7 0 0 1 3.4 0V15" />
    </>
  ),
  family: (
    <>
      <circle cx="7.8" cy="7" r="2.7" />
      <path d="M3.4 19c.5-3.2 2.2-4.9 4.4-4.9s3.9 1.7 4.4 4.9" />
      <circle cx="16.6" cy="10.8" r="2.1" />
      <path d="M13.3 19c.4-2.5 1.6-3.8 3.3-3.8s2.9 1.3 3.3 3.8" />
    </>
  ),
  briefcase: (
    <>
      <rect x="3.5" y="7.5" width="17" height="11.5" rx="1.5" />
      <path d="M8.5 7.5V6A1.5 1.5 0 0 1 10 4.5h4A1.5 1.5 0 0 1 15.5 6v1.5" />
      <path d="M3.5 12.5h17" />
      <path d="M10.5 12.5v1.6h3v-1.6" />
    </>
  ),
  'piggy-bank': (
    <>
      <path d="M4.5 13.8a6.3 6.3 0 0 1 6.3-6.3h2.6a6.3 6.3 0 0 1 5.8 3.9h1.6a.8.8 0 0 1 .8.8v2a.8.8 0 0 1-.8.8h-1.5a6.3 6.3 0 0 1-2 2.4V20h-2.8v-1.2h-3.6V20H7.9v-2.3a6.3 6.3 0 0 1-3.4-3.9Z" />
      <path d="M10.8 7.6 9.4 4.8a4.3 4.3 0 0 0-2.5 3.1" />
      <path d="M13.4 11.2h2.9" />
      <circle cx="9" cy="13" r="0.6" fill="currentColor" stroke="none" />
    </>
  ),
  building: (
    <>
      <path d="M4.5 20V6.3a1 1 0 0 1 .7-1l7-2.1a1 1 0 0 1 1.3 1V20" />
      <path d="M13.5 9.5h4.8a1 1 0 0 1 1 1V20" />
      <path d="M3 20h18" />
      <path d="M7.6 8.4h2.4M7.6 11.9h2.4M7.6 15.4h2.4" />
      <path d="M15.2 13h1.6M15.2 16.5h1.6" />
    </>
  ),
  users: (
    <>
      <circle cx="12" cy="8.2" r="2.7" />
      <path d="M7.9 18.8c.5-2.9 2.1-4.4 4.1-4.4s3.6 1.5 4.1 4.4" />
      <circle cx="5.4" cy="9.6" r="2.1" />
      <path d="M2 17.2c.4-2.4 1.6-3.7 3.4-3.7" />
      <circle cx="18.6" cy="9.6" r="2.1" />
      <path d="M22 17.2c-.4-2.4-1.6-3.7-3.4-3.7" />
    </>
  ),
};

export type IconName = keyof typeof PATHS;

export const ICON_NAMES = Object.keys(PATHS) as IconName[];

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
}

/** One stroke glyph. Decorative by default (`aria-hidden`); pass aria-label to expose it. */
export function Icon({ name, size = 18, ...rest }: IconProps) {
  return (
    <svg
      aria-hidden={rest['aria-label'] ? undefined : true}
      // Which glyph rendered, as inert metadata: lets tests and e2e assert
      // icon-carried meaning (a portfolio's kind, say) without giving a
      // decorative glyph an accessible name it would then leak into its row.
      data-icon={name}
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.6}
      viewBox="0 0 24 24"
      width={size}
      {...rest}
    >
      {PATHS[name] ?? null}
    </svg>
  );
}
