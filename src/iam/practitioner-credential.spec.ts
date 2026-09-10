import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { IamService } from './iam.service';
import { PlatformRole } from './enums/platform-role.enum';
import { UserStatus } from './entities/user.entity';

/**
 * FR-1.2 — a registered practitioner's credential is a first-class field.
 *
 * The ImmiStack onboarding wizard has collected a MARN per staff invite since
 * it shipped and has correctly told the operator it is not saved, because
 * `InviteUserDto` had nowhere to put it. These tests pin what "saved" now
 * means, and — as much — what it deliberately does not claim.
 *
 * The harness mirrors `role-escalation.spec.ts`'s: one keyed fake repo
 * answering both `findOne` shapes the service uses.
 */
describe('IamService — practitioner credential (FR-1.2)', () => {
  const T = 'tenant-1';
  const ADMIN = { id: 'admin-1', roles: [PlatformRole.FIRM_ADMIN] };

  function build() {
    const users: Array<Record<string, any>> = [];

    const userRepo = {
      findOne: jest.fn(async ({ where }: any) => {
        if (where.email !== undefined) {
          const match = users.find((u) => u.email === where.email);
          return match ? { ...match } : null;
        }
        const match = users.find(
          (u) =>
            u.id === where.id &&
            (where.tenantId === undefined || u.tenantId === where.tenantId),
        );
        return match ? { ...match } : null;
      }),
      create: jest.fn((x: any) => ({ id: `new-${users.length + 1}`, ...x })),
      save: jest.fn(async (u: any) => {
        const idx = users.findIndex((x) => x.id === u.id);
        if (idx === -1) users.push({ ...u });
        else users[idx] = { ...u };
        return u;
      }),
    };
    const tenantRepo = { findOne: jest.fn(async () => ({ id: T, name: 'Acme' })) };
    const authTokenRepo = {
      update: jest.fn(async () => ({ affected: 0 })),
      save: jest.fn(async (t: any) => t),
      create: jest.fn((x: any) => x),
    };
    const mailService = { sendInvite: jest.fn(async () => ({ delivered: true })) };

    const service = new IamService(
      userRepo as any,
      tenantRepo as any,
      {} as any,
      {} as any,
      {} as any,
      authTokenRepo as any,
      {} as any,
      mailService as any,
    );

    return { service, users, userRepo };
  }

  function seed(users: Array<Record<string, any>>, over: Record<string, any>) {
    users.push({
      tenantId: T,
      email: `${over.id}@acme.test`,
      firstName: 'Layla',
      lastName: 'Rashid',
      roles: [PlatformRole.STAFF],
      attributes: {},
      status: UserStatus.ACTIVE,
      practitionerCredential: null,
      practitionerCredentialType: null,
      ...over,
    });
  }

  describe('inviteUser', () => {
    it('stores the credential the wizard collects', async () => {
      const { service, users } = build();
      await service.inviteUser(
        T,
        {
          email: 'agent@acme.test',
          role: PlatformRole.STAFF,
          practitionerCredential: '1234567',
          practitionerCredentialType: 'MARN',
        },
        undefined,
        [PlatformRole.FIRM_ADMIN],
      );

      expect(users[0].practitionerCredential).toBe('1234567');
      // Registry lowercased on write so `marn` and `MARN` are one value; the
      // NUMBER is left exactly as the register issues it.
      expect(users[0].practitionerCredentialType).toBe('marn');
    });

    it('invites an uncredentialed colleague with both fields null', async () => {
      const { service, users } = build();
      await service.inviteUser(
        T,
        { email: 'coordinator@acme.test' },
        undefined,
        [PlatformRole.FIRM_ADMIN],
      );

      expect(users[0].practitionerCredential).toBeNull();
      expect(users[0].practitionerCredentialType).toBeNull();
    });

    it('refuses a number with no register', async () => {
      // "1234567" alone is unattributable — a MARN, an OISC number and an RCIC
      // number are all seven-ish digits and mean different things.
      const { service } = build();
      await expect(
        service.inviteUser(
          T,
          { email: 'a@acme.test', practitionerCredential: '1234567' },
          undefined,
          [PlatformRole.FIRM_ADMIN],
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a register with no number', async () => {
      // The dangerous half: a practitioner register showing a row with "MARN"
      // and a blank number reads as "credentialed, we just did not write it
      // down" — unknown presented as settled (CLAUDE.md §5.2).
      const { service } = build();
      await expect(
        service.inviteUser(
          T,
          { email: 'a@acme.test', practitionerCredentialType: 'marn' },
          undefined,
          [PlatformRole.FIRM_ADMIN],
        ),
      ).rejects.toThrow(/both a number .* and the register/s);
    });
  });

  describe('updateUser', () => {
    it('lets a firm_admin record a credential against a colleague', async () => {
      const { service, users } = build();
      seed(users, { id: 'u1' });

      const result = await service.updateUser(
        T,
        'u1',
        { practitionerCredential: '7654321', practitionerCredentialType: 'marn' },
        ADMIN,
      );

      expect(users[0].practitionerCredential).toBe('7654321');
      expect(result.practitionerCredential).toBe('7654321');
    });

    it('refuses a non-admin editing their OWN credential', async () => {
      // Same ceiling as `role` and `status`, and for the same reason: the
      // credential is what a sign-off gate will check, so a user who could
      // write their own could self-authorise advice or lodgement.
      const { service, users } = build();
      seed(users, { id: 'u1' });

      await expect(
        service.updateUser(
          T,
          'u1',
          { practitionerCredential: '9999999', practitionerCredentialType: 'marn' },
          { id: 'u1', roles: [PlatformRole.STAFF] },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(users[0].practitionerCredential).toBeNull();
    });

    it('still lets a non-admin edit their own name', async () => {
      // The self-edit path every portal's ProfileView uses must not have been
      // narrowed by the guard above.
      const { service, users } = build();
      seed(users, { id: 'u1' });

      await service.updateUser(T, 'u1', { firstName: 'Layla-Anne' }, {
        id: 'u1',
        roles: [PlatformRole.STAFF],
      });
      expect(users[0].firstName).toBe('Layla-Anne');
    });

    it('clears both halves when the credential is removed', async () => {
      // A firm removing someone from its register removes the whole
      // credential, never leaving an orphaned registry name behind.
      const { service, users } = build();
      seed(users, {
        id: 'u1',
        practitionerCredential: '1234567',
        practitionerCredentialType: 'marn',
      });

      await service.updateUser(
        T,
        'u1',
        { practitionerCredential: '', practitionerCredentialType: '' },
        ADMIN,
      );

      expect(users[0].practitionerCredential).toBeNull();
      expect(users[0].practitionerCredentialType).toBeNull();
    });

    it('leaves the credential alone when the PATCH does not mention it', async () => {
      const { service, users } = build();
      seed(users, {
        id: 'u1',
        practitionerCredential: '1234567',
        practitionerCredentialType: 'marn',
      });

      await service.updateUser(T, 'u1', { firstName: 'Layla-Anne' }, ADMIN);
      expect(users[0].practitionerCredential).toBe('1234567');
    });

    it('does not let an admin blank the number while keeping the register', async () => {
      const { service, users } = build();
      seed(users, {
        id: 'u1',
        practitionerCredential: '1234567',
        practitionerCredentialType: 'marn',
      });

      await expect(
        service.updateUser(T, 'u1', { practitionerCredential: '' }, ADMIN),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(users[0].practitionerCredential).toBe('1234567');
    });
  });

  describe('what the directory projection claims', () => {
    it('reports the credential as NOT verified, explicitly', async () => {
      // The load-bearing negative. Nothing checks this number against OMARA,
      // OISC or CICC, and no adapter could — every regulator adapter is
      // sandbox (CLAUDE.md §13). Sending `false` rather than omitting the
      // field is the point: a UI forced to read it cannot accidentally render
      // a verified tick, whereas an absent field invites one.
      const { service, users } = build();
      seed(users, {
        id: 'u1',
        practitionerCredential: '1234567',
        practitionerCredentialType: 'marn',
      });

      const result = await service.getUser(T, 'u1');
      expect(result.practitionerCredentialVerified).toBe(false);
      expect(result.practitionerCredential).toBe('1234567');
      expect(result.practitionerCredentialType).toBe('marn');
    });

    it('reports nulls, not an empty string, for someone with no credential', async () => {
      const { service, users } = build();
      seed(users, { id: 'u1' });

      const result = await service.getUser(T, 'u1');
      expect(result.practitionerCredential).toBeNull();
      expect(result.practitionerCredentialType).toBeNull();
      expect(result.practitionerCredentialVerified).toBe(false);
    });
  });
});
