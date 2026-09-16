import { describe, expect, it } from 'vitest';

import {
  aiSettingsResponseSchema,
  aiTestConnectionRequestSchema,
  aiTestRequestSchema,
  updateAiSettingsRequestSchema,
} from './ai';

/**
 * The admin-writable Ollama endpoint (§13.5 V5-P12, §16 2026-07-22 — LOCAL AI
 * ONLY, #1656 defects 1 + 2).
 *
 * This file pins the half of the rule that can be decided without a resolver:
 * the scheme allowlist and the refusal of embedded credentials. Host CLASSIFICATION
 * (private / loopback vs public) is not here on purpose — it is the outbound
 * guard's one policy, applied by the API at write time and again at fetch time;
 * see `apps/api/src/services/ai/__tests__/aiEndpointPolicy.test.ts`.
 *
 * Every schema carrying the field is covered, not just the settings write: the
 * two admin probes take a candidate endpoint too, and a rule enforced on one of
 * the three is a rule with two ways around it.
 */

const ENDPOINT_SCHEMAS = [
  [
    'PATCH /admin/ai/settings',
    (endpoint: unknown) => updateAiSettingsRequestSchema.parse({ endpoint }),
  ],
  [
    'POST /admin/ai/test-connection',
    (endpoint: unknown) => aiTestConnectionRequestSchema.parse({ endpoint }),
  ],
  [
    'POST /admin/ai/test-request',
    (endpoint: unknown) => aiTestRequestSchema.parse({ endpoint, prompt: 'ping' }),
  ],
] as const;

/** Shapes a real local Ollama is genuinely addressed as — none may be refused. */
const ACCEPTED = [
  ['a LAN hostname', 'http://ollama.internal:11434'],
  ['an mDNS .local name', 'http://ollama.local:11434'],
  ['loopback by name', 'http://localhost:11434'],
  ['loopback by literal', 'http://127.0.0.1:11434'],
  ['an RFC1918 literal', 'http://10.0.0.5:11434'],
  ['a unique-local IPv6 literal', 'http://[fd12:3456::1]:11434'],
  ['https behind a LAN reverse proxy', 'https://ollama.internal'],
  ['a base path', 'http://ollama.internal:11434/ollama'],
] as const;

const REJECTED = [
  ['a non-URL string', 'not-a-url'],
  ['a javascript: URL', 'javascript:alert(1)'],
  ['a file: URL', 'file:///etc/passwd'],
  ['a gopher: URL', 'gopher://ollama.internal:11434'],
  ['a data: URL', 'data:text/plain,hi'],
  ['userinfo with a password', 'https://svc:s3cr3t@ollama.internal/'],
  ['userinfo with a username only', 'http://svc@ollama.internal:11434'],
  ['an empty password that still parses as userinfo', 'http://svc:@ollama.internal:11434'],
  ['a query string', 'http://ollama.internal:11434/?key=s3cr3t'],
  ['a fragment', 'http://ollama.internal:11434/#s3cr3t'],
] as const;

describe('AI endpoint field — scheme allowlist + no credentials (#1656)', () => {
  for (const [schemaLabel, parse] of ENDPOINT_SCHEMAS) {
    describe(schemaLabel, () => {
      it.each(ACCEPTED)('accepts %s', (_label, endpoint) => {
        expect(() => parse(endpoint)).not.toThrow();
      });

      it.each(REJECTED)('rejects %s', (_label, endpoint) => {
        expect(() => parse(endpoint)).toThrow();
      });

      it('rejects an endpoint past the length cap', () => {
        expect(() => parse(`http://ollama.internal/${'a'.repeat(2048)}`)).toThrow();
      });
    });
  }

  it('still clears the override with an empty string or null', () => {
    expect(updateAiSettingsRequestSchema.parse({ endpoint: '' }).endpoint).toBeNull();
    expect(updateAiSettingsRequestSchema.parse({ endpoint: '   ' }).endpoint).toBeNull();
    expect(updateAiSettingsRequestSchema.parse({ endpoint: null }).endpoint).toBeNull();
  });

  it('leaves an omitted endpoint omitted, so a cap-only save touches nothing else', () => {
    const parsed = updateAiSettingsRequestSchema.parse({ dailyCap: 5 });
    expect('endpoint' in parsed).toBe(false);
  });

  /**
   * The rule is asserted on the way OUT as well. It can only fire if the
   * service's redaction regresses — at which point failing the response is
   * strictly better than serving the credential to the admin SPA.
   */
  describe('GET /admin/ai/settings response', () => {
    const base = {
      model: 'llama3.1:8b',
      dailyCap: 20,
      configured: true,
      updatedAt: null,
      updatedBy: null,
    };

    it('refuses to serialize an endpoint carrying credentials', () => {
      expect(() =>
        aiSettingsResponseSchema.parse({
          ...base,
          endpoint: 'https://svc:s3cr3t@ollama.internal/',
        }),
      ).toThrow();
    });

    it('still renders a public endpoint stored before the guard existed — it must be fixable', () => {
      expect(
        aiSettingsResponseSchema.parse({ ...base, endpoint: 'https://collector.attacker.tld/' })
          .endpoint,
      ).toBe('https://collector.attacker.tld/');
    });

    it('renders the unset state', () => {
      expect(aiSettingsResponseSchema.parse({ ...base, endpoint: null }).endpoint).toBeNull();
    });
  });
});
