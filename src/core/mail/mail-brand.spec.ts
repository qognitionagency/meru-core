import { MailService, MailMessage } from './mail.service';
import {
  resolveMailBrand,
  withDisplayName,
  UNBRANDED_MAIL,
  type BrandableTenant,
} from './mail-brand';

/**
 * Invitations are the emails the whole onboarding lifecycle depends on — a
 * firm admin, a staff member and a client each get one — and they went out
 * saying "Welcome to Meru" to people who have never heard of Meru.
 *
 * So what is tested here is the sender identity, and specifically that the
 * fallback is *silence* rather than the platform's own name.
 */
describe('mail branding', () => {
  const tenant = (overrides: Partial<BrandableTenant> = {}): BrandableTenant =>
    ({
      name: 'Harbourline Migration',
      settings: {},
      ...overrides,
    }) as BrandableTenant;

  describe('resolveMailBrand', () => {
    it('prefers the tenant’s configured sender name', () => {
      const brand = resolveMailBrand(
        tenant({
          settings: {
            notifications: { emailFromName: 'Harbourline Client Care' },
          },
        }),
      );

      expect(brand).toEqual({
        name: 'Harbourline Client Care',
        source: 'tenant-email-name',
      });
    });

    it('falls back to the tenant name, which is NOT NULL on every tenant', () => {
      expect(resolveMailBrand(tenant())).toEqual({
        name: 'Harbourline Migration',
        source: 'tenant-name',
      });
    });

    it('ignores a blank configured name rather than sending from an empty string', () => {
      const brand = resolveMailBrand(
        tenant({ settings: { notifications: { emailFromName: '   ' } } }),
      );

      expect(brand.name).toBe('Harbourline Migration');
      expect(brand.source).toBe('tenant-name');
    });

    it('resolves to no brand at all when there is no tenant, never to the platform', () => {
      // The point of the whole change: an unknown brand is `null`, and every
      // builder treats `null` as "say nothing". Substituting a house name here
      // is what the defect was.
      for (const absent of [null, undefined]) {
        expect(resolveMailBrand(absent)).toEqual(UNBRANDED_MAIL);
        expect(resolveMailBrand(absent).name).toBeNull();
      }
    });

    it('does not invent a brand for a tenant whose name is blank', () => {
      expect(resolveMailBrand(tenant({ name: '  ' }))).toEqual(UNBRANDED_MAIL);
    });

    it('reads nothing but the tenant it was handed', () => {
      // Branding is resolved from a row the caller already loaded by id; this
      // function issues no query, so it cannot reach another tenant's data.
      const other = tenant({ name: 'Someone Else Migration' });
      const brand = resolveMailBrand(tenant());

      expect(brand.name).toBe('Harbourline Migration');
      expect(brand.name).not.toBe(other.name);
    });
  });

  describe('withDisplayName', () => {
    it('keeps the verified address and replaces only the display name', () => {
      expect(
        withDisplayName(
          'Meru <invites@immistack.com>',
          'Harbourline Migration',
        ),
      ).toBe('"Harbourline Migration" <invites@immistack.com>');
    });

    it('accepts a bare address', () => {
      expect(withDisplayName('invites@immistack.com', 'Harbourline')).toBe(
        '"Harbourline" <invites@immistack.com>',
      );
    });

    it('quotes a name containing a comma or a quote', () => {
      // `Nguyen, Ho & Co.` unquoted would parse as two addresses.
      expect(withDisplayName('a@b.test', 'Nguyen, Ho & Co.')).toBe(
        '"Nguyen, Ho & Co." <a@b.test>',
      );
      expect(withDisplayName('a@b.test', 'The "Big" Firm')).toBe(
        '"The \\"Big\\" Firm" <a@b.test>',
      );
    });
  });

  describe('MailService message bodies', () => {
    const build = () => {
      const config = {
        get: (key: string) =>
          key === 'RESEND_FROM'
            ? 'Meru <invites@immistack.com>'
            : key === 'APP_URL'
              ? 'https://app.immistack.com'
              : undefined,
      };
      const service = new MailService(config as never);
      const sent: MailMessage[] = [];
      jest.spyOn(service, 'send').mockImplementation((message: MailMessage) => {
        sent.push(message);
        return Promise.resolve({ delivered: true });
      });
      return { service, sent };
    };

    const expiresAt = new Date('2026-09-17T00:00:00Z');

    it('signs a client invitation with the firm, and never names the platform', async () => {
      const { service, sent } = build();

      await service.sendInvite({
        to: 'applicant@example.test',
        inviterName: 'Priya Raman',
        tenantName: 'Harbourline Migration',
        brand: resolveMailBrand(tenant()),
        token: 'tok',
        expiresAt,
      });

      const [message] = sent;
      expect(message.subject).toBe(
        'Priya Raman invited you to join Harbourline Migration',
      );
      expect(message.from).toBe(
        '"Harbourline Migration" <invites@immistack.com>',
      );
      expect(message.text).toContain('— Harbourline Migration');
      // The whole defect, asserted directly.
      expect(`${message.subject} ${message.text} ${message.html}`).not.toMatch(
        /Meru/i,
      );
    });

    it('sends an unbranded invitation with no sign-off rather than a borrowed one', async () => {
      const { service, sent } = build();

      await service.sendInvite({
        to: 'someone@example.test',
        inviterName: 'A colleague',
        tenantName: 'your workspace',
        brand: UNBRANDED_MAIL,
        token: 'tok',
        expiresAt,
      });

      const [message] = sent;
      // No `from` override: the configured RESEND_FROM goes out unchanged,
      // because there is no tenant name to put on it.
      expect(message.from).toBeUndefined();
      expect(message.text).not.toContain('—');
      expect(message.text).not.toMatch(/Meru/i);
      expect(message.html).not.toMatch(/meru\.com/i);
    });

    it('brands the welcome and reset emails the same way', async () => {
      const { service, sent } = build();
      const brand = resolveMailBrand(
        tenant({
          settings: {
            notifications: { emailFromName: 'Harbourline Client Care' },
          },
        }),
      );

      await service.sendWelcome({
        to: 'admin@example.test',
        firstName: 'Dana',
        tenantName: 'Harbourline Migration',
        tenantSlug: 'harbourline',
        brand,
        plan: 'starter',
        trialEndsAt: null,
      });
      await service.sendPasswordReset({
        to: 'admin@example.test',
        firstName: 'Dana',
        brand,
        token: 'tok',
        expiresAt,
      });

      const [welcome, reset] = sent;
      expect(welcome.subject).toBe(
        'Welcome — your Harbourline Migration workspace is ready',
      );
      expect(reset.subject).toBe('Reset your Harbourline Client Care password');
      for (const message of sent) {
        expect(message.from).toBe(
          '"Harbourline Client Care" <invites@immistack.com>',
        );
        expect(
          `${message.subject} ${message.text} ${message.html}`,
        ).not.toMatch(/Meru/i);
      }
    });

    it('keeps the platform signup invite unbranded — the recipient has no tenant yet', async () => {
      const { service, sent } = build();

      await service.sendTenantSignupInvite({
        to: 'founder@newfirm.test',
        token: 'tok',
        expiresAt,
      });

      const [message] = sent;
      expect(message.subject).toBe('You are invited to create a workspace');
      expect(message.from).toBeUndefined();
      expect(message.text).not.toMatch(/Meru/i);
    });

    it('links the signup invite to a route that exists', async () => {
      // `${appUrl}/signup?token=` — what this used to build — is a 404: there
      // is no `/signup` page in the ImmiStack app. The provisioning wizard is
      // `app/(auth)/onboarding`, and it reads `?token=` from its own query
      // string. A dead link is worse than no email, because the operator's
      // side reports `delivered: true`.
      const { service, sent } = build();

      await service.sendTenantSignupInvite({
        to: 'founder@newfirm.test',
        token: 'tok',
        expiresAt,
      });

      const [message] = sent;
      expect(message.text).toContain(
        'https://app.immistack.com/onboarding?token=tok',
      );
      expect(message.html).toContain('/onboarding?token=tok');
      expect(`${message.text} ${message.html}`).not.toMatch(/\/signup\?/);
    });

    it('never falls back to a hostname that does not resolve', async () => {
      // `app.meru.com` is NXDOMAIN (workspace CLAUDE.md §4) and was the
      // hardcoded APP_URL default. An unset variable must not silently become
      // a link a customer clicks and cannot reach.
      const config = { get: () => undefined };
      const service = new MailService(config as never);
      expect(service.appUrl).not.toContain('app.meru.com');
      expect(service.signupInviteUrl('tok')).toBe(
        'https://app.immistack.com/onboarding?token=tok',
      );
    });
  });
});
