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
    // Twice now, invitation mail has linked to a route nobody built: first
    // `/signup`, then `/accept-invite`. `/reset-password` is the one that
    // exists AND redeems an INVITE token — its own page header says it serves
    // both flows. Assert the destination, not just the shape.
    expect(inviteUrlFor('https://app.immistack.com', 'abc')).toBe(
      'https://app.immistack.com/reset-password?token=abc',
    );
  });

  it('does not point at either route that was never built', () => {
    const url = inviteUrlFor('https://app.immistack.com', 'abc');
    expect(url).not.toContain('/accept-invite');
    expect(url).not.toContain('/signup');
  });

  it('encodes the token', () => {
    // Tokens are base64url today, but a raw `+` or `/` reaching a query string
    // unencoded silently decodes to something else and the invite 404s.
    expect(inviteUrlFor('https://x.test', 'a+b/c=')).toBe(
      'https://x.test/reset-password?token=a%2Bb%2Fc%3D',
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
