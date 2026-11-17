import { IamService } from './iam.service';

/**
 * `IamService.mfaChallengeSubject` names the account an MFA challenge token
 * belongs to, for the per-account MFA attempt limit (Anton, 2026-11-17, #6).
 * It lives here, not in the interceptor that uses it, because this file is the
 * one sanctioned verifier of a challenge token (`one-jwt-verifier.spec.ts`),
 * and it applies the same rule as `verifyMfaLogin`: only a token carrying
 * `mfaPending` counts, so an ordinary access token names nobody.
 */
describe('IamService.mfaChallengeSubject', () => {
  function build(verify: (t: string) => unknown) {
    const args: any[] = new Array(9).fill({});
    args[6] = { verify: jest.fn(verify) }; // jwtService
    return new (IamService as any)(...args) as IamService;
  }

  it('returns the subject of a valid MFA challenge', () => {
    expect(build(() => ({ sub: 'u1', mfaPending: true })).mfaChallengeSubject('t')).toBe('u1');
  });

  it('returns null for an ordinary access token', () => {
    expect(build(() => ({ sub: 'u1', sid: 's' })).mfaChallengeSubject('t')).toBeNull();
  });

  it('returns null for an invalid or expired token, never throws', () => {
    const svc = build(() => {
      throw new Error('jwt expired');
    });
    expect(svc.mfaChallengeSubject('t')).toBeNull();
  });

  it('returns null for an empty token', () => {
    expect(build(() => ({ sub: 'u1', mfaPending: true })).mfaChallengeSubject('')).toBeNull();
  });
});
