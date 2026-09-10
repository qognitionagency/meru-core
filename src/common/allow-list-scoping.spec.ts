import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { PlatformRole } from '../iam/enums/platform-role.enum';
import { TenantContext } from '../core/tenancy/tenant-context';
import {
  Actor,
  SYSTEM_ACTOR,
  hasTenantWideReach,
  scopeOf,
} from './access';

/**
 * Authorisation defaults are an ALLOW-LIST. Widening is a deliberate edit.
 *
 * Two idioms used to decide "may this caller see the whole tenant?", and they
 * failed in opposite directions:
 *
 *   · **The deny-list.** `PaymentsController`, `CommunicationsController` and
 *     `CrmController` each computed `isStaff` from a literal role array and
 *     returned the FIRM-WIDE view (`null`) for anyone who was neither `client`
 *     nor one of those three roles. A role none of them had heard of got the
 *     whole payments ledger, every client conversation, every matter with its
 *     `verticalAttributes` — passport and visa data on ImmiStack — and the CSV
 *     export, which shares the CRM helper.
 *
 *   · **The `!== 'own'` comparison.** Sixteen of nineteen `scopeOf` call sites
 *     were written `if (scopeOf(actor) !== 'own') return;` — skip the
 *     narrowing — or `if (scopeOf(actor) === 'own') { …narrow… }`. Both stay
 *     valid, type-checking code the day `AccessScope` gains a fourth member,
 *     and both then skip the narrowing for it. TypeScript cannot help: the
 *     comparison is not ill-typed, only wrong. All sixteen were LIST routes.
 *     The three that failed closed were by-id checks that happened to be
 *     written as an allow-list (`scope === 'god' || scope === 'tenant'`) — by
 *     accident of style, not by rule.
 *
 * Both were replaced by `hasTenantWideReach(actor)`, which has no third branch
 * to forget. This spec is what keeps them gone: the fix was to make the
 * fail-open idiom **unwritable**, not to correct sixteen instances of it and
 * hope. The same technique as `iam/one-jwt-verifier.spec.ts`, for the same
 * reason — a rule nothing enforces is a rule that lasted one refactor.
 */
const SRC = join(__dirname, '..');

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) yield p;
  }
}

/**
 * Comment lines only. `access.ts` quotes the banned idiom in the doc comment
 * that explains why it is banned, and that must not fail its own rule — but
 * nothing is stripped mid-line, so a real comparison can never hide behind a
 * trailing `//` or a URL.
 */
function codeLines(src: string): string[] {
  return src.split('\n').filter((line) => {
    const t = line.trim();
    return !(
      t.startsWith('*') ||
      t.startsWith('/*') ||
      t.startsWith('*/') ||
      t.startsWith('//')
    );
  });
}

describe('authorisation defaults are an allow-list', () => {
  const files = [...walk(SRC)];

  it('nothing branches on the scope literal `own`', () => {
    // Matches the free function AND the method form — `this.scopeOf(actor)`,
    // `this.access.scopeOf(actor)` — because two of the sixteen were method
    // calls and a pattern keyed on the bare identifier would have missed them.
    const idiom = /scopeOf\s*\([^)]*\)\s*(===|!==)\s*['"]own['"]/;
    const offenders = files.filter((f) =>
      codeLines(readFileSync(f, 'utf8')).some((line) => idiom.test(line)),
    );
    expect(offenders.map((f) => f.replace(SRC, 'src'))).toEqual([]);
  });

  it('nothing compares any scope value against the literal `own`', () => {
    // Broader than the call-site pattern above: catches the shape that gets
    // there via a local, which is how three of the by-id checks were written
    // before this change — `const scope = scopeOf(actor); if (scope !== 'own')`.
    const idiom = /\b(===|!==)\s*['"]own['"]/;
    const offenders = files.filter((f) =>
      codeLines(readFileSync(f, 'utf8')).some((line) => idiom.test(line)),
    );
    expect(offenders.map((f) => f.replace(SRC, 'src'))).toEqual([]);
  });

  /**
   * The deny-list, in the shape it actually had. Three controllers built a
   * literal array of "staff" roles and treated everyone outside it as staff.
   * `TENANT_STAFF_ROLES` in `access.ts` is the one permitted list, and it is
   * an allow-list: membership grants reach rather than withholding it.
   */
  it('nothing outside access.ts builds its own staff role list', () => {
    const offenders = files.filter((f) => {
      if (f.endsWith(join('common', 'access.ts'))) return false;
      const src = codeLines(readFileSync(f, 'utf8')).join('\n');
      // `[... FIRM_ADMIN ... STAFF ...].includes(role)` — an inline role
      // membership test, which is a role list by another name.
      return /\[[^\][]*\bSTAFF\b[^\][]*\]\s*\.\s*includes\s*\(/s.test(src);
    });
    expect(offenders.map((f) => f.replace(SRC, 'src'))).toEqual([]);
  });

  it('the three client-scoping controllers ask the allow-list question', () => {
    for (const f of [
      join('crm', 'crm.controller.ts'),
      join('billing', 'payments.controller.ts'),
      join('notifications', 'communications.controller.ts'),
    ]) {
      const src = readFileSync(join(SRC, f), 'utf8');
      expect(src).toMatch(/hasTenantWideReach\s*\(/);
    }
  });
});

describe('hasTenantWideReach', () => {
  const actor = (roles: string[]): Actor => ({
    id: 'u1',
    roles,
    email: 'u1@example.com',
  });

  it('grants the two tenant staff roles', () => {
    expect(hasTenantWideReach(actor([PlatformRole.FIRM_ADMIN]))).toBe(true);
    expect(hasTenantWideReach(actor([PlatformRole.STAFF]))).toBe(true);
  });

  it('confines a client', () => {
    expect(hasTenantWideReach(actor([PlatformRole.CLIENT]))).toBe(false);
  });

  it('a client who also holds staff is staff — the wider role wins', () => {
    expect(
      hasTenantWideReach(actor([PlatformRole.CLIENT, PlatformRole.STAFF])),
    ).toBe(true);
  });

  it('confines a bare platform_admin token outside a god context', () => {
    // The deliberate behaviour change. The three controllers' deny-lists
    // counted `platform_admin` as staff; `access.ts` never has. Operator reach
    // into a tenant's records comes from `runAsGod`, which writes the CRITICAL
    // audit entry that makes it legal — not from the role string on a token.
    expect(hasTenantWideReach(actor([PlatformRole.PLATFORM_ADMIN]))).toBe(false);
  });

  it('grants inside a god context, where the access is already audited', async () => {
    await TenantContext.runAsGod('op-1', 'spec', async () => {
      expect(hasTenantWideReach(actor([PlatformRole.PLATFORM_ADMIN]))).toBe(
        true,
      );
      // Even a client-role actor: `runAsGod` is not reached from a client
      // route, and the god branch must not depend on the roles at all.
      expect(hasTenantWideReach(actor([PlatformRole.CLIENT]))).toBe(true);
    });
    expect(hasTenantWideReach(actor([PlatformRole.PLATFORM_ADMIN]))).toBe(false);
  });

  it('confines a role nobody has heard of — the whole point', () => {
    // The partner portal's role, an agent, a referrer, a regulator login. None
    // of these exist yet; every one of them would have received the firm-wide
    // view under the deny-list.
    expect(hasTenantWideReach(actor(['partner']))).toBe(false);
    expect(hasTenantWideReach(actor([]))).toBe(false);
    expect(hasTenantWideReach(actor(['staff_readonly']))).toBe(false);
  });

  it('grants SYSTEM_ACTOR, so tenant-initiated work keeps its reach', () => {
    expect(hasTenantWideReach(SYSTEM_ACTOR)).toBe(true);
  });

  it('agrees with scopeOf on every current token — behaviour-preserving', () => {
    // The migration property. If these ever disagree, one of them changed
    // meaning and the sixteen rewritten call sites moved with only one of
    // them.
    for (const roles of [
      [PlatformRole.PLATFORM_ADMIN],
      [PlatformRole.FIRM_ADMIN],
      [PlatformRole.STAFF],
      [PlatformRole.CLIENT],
      [PlatformRole.CLIENT, PlatformRole.STAFF],
      [],
      ['partner'],
    ]) {
      expect(hasTenantWideReach(actor(roles))).toBe(
        scopeOf(actor(roles)) !== 'own',
      );
    }
  });
});
