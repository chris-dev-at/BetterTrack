import { describe, expect, it } from 'vitest';

import {
  proofMatchesRequest,
  signParanoidMediaProof,
  verifyParanoidMediaProof,
} from '../paranoidMediaProof';

const request = {
  expected: {
    mediaSet: ['server'] as ('server' | 'drive')[],
    driveAttestedVersion: null,
  },
  nextMediaSet: ['server', 'drive'] as ('server' | 'drive')[],
  verification: { medium: 'drive' as const, version: 7 },
};

describe('paranoid media transition proof', () => {
  it('binds one signed proof to the user, exact transition and expiry', () => {
    const proof = signParanoidMediaProof('secret-a', {
      userId: '018f0000-0000-7000-8000-00000000000a',
      generation: 4,
      ...request,
      expiresAtMs: 20_000,
    });
    const verified = verifyParanoidMediaProof('secret-a', proof, 10_000);
    expect(verified).not.toBeNull();
    expect(verified?.generation).toBe(4);
    expect(
      verified && proofMatchesRequest(verified, '018f0000-0000-7000-8000-00000000000a', request),
    ).toBe(true);
    expect(
      verified && proofMatchesRequest(verified, '018f0000-0000-7000-8000-00000000000b', request),
    ).toBe(false);
    expect(
      verified &&
        proofMatchesRequest(verified, '018f0000-0000-7000-8000-00000000000a', {
          ...request,
          nextMediaSet: ['drive'],
        }),
    ).toBe(false);
    expect(
      verified &&
        proofMatchesRequest(verified, '018f0000-0000-7000-8000-00000000000a', {
          ...request,
          verification: {
            ...request.verification,
            serverCandidateId: '018f0000-0000-7000-8000-00000000000c',
          },
        }),
    ).toBe(false);
    expect(verifyParanoidMediaProof('secret-a', proof, 20_000)).toBeNull();
  });

  it('rejects a wrong secret and any payload or signature tampering', () => {
    const proof = signParanoidMediaProof('secret-a', {
      userId: '018f0000-0000-7000-8000-00000000000a',
      generation: 4,
      ...request,
      expiresAtMs: 20_000,
    });
    expect(verifyParanoidMediaProof('secret-b', proof, 10_000)).toBeNull();
    const [body, signature] = proof.split('.');
    expect(verifyParanoidMediaProof('secret-a', `${body}x.${signature}`, 10_000)).toBeNull();
    expect(verifyParanoidMediaProof('secret-a', `${body}.${signature}x`, 10_000)).toBeNull();
  });
});
