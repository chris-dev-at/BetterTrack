/**
 * Minimal User-Agent → human label parser for the session manager (V3-P11a,
 * PROJECTPLAN.md §6.1). Deliberately dependency-free and coarse — "device label
 * from UA parsing is enough for v3" (issue scope); no geo-IP, no session naming.
 * Produces a "<Browser> on <OS>" label, degrading gracefully to whichever half
 * it can recognise, and to "Unknown device" when the UA is missing or opaque
 * (e.g. sessions created before this feature carried no UA).
 */

const UNKNOWN_DEVICE = 'Unknown device';

/** Browser families, most specific first — order matters (Edge/Chrome overlap). */
const BROWSERS: readonly { label: string; test: (ua: string) => boolean }[] = [
  {
    label: 'Edge',
    test: (ua) => ua.includes('edg/') || ua.includes('edga/') || ua.includes('edgios/'),
  },
  { label: 'Opera', test: (ua) => ua.includes('opr/') || ua.includes('opera') },
  { label: 'Samsung Internet', test: (ua) => ua.includes('samsungbrowser') },
  { label: 'Firefox', test: (ua) => ua.includes('firefox') || ua.includes('fxios') },
  // Chrome must lose to Edge/Opera/Samsung (all carry "chrome" too) — hence last-ish.
  {
    label: 'Chrome',
    test: (ua) => ua.includes('chrome') || ua.includes('crios') || ua.includes('chromium'),
  },
  // Safari carries "safari" but so does Chrome; only match when no chrome token.
  {
    label: 'Safari',
    test: (ua) => ua.includes('safari') && !ua.includes('chrome') && !ua.includes('crios'),
  },
];

/** OS families, most specific first (iOS/iPadOS before macOS, Android before Linux). */
const OSES: readonly { label: string; test: (ua: string) => boolean }[] = [
  {
    label: 'iOS',
    test: (ua) => ua.includes('iphone') || ua.includes('ipad') || ua.includes('ipod'),
  },
  { label: 'Android', test: (ua) => ua.includes('android') },
  { label: 'Windows', test: (ua) => ua.includes('windows') },
  { label: 'macOS', test: (ua) => ua.includes('macintosh') || ua.includes('mac os x') },
  { label: 'Linux', test: (ua) => ua.includes('linux') },
];

function match(
  ua: string,
  table: readonly { label: string; test: (ua: string) => boolean }[],
): string | null {
  for (const entry of table) {
    if (entry.test(ua)) return entry.label;
  }
  return null;
}

/**
 * Turn a raw User-Agent into a short "<Browser> on <OS>" label. Missing or
 * unrecognisable agents fall back to {@link UNKNOWN_DEVICE} so the sessions list
 * never crashes on legacy or non-browser callers.
 */
export function describeUserAgent(userAgent: string | null | undefined): string {
  if (!userAgent || userAgent.trim().length === 0) return UNKNOWN_DEVICE;
  const ua = userAgent.toLowerCase();
  const browser = match(ua, BROWSERS);
  const os = match(ua, OSES);
  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  if (os) return os;
  return UNKNOWN_DEVICE;
}

export { UNKNOWN_DEVICE };
