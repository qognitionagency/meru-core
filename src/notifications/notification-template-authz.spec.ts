import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PolicyGuard } from '../iam/guards/policy.guard';
import { PlatformRole } from '../iam/enums/platform-role.enum';
import { NotificationsController } from './notifications.controller';

/**
 * Anton, second gate (HIGH): `POST /notifications/templates` carried no
 * `@Roles`, so any token — a `client` included — could create a tenant
 * template, and `NotificationsService.resolveTemplate` prefers a tenant row
 * over the pack's template of the same key. A client could rewrite the
 * firm's own outbound mail (subject, body, links) on the next firm send.
 *
 * Writes: firm_admin and platform_admin. Reads: staff and above. There is
 * no PUT or DELETE on templates. Checked through the real PolicyGuard with
 * the route's own metadata, not by reading the decorator back alone.
 */
describe('notification templates — who may write and read', () => {
  const guard = new PolicyGuard(new Reflector(), {} as any, {} as any);
  // No tenantId on the user: the guard's vertical lookup is skipped, so
  // only the role decision is exercised.
  const as = (roles: string[], handler: (...a: any[]) => unknown) =>
    guard.canActivate({
      getHandler: () => handler,
      getClass: () => NotificationsController,
      switchToHttp: () => ({ getRequest: () => ({ user: { id: 'u', roles } }) }),
    } as any);
  const create = NotificationsController.prototype.createTemplate;
  const list = NotificationsController.prototype.getTemplates;

  it('refuses a client token on create', async () => {
    await expect(as([PlatformRole.CLIENT], create)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses staff on create — a template overrides the pack for the whole firm', async () => {
    await expect(as([PlatformRole.STAFF], create)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets firm_admin and platform_admin create', async () => {
    await expect(as([PlatformRole.FIRM_ADMIN], create)).resolves.toBe(true);
    await expect(as([PlatformRole.PLATFORM_ADMIN], create)).resolves.toBe(true);
  });

  it('refuses a client token on read; staff and above may read', async () => {
    await expect(as([PlatformRole.CLIENT], list)).rejects.toBeInstanceOf(ForbiddenException);
    for (const r of [PlatformRole.STAFF, PlatformRole.FIRM_ADMIN]) {
      await expect(as([r], list)).resolves.toBe(true);
    }
  });
});
