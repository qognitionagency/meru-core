import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PolicyGuard } from '../iam/guards/policy.guard';
import { PlatformRole } from '../iam/enums/platform-role.enum';
import { IntegrationsController } from './integrations.controller';

/**
 * Anton, second gate: routes with no `@Roles` let any token through, a
 * `client`'s included.
 *
 * - Filing a Suspicious Transaction Report with a regulator, booking or
 *   editing a trade instrument, and changing the vessel watchlist are staff
 *   work: staff and above. A tenant whose module grant predates the GRC
 *   vocabulary passes `ModuleEntitlementGuard` ungated (by design), so the
 *   role is the only thing that kept an ImmiStack client out of these writes.
 * - The READS stay open, deliberately, for now: GovernanceX shows meru-core's
 *   `client` role as its `VIEWER` user (governancex/lib/api/services/
 *   users.service.ts), so gating them would cut every GovX viewer off the
 *   vessel and trade screens. An open product decision, recorded in
 *   AGENTS.md §8.1 — this spec pins today's answer so a change is deliberate.
 */
describe('integrations — client-role reach', () => {
  const guard = new PolicyGuard(new Reflector(), {} as any, {} as any);
  const as = (roles: string[], handler: (...a: any[]) => unknown) =>
    guard.canActivate({
      getHandler: () => handler,
      getClass: () => IntegrationsController,
      switchToHttp: () => ({ getRequest: () => ({ user: { id: 'u', roles } }) }),
    } as any);
  const p = IntegrationsController.prototype;

  it.each([
    ['POST /integrations/ae/str', p.aeFileSTR],
    ['POST /integrations/sa/str', p.saFileSTR],
    ['POST /integrations/qa/str', p.qaFileSTR],
    ['POST /integrations/bh/str', p.bhFileSTR],
    ['POST /integrations/trade', p.createTrade],
    ['PATCH /integrations/trade/:id', p.updateTrade],
    ['PUT /integrations/trade/:id', p.replaceTrade],
    ['POST /integrations/vessel/watchlist', p.addVessel],
    ['DELETE /integrations/vessel/watchlist/:id', p.removeVessel],
  ])('%s refuses a client token and admits staff and firm_admin', async (_n, h) => {
    await expect(as([PlatformRole.CLIENT], h)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(as([PlatformRole.STAFF], h)).resolves.toBe(true);
    await expect(as([PlatformRole.FIRM_ADMIN], h)).resolves.toBe(true);
  });

  it.each([
    ['GET /integrations/vessel', p.listVessels],
    ['GET /integrations/vessel/alerts', p.listVesselAlerts],
    ['GET /integrations/trade', p.listTrade],
    ['GET /integrations/trade/:id', p.getTrade],
  ])('%s stays open to a client token (GovX VIEWER) — open product decision', async (_n, h) => {
    await expect(as([PlatformRole.CLIENT], h)).resolves.toBe(true);
  });
});
