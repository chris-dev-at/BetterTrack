import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SECRET_KEYS = new Set([
  'xccrwebauth',
  'ccrwebtoken',
  'authorization',
  'accesstoken',
  'refreshtoken',
  'xapikey',
  'apikey',
]);
const SECRET_KEY_SOURCE =
  '(?:x[-_]?ccr[-_]?web[-_]?auth|ccr[-_]?web[-_]?token|authorization|access[-_]?token|refresh[-_]?token|x[-_]?api[-_]?key|api[-_]?key)';
const ASSIGNMENT_PATTERN = new RegExp(
  `(${SECRET_KEY_SOURCE}(?:\\\\+)?["']?\\s*[:=]\\s*(?:\\\\+)?["']?(?:Bearer(?:\\s+|%20|\\\\u0020|\\\\+)+)?)([^,\\s&}\\]"'\\\\<>]+)`,
  'gi',
);
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>\\]+/gi;

function normalizedKey(key) {
  return String(key)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function isSecretKey(key) {
  return SECRET_KEYS.has(normalizedKey(key));
}

function addSecret(secrets, value) {
  if (typeof value !== 'string') return;
  const candidates = [value.trim(), value.trim().replace(/^Bearer\s+/i, '')];
  try {
    candidates.push(decodeURIComponent(value.trim()));
  } catch {
    // A malformed percent-encoding is still covered by the original value.
  }
  for (const candidate of candidates) {
    if (candidate && candidate !== '[redacted]' && candidate.length >= 3) {
      secrets.add(candidate);
    }
  }
}

function nestedJson(value) {
  const trimmed = value.trim();
  if (!trimmed || !['{', '[', '"'].includes(trimmed[0])) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function collectTextSecrets(text, secrets) {
  ASSIGNMENT_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(ASSIGNMENT_PATTERN)) {
    addSecret(secrets, match[2]);
  }
}

function collectStructuredSecrets(value, secrets, depth = 0) {
  if (depth > 5 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectStructuredSecrets(item, secrets, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (isSecretKey(key)) addSecret(secrets, item);
      else collectStructuredSecrets(item, secrets, depth + 1);
    }
    return;
  }
  if (typeof value !== 'string') return;
  collectTextSecrets(value, secrets);
  const nested = nestedJson(value);
  if (nested !== null) collectStructuredSecrets(nested, secrets, depth + 1);
}

function decodedForInspection(value) {
  let decoded = value;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded.replaceAll('\\u0026', '&').replaceAll('\\u003d', '=');
}

function sensitiveUrl(value) {
  const inspected = decodedForInspection(value);
  if (
    /(?:^|[?&])(x[-_]?ccr[-_]?web[-_]?auth|ccr[-_]?web[-_]?token|access[-_]?token|refresh[-_]?token|x[-_]?api[-_]?key|api[-_]?key|authorization)=/i.test(
      inspected,
    )
  ) {
    return true;
  }
  try {
    const url = new URL(inspected);
    const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
    return (
      loopback &&
      (url.port === '3458' ||
        url.port === '3459' ||
        url.pathname === '/api/ccr/rpc' ||
        url.pathname.startsWith('/api/ccr/'))
    );
  } catch {
    return false;
  }
}

function redactText(text, secrets) {
  collectTextSecrets(text, secrets);
  let result = text.replace(URL_PATTERN, (url) => (sensitiveUrl(url) ? '[redacted-url]' : url));
  ASSIGNMENT_PATTERN.lastIndex = 0;
  result = result.replace(ASSIGNMENT_PATTERN, '$1[redacted]');

  const ordered = [...secrets].sort((left, right) => right.length - left.length);
  for (const secret of ordered) {
    const variants = new Set([
      secret,
      encodeURIComponent(secret),
      JSON.stringify(secret).slice(1, -1),
    ]);
    for (const variant of variants) {
      if (variant) result = result.split(variant).join('[redacted]');
    }
  }
  return result;
}

function redactStructured(value, secrets, depth = 0) {
  if (depth > 5 || value == null) return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactStructured(item, secrets, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        isSecretKey(key) ? '[redacted]' : redactStructured(item, secrets, depth + 1),
      ]),
    );
  }
  if (typeof value !== 'string') return value;

  const nested = nestedJson(value);
  if (nested !== null) {
    return JSON.stringify(redactStructured(nested, secrets, depth + 1));
  }
  return redactText(value, secrets);
}

export function redactClaudeXStream(input) {
  const secrets = new Set();
  collectTextSecrets(input, secrets);
  const lines = input.split(/(\r?\n)/);
  for (const line of lines) {
    if (/^\r?\n$/.test(line) || !line) continue;
    const parsed = nestedJson(line);
    if (parsed !== null) collectStructuredSecrets(parsed, secrets);
  }

  return lines
    .map((line) => {
      if (/^\r?\n$/.test(line) || !line) return line;
      const parsed = nestedJson(line);
      if (parsed === null) return redactText(line, secrets);
      return redactText(JSON.stringify(redactStructured(parsed, secrets)), secrets);
    })
    .join('');
}

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    process.stdout.write(redactClaudeXStream(fs.readFileSync(0, 'utf8')));
  } catch {
    process.stderr.write('ClaudeX stream redaction failed\n');
    process.exitCode = 1;
  }
}
