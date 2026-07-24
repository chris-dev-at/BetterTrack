import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PROVIDER_ID, readServiceContext, rpc, validateConfig } from './ccr-common.mjs';

class ProbeError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function normalizeModel(model) {
  const raw = String(model || '').replace(/^codex-api\//, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(raw)) {
    throw new ProbeError('Selected ClaudeX model is invalid');
  }
  return raw;
}

function responseText(body) {
  if (!Array.isArray(body?.content)) return '';
  return body.content
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('')
    .trim();
}

function classifyFailure(status, body) {
  const signal = JSON.stringify(body || {}).slice(0, 8_000);
  if (
    status === 429 ||
    status === 529 ||
    /usage limit|rate.?limit|quota|too many requests|capacity/i.test(signal)
  ) {
    return new ProbeError('ClaudeX subscription capacity is unavailable', 75);
  }
  if (
    status === 401 ||
    status === 403 ||
    /oauth|unauthori[sz]ed|x-target-provider|codex-api/i.test(signal)
  ) {
    return new ProbeError('ClaudeX router authentication is unavailable', 76);
  }
  return new ProbeError('ClaudeX direct gateway proof failed');
}

export async function directProbe(selectedModel) {
  const model = normalizeModel(selectedModel);
  const context = await readServiceContext();
  const config = await rpc(context, 'getConfig');
  if (!validateConfig(config)) {
    throw new ProbeError('ClaudeX configuration is invalid', 76);
  }
  if (typeof config.APIKEY !== 'string' || !config.APIKEY.trim()) {
    throw new ProbeError('CCR local client authentication is unavailable', 76);
  }

  let response;
  try {
    response = await fetch('http://127.0.0.1:3456/v1/messages', {
      method: 'POST',
      headers: {
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'x-api-key': config.APIKEY,
        'x-target-provider': PROVIDER_ID,
      },
      body: JSON.stringify({
        model,
        max_tokens: 32,
        messages: [
          {
            role: 'user',
            content: 'Reply with exactly: DIRECT_OK',
          },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new ProbeError('ClaudeX direct gateway is unavailable', 76);
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    // Classification below intentionally never prints the response body.
  }
  if (!response.ok) throw classifyFailure(response.status, body);
  if (body?.model !== model || responseText(body) !== 'DIRECT_OK') {
    throw new ProbeError('ClaudeX direct gateway proof was invalid');
  }
  return {
    ok: true,
    provider: 'claudex',
    model: `${PROVIDER_ID}/${model}`,
    terminalReason: 'completed',
  };
}

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  directProbe(process.argv[2])
    .then((result) => {
      if (!process.argv.includes('--quiet')) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
      }
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : 'ClaudeX direct proof failed';
      process.stderr.write(`ClaudeX direct proof failed: ${message}\n`);
      process.exitCode = error instanceof ProbeError ? error.exitCode : 1;
    });
}
