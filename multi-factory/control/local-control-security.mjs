import { isIP } from 'node:net';

const PRIVATE_IPV4 = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|169\.254\.)/;

export function isPrivateSource(address) {
  if (!address) return false;
  const value = String(address).replace(/^::ffff:/, '');
  return value === '::1' || (isIP(value) === 4 && PRIVATE_IPV4.test(value));
}

export function requestHostname(hostHeader) {
  try {
    return new URL(`http://${String(hostHeader || '')}`).hostname
      .replace(/^\[|\]$/g, '')
      .toLowerCase();
  } catch {
    return '';
  }
}

export function isAllowedRequestHost(hostHeader, configuredHost = '127.0.0.1') {
  const hostname = requestHostname(hostHeader);
  if (!hostname) return false;
  if (hostname === 'localhost' || isPrivateSource(hostname)) return true;
  const configured = String(configuredHost)
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  return !['0.0.0.0', '::'].includes(configured) && hostname === configured;
}

export function isLoopbackSource(address) {
  const value = String(address || '').replace(/^::ffff:/, '');
  return value === '::1' || (isIP(value) === 4 && value.startsWith('127.'));
}

export function isLoopbackHost(hostHeader) {
  const hostname = requestHostname(hostHeader);
  return (
    hostname === 'localhost' ||
    hostname === '::1' ||
    (isIP(hostname) === 4 && hostname.startsWith('127.'))
  );
}

export function isSameLoopbackOrigin({ host, origin } = {}) {
  if (!isLoopbackHost(host)) return false;
  if (!origin) return true;
  try {
    return new URL(origin).host.toLowerCase() === String(host).toLowerCase();
  } catch {
    return false;
  }
}

export function isSamePrivateOrigin({ host, origin } = {}, configuredHost = '127.0.0.1') {
  if (!isAllowedRequestHost(host, configuredHost)) return false;
  const hostname = requestHostname(host);
  if (hostname !== 'localhost' && !isPrivateSource(hostname)) return false;
  if (!origin) return false;
  try {
    return new URL(origin).origin.toLowerCase() === new URL(`http://${host}`).origin.toLowerCase();
  } catch {
    return false;
  }
}
