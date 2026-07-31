import type { ReactNode, SVGProps } from 'react';

export type IconName =
  | 'activity'
  | 'ai'
  | 'arrow-down'
  | 'arrow-right'
  | 'arrow-up'
  | 'assets'
  | 'bank'
  | 'bell'
  | 'briefcase'
  | 'calendar'
  | 'cash'
  | 'check'
  | 'chevron-down'
  | 'chevron-right'
  | 'clock'
  | 'code'
  | 'command'
  | 'copy'
  | 'database'
  | 'document'
  | 'download'
  | 'eye'
  | 'eye-off'
  | 'filter'
  | 'folder'
  | 'grid'
  | 'globe'
  | 'help'
  | 'home'
  | 'house'
  | 'inbox'
  | 'layers'
  | 'key'
  | 'link'
  | 'list'
  | 'lock'
  | 'menu'
  | 'message'
  | 'minus'
  | 'monitor'
  | 'moon'
  | 'more'
  | 'people'
  | 'pie'
  | 'plus'
  | 'portfolio'
  | 'refresh'
  | 'repeat'
  | 'search'
  | 'settings'
  | 'share'
  | 'shield'
  | 'sliders'
  | 'sparkles'
  | 'sun'
  | 'target'
  | 'terminal'
  | 'trash'
  | 'upload'
  | 'user-plus'
  | 'wallet'
  | 'workbench'
  | 'x';

const paths: Record<IconName, ReactNode> = {
  activity: (
    <>
      <path d="M4 13h3l2.2-7 4.2 12 2.2-7H20" />
      <path d="M3 5v14h18" opacity=".35" />
    </>
  ),
  ai: (
    <>
      <path d="M12 3.5 13.5 8a4 4 0 0 0 2.5 2.5l4.5 1.5-4.5 1.5a4 4 0 0 0-2.5 2.5L12 20.5 10.5 16A4 4 0 0 0 8 13.5L3.5 12 8 10.5A4 4 0 0 0 10.5 8Z" />
      <path d="m18.5 3 .4 1.1a3 3 0 0 0 1.9 1.9l1.2.5-1.2.4a3 3 0 0 0-1.9 1.9l-.4 1.2-.4-1.2a3 3 0 0 0-1.9-1.9L15 6.5l1.2-.5a3 3 0 0 0 1.9-1.9Z" />
    </>
  ),
  'arrow-down': (
    <>
      <path d="M12 4v16" />
      <path d="m6 14 6 6 6-6" />
    </>
  ),
  'arrow-right': (
    <>
      <path d="M4 12h16" />
      <path d="m14 6 6 6-6 6" />
    </>
  ),
  'arrow-up': (
    <>
      <path d="M12 20V4" />
      <path d="m6 10 6-6 6 6" />
    </>
  ),
  assets: (
    <>
      <path d="M4 19V9" />
      <path d="M10 19V5" />
      <path d="M16 19v-7" />
      <path d="M22 19V3" />
      <path d="M2 19h22" />
    </>
  ),
  bank: (
    <>
      <path d="m3 9 9-5 9 5" />
      <path d="M5 10h14" />
      <path d="M6 10v8m4-8v8m4-8v8m4-8v8" />
      <path d="M3 20h18" />
    </>
  ),
  bell: (
    <>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z" />
      <path d="M10 21h4" />
    </>
  ),
  briefcase: (
    <>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M3 12h18M10 12v2h4v-2" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M16 3v4M8 3v4M3 10h18" />
      <path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01" />
    </>
  ),
  cash: (
    <>
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M7 10h.01M17 15h.01" />
      <circle cx="12" cy="12.5" r="2.5" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  'chevron-right': <path d="m9 6 6 6-6 6" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  code: (
    <>
      <path d="m8 5-6 7 6 7M16 5l6 7-6 7M14 3l-4 18" />
    </>
  ),
  command: (
    <>
      <path d="M9 6V4a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v16a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3Z" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
    </>
  ),
  document: (
    <>
      <path d="M6 3h8l4 4v14H6Z" />
      <path d="M14 3v5h5M9 13h6M9 17h6" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5M4 21h16" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  'eye-off': (
    <>
      <path d="m4 4 16 16" />
      <path d="M10.5 6.2A9 9 0 0 1 12 6c6 0 9.5 6 9.5 6a16 16 0 0 1-2.2 2.8M6.2 6.5C3.8 8.2 2.5 12 2.5 12s3.5 6 9.5 6a9 9 0 0 0 3-.5" />
    </>
  ),
  filter: (
    <>
      <path d="M4 5h16M7 12h10M10 19h4" />
    </>
  ),
  folder: (
    <>
      <path d="M3 6h7l2 2h9v11H3Z" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9S14.5 18.4 12 21M12 3C9.5 5.6 8.2 8.6 8.2 12s1.3 6.4 3.8 9" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9a2.5 2.5 0 1 1 3.7 2.2c-.9.5-1.3 1.1-1.3 2.3M12 17h.01" />
    </>
  ),
  home: (
    <>
      <path d="m3 11 9-8 9 8" />
      <path d="M5 10v11h14V10M9 21v-6h6v6" />
    </>
  ),
  house: (
    <>
      <path d="m3 10 9-7 9 7v11H3Z" />
      <path d="M9 21v-7h6v7" />
    </>
  ),
  inbox: (
    <>
      <path d="M4 4h16l2 11v5H2v-5Z" />
      <path d="M2 15h6l2 2h4l2-2h6" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3 9 5-9 5-9-5Z" />
      <path d="m3 12 9 5 9-5M3 16l9 5 9-5" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="12" r="4" />
      <path d="M12 12h9M17 12v3M20 12v2" />
    </>
  ),
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.2" />
    </>
  ),
  list: (
    <>
      <path d="M9 6h12M9 12h12M9 18h12" />
      <path d="M4 6h.01M4 12h.01M4 18h.01" />
    </>
  ),
  lock: (
    <>
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  message: (
    <>
      <path d="M4 5h16v12H9l-5 4Z" />
      <path d="M8 9h8M8 13h5" />
    </>
  ),
  minus: <path d="M5 12h14" />,
  monitor: (
    <>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </>
  ),
  moon: <path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  people: (
    <>
      <path d="M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 20v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" />
    </>
  ),
  pie: (
    <>
      <path d="M21 12a9 9 0 1 1-9-9v9Z" />
      <path d="M15 3.5A9 9 0 0 1 20.5 9H15Z" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  portfolio: (
    <>
      <rect x="3" y="5" width="18" height="15" rx="2" />
      <path d="M8 5V3h8v2M3 10h18" />
      <path d="M10 10v2h4v-2" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 7v5h-5" />
      <path d="M4 17v-5h5" />
      <path d="M6 8a8 8 0 0 1 13.2 1L20 12M4 12l.8 3A8 8 0 0 0 18 16" />
    </>
  ),
  repeat: (
    <>
      <path d="m17 2 4 4-4 4" />
      <path d="M3 11V9a3 3 0 0 1 3-3h15" />
      <path d="m7 22-4-4 4-4" />
      <path d="M21 13v2a3 3 0 0 1-3 3H3" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
    </>
  ),
  share: (
    <>
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 20 6v6c0 5-3.2 8-8 9-4.8-1-8-4-8-9V6Z" />
      <path d="m8.5 12 2.2 2.2 4.8-5" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 6h5M15 6h5M4 12h9M19 12h1M4 18h2M12 18h8" />
      <circle cx="12" cy="6" r="2" />
      <circle cx="16" cy="12" r="2" />
      <circle cx="9" cy="18" r="2" />
    </>
  ),
  sparkles: (
    <>
      <path d="m12 3 1.2 3.8A4 4 0 0 0 16 9.5l3.8 1.2-3.8 1.2a4 4 0 0 0-2.8 2.8L12 18.5l-1.2-3.8A4 4 0 0 0 8 11.9l-3.8-1.2L8 9.5a4 4 0 0 0 2.8-2.7Z" />
      <path d="m19 3 .4 1.2a2 2 0 0 0 1.4 1.4L22 6l-1.2.4a2 2 0 0 0-1.4 1.4L19 9l-.4-1.2a2 2 0 0 0-1.4-1.4L16 6l1.2-.4a2 2 0 0 0 1.4-1.4Z" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3M13 15h4" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V4" />
      <path d="m7 9 5-5 5 5M4 20h16" />
    </>
  ),
  'user-plus': (
    <>
      <circle cx="9" cy="7" r="4" />
      <path d="M2 21v-2a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v2M19 8v6M16 11h6" />
    </>
  ),
  wallet: (
    <>
      <path d="M4 6h14a2 2 0 0 1 2 2v11H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h12" />
      <path d="M15 11h7v5h-7a2.5 2.5 0 0 1 0-5Z" />
    </>
  ),
  workbench: (
    <>
      <path d="M4 20h16M6 20l2-9h8l2 9M9 11l-2-7h10l-2 7M8 16h8" />
    </>
  ),
  x: <path d="m6 6 12 12M18 6 6 18" />,
};

type IconProps = SVGProps<SVGSVGElement> & {
  name: IconName;
  size?: number;
};

export function Icon({ name, size = 18, ...props }: IconProps) {
  return (
    <svg aria-hidden="true" fill="none" height={size} viewBox="0 0 24 24" width={size} {...props}>
      <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
        {paths[name]}
      </g>
    </svg>
  );
}
