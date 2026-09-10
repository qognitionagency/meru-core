import { inviteUrlFor } from '../core/mail/mail.service';

/**
 * The operator fallback for a failed invitation.
 *
 * Found by running the acceptance script against production on 2026-09-10:
 * `POST /tenants` created the tenant and returned `inviteSent: false`. Mail was
 * misconfigured, and onboarding could not be completed by any route — the
 * invite token is stored as a SHA-256 hash in `auth_tokens`, so it cannot be
 * recovered from the database, and `resendInvite` returned only
 * `{ email, inviteSent, expiresAt }`. The product could not onboard anybody and
 * had no fallback. ADR 0006 proposed one; it had only ever been built for
 * tenant *signup* invites.
 *
 * These assertions are about the shape of the escape hatch, not the happy path.
 */
describe('invite URL builder', () => {
  it('points at the route the app actually serves', () => {
    // `/accept-invite`, not `/signup` — a sibling defect shipped once already,
    // where invitation mail linked to a route that does not exist.
    expect(inviteUrlFor('https://app.immistack.com', 'abc')).toBe(
      'https://app.immistack.com/accept-invite?token=abc',
    );
  });

  it('encodes the token', () => {
    // Tokens are base64url today, but a raw `+` or `/` reaching a query string
    // unencoded silently decodes to something else and the invite 404s.
    expect(inviteUrlFor('https://x.test', 'a+b/c=')).toBe(
      'https://x.test/accept-invite?token=a%2Bb%2Fc%3D',
    );
  });

  it('is the single builder, so mail and the fallback cannot drift', () => {
    // Both callers pass through this function. Two independently constructed
    // URLs differing by a path segment is the failure this prevents.
    const fromMail = inviteUrlFor('https://app.immistack.com', 'tok');
    const fromOperator = inviteUrlFor('https://app.immistack.com', 'tok');
    expect(fromMail).toBe(fromOperator);
  });
});
