import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * There must be exactly ONE thing that verifies a JWT.
 *
 * There used to be two, and they disagreed in ways that were invisible until
 * traced by hand:
 *
 *   · `JwtStrategy.validate()` returns `{ id: payload.sub, ... }` and calls
 *     `assertSessionLive(payload.sid)`.
 *   · `JwtAuthGuard` set `request.user = payload` **raw**. The payload carries
 *     `sub`, not `id`, so `actor.id` was `undefined` on every route behind it
 *     — `/storage`, `/queue`, `/elasticsearch`. `storage.controller.ts` wrote
 *     `userId: actor.id` as the uploader, so files were attributed to nobody
 *     and then invisible to the person who uploaded them, because
 *     `checkAccess` requires `file.createdById && file.createdById === actor.id`.
 *     That `&&` is what stopped `undefined === undefined` matching and turning
 *     an attribution bug into a cross-user read.
 *   · It also skipped the session check entirely, so a **revoked or logged-out
 *     token still worked** on those three controllers.
 *
 * The fix was to delete the second verifier, not to patch it. This spec exists
 * so a well-meaning "let's add a lightweight guard" cannot quietly reintroduce
 * the split. If you need different behaviour, change the strategy — one place.
 */
const SRC = join(__dirname, '..');

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) yield p;
  }
}

describe('exactly one JWT verifier', () => {
  const files = [...walk(SRC)];

  /**
   * One deliberate exemption, named rather than pattern-matched away:
   * `IamService.verifyMfaLogin` verifies the short-lived **MFA challenge**
   * token, which is a different credential from a session token — it carries
   * `mfaPending` and the method rejects anything without it, precisely so an
   * ordinary access token cannot be traded up into a full session here.
   * Verifying a challenge is not a second session verifier.
   */
  const ALLOWED = [join('iam', 'iam.service.ts')];

  /**
   * A KNOWN DEFECT, not an approved exemption — kept here so it cannot be
   * forgotten, and so the day it is fixed this list gets shorter rather than
   * the rule getting weaker.
   *
   * `SamlService` injects `JwtService` and signs a session token directly
   * (`{sub, email, tenantId, roles: []}`), bypassing `IamService.issueSession`.
   * Three consequences, all confirmed: the token carries no `sid`, so
   * `jwt.strategy.ts:71` skips `assertSessionLive` and **it cannot be revoked**;
   * no `Session` row exists, so it never appears in `GET /auth/sessions` and
   * `POST /auth/logout-all` silently does nothing for it; and `roles: []` makes
   * `scopeOf` return `'own'`, so a firm admin arriving via SAML is locked out
   * of their own firm's data.
   *
   * It is latent, not live: nothing in `src/` ever writes `ssoConfig`, the
   * tenant lookup runs unbound under FORCE RLS, and the response parser reads
   * `InResponseTo`/`StatusCode` as elements when they are attributes — so the
   * path 400s or 401s for every real IdP.
   *
   * The fix is to extract `issueSession` + `createSession` into a
   * `SessionService` that both callers use. **Delete this entry then** — do not
   * relax the assertion instead.
   */
  const KNOWN_DEFECT_SAML = join('iam', 'services', 'saml.service.ts');

  it('nothing verifies a session token except the strategy', () => {
    const offenders = files.filter((f) => {
      if (f.endsWith(join('strategies', 'jwt.strategy.ts'))) return false;
      if (ALLOWED.some((a) => f.endsWith(a))) return false;
      if (f.endsWith(KNOWN_DEFECT_SAML)) return false;
      const src = readFileSync(f, 'utf8');
      // Match the TYPE, not the identifier. The original pattern keyed on the
      // name `jwtService`, so a reintroduced guard declaring
      // `private jwt: JwtService` and calling `this.jwt.verifyAsync(...)`
      // slipped straight through the thing meant to stop it.
      const injectsJwtService = /:\s*JwtService\b/.test(src);
      const verifies = /\.\s*verify(Async)?\s*\(/.test(src);
      // Signing is not verifying — the SAML and refresh paths sign.
      return injectsJwtService && verifies;
    });
    expect(offenders.map((f) => f.replace(SRC, 'src'))).toEqual([]);
  });

  it('the MFA exemption still refuses an ordinary access token', () => {
    const src = readFileSync(join(SRC, 'iam', 'iam.service.ts'), 'utf8');
    // If this guard is ever removed, the exemption above stops being safe.
    expect(src).toMatch(/challenge\?\.mfaPending/);
  });

  /**
   * Broadened after review: the original pattern was a literal match on two
   * identifier names (`request.user = payload`) and would have missed
   * `req.user = decoded`, `request['user'] = payload`, or a spread. A guard
   * that only catches the exact line already deleted is not a guard.
   */
  it('nothing assigns a decoded token onto the request', () => {
    const offenders = files.filter((f) =>
      /\b(req|request)\b\s*(\.user\b|\['user'\])\s*=/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders.map((f) => f.replace(SRC, 'src'))).toEqual([]);
  });

  it('nothing decodes or verifies a token outside the sanctioned paths', () => {
    const offenders = files.filter((f) => {
      if (f.endsWith(join('strategies', 'jwt.strategy.ts'))) return false;
      if (ALLOWED.some((a) => f.endsWith(a))) return false;
      const src = readFileSync(f, 'utf8');
      // `decode()` skips signature verification entirely — reading claims from
      // an unverified token is the same class of mistake as a second verifier.
      return (
        /jwtService\.decode\s*\(/.test(src) ||
        /require\(['"]jsonwebtoken['"]\)/.test(src) ||
        /from ['"]jsonwebtoken['"]/.test(src)
      );
    });
    expect(offenders.map((f) => f.replace(SRC, 'src'))).toEqual([]);
  });

  it('the one verifier maps sub -> id and checks session liveness', () => {
    const strategy = readFileSync(
      join(SRC, 'iam', 'strategies', 'jwt.strategy.ts'),
      'utf8',
    );
    // `actor.id` is what `scopeOf` and every ownership check read.
    expect(strategy).toMatch(/id:\s*payload\.sub/);
    // Without this a revoked token stays valid until it expires.
    expect(strategy).toMatch(/assertSessionLive\(/);
  });

  it('the SAML known-defect exemption is still the ONLY one', () => {
    // If SAML has been fixed, this fails and you delete the exemption. If a
    // second file has started signing session tokens, this fails and you ask
    // why. Either way somebody looks.
    const stillOffending = files.filter((f) => {
      if (f.endsWith(join('strategies', 'jwt.strategy.ts'))) return false;
      if (ALLOWED.some((a) => f.endsWith(a))) return false;
      const src = readFileSync(f, 'utf8');
      return /:\s*JwtService\b/.test(src) && /\.\s*verify(Async)?\s*\(/.test(src);
    });
    expect(stillOffending.map((f) => f.replace(SRC, 'src'))).toEqual([
      'src/iam/services/saml.service.ts',
    ]);
  });
});
