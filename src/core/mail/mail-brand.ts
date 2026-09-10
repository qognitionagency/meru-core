import type { Tenant } from '../../iam/entities/tenant.entity';

/**
 * The tenant fields a brand can be derived from. Structural rather than the
 * entity itself so `src/core/` keeps a type-only dependency on IAM, and so a
 * caller that has already loaded a tenant does not have to hand the whole row
 * to the mail layer.
 */
export type BrandableTenant = Pick<Tenant, 'name' | 'settings'>;

/**
 * Who a transactional email appears to come from.
 *
 * Meru is the *platform*. The tenant is a migration firm or a bank, and its
 * clients have never heard of Meru — an applicant of Harbourline Migration
 * receiving "Welcome to Meru" is a white-label failure on the first email the
 * product ever sends them, and every invitation (firm admin, staff, client)
 * went out that way.
 */
export interface MailBrand {
  /**
   * The name the recipient is expected to recognise, or `null` when there is
   * nothing true to put there.
   *
   * `null` is deliberately not `'Meru'`: an email with no sign-off is honest,
   * and an email signed by a platform the recipient has no relationship with
   * is not. Every builder in `MailService` treats `null` as "say nothing"
   * rather than substituting a house name.
   */
  name: string | null;
  /**
   * Where `name` came from. Reported so a caller — or a test — can tell a
   * configured brand from a fallback without re-deriving the precedence.
   */
  source: 'tenant-email-name' | 'tenant-name' | 'unbranded';
}

/** No tenant, so no brand. Used by the platform-level signup invite. */
export const UNBRANDED_MAIL: MailBrand = { name: null, source: 'unbranded' };

/**
 * Resolve the sender identity for mail going to a member or client of one
 * tenant.
 *
 * Precedence, and why:
 *
 *  1. `settings.notifications.emailFromName` — the only field in the tenant
 *     schema that already means "the name our email comes from"
 *     (`tenant.entity.ts:92`). Explicit operator configuration outranks
 *     anything derived.
 *  2. `tenant.name` — the firm the recipient actually has a relationship
 *     with. `tenants.name` is NOT NULL, so on a real tenant this always
 *     resolves and the unbranded path is only reachable with no tenant at all.
 *  3. Nothing.
 *
 * **Not** `settings.branding` — it models `logo`, `colors` and `customDomain`
 * only; there is no name in it to read. **Not** a vertical product name
 * either: "ImmiStack" and "GovernanceX" appear in no config pack
 * (`immigration.json.name` is "Immigration Practice Management", and
 * `uiConfig` carries colours and URLs, no product name), so producing one here
 * would be inventing a brand string in core — and it would be *our* brand
 * rather than the firm's, which is the same white-label failure in a
 * different coat.
 *
 * `settings.notifications.emailFrom` is deliberately ignored. Resend will only
 * send from a domain verified in the Meru account, so honouring a tenant's own
 * address would silently fail to deliver; the display name is free-form, the
 * envelope address is not. The tenant brand therefore rides on the display
 * name of `RESEND_FROM`.
 *
 * Tenant scope: this reads a tenant row the caller has already loaded by id.
 * It performs no query of its own, so it cannot widen anyone's scope — but
 * every caller must pass the *recipient's* tenant, never an actor's.
 */
export function resolveMailBrand(
  tenant: BrandableTenant | null | undefined,
): MailBrand {
  if (!tenant) return UNBRANDED_MAIL;

  const configured = tenant.settings?.notifications?.emailFromName?.trim();
  if (configured) return { name: configured, source: 'tenant-email-name' };

  const name = tenant.name?.trim();
  if (name) return { name, source: 'tenant-name' };

  return UNBRANDED_MAIL;
}

/**
 * Put a display name on an RFC 5322 address, keeping the address exactly as
 * configured.
 *
 * `RESEND_FROM` is either `Name <addr@domain>` or a bare `addr@domain`; only
 * the name part is ever replaced, because the domain is what Resend verified.
 * The name is quoted and escaped — a firm called `Nguyen, Ho & Co.` contains a
 * comma, which unquoted would make the header parse as two recipients.
 */
export function withDisplayName(from: string, displayName: string): string {
  const angled = from.match(/<([^>]+)>/);
  const address = (angled ? angled[1] : from).trim();
  const escaped = displayName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}" <${address}>`;
}
