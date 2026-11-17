import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PolicyGuard } from '../iam/guards/policy.guard';
import { PlatformRole } from '../iam/enums/platform-role.enum';
import { AiController } from './ai.controller';

/**
 * Anton, second gate (HIGH, both):
 *
 * - `GET /ai/search` ranks EVERY embedding in the tenant
 *   (`AiService.semanticSearch` reads `{ tenantId }` alone) and returns the
 *   rows — so a `client` token could pull text derived from any applicant's
 *   records.
 * - `POST /ai/embeddings` lets the caller write rows into that same store,
 *   with a caller-chosen `resourceId`, which then surface in staff searches.
 *
 * Both are staff and above. No frontend calls either (meru-core-fe grepped).
 * `POST /ai/execute` stays open: the ImmiStack client portal's assistant
 * (`app/client/assistant`) calls it.
 */
describe('AI routes — client-role reach', () => {
  const guard = new PolicyGuard(new Reflector(), {} as any, {} as any);
  const as = (roles: string[], handler: (...a: any[]) => unknown) =>
    guard.canActivate({
      getHandler: () => handler,
      getClass: () => AiController,
      switchToHttp: () => ({ getRequest: () => ({ user: { id: 'u', roles } }) }),
    } as any);
  const p = AiController.prototype;

  it.each([
    ['GET /ai/search', p.semanticSearch],
    ['POST /ai/embeddings', p.createEmbedding],
  ])('%s refuses a client token and admits staff and firm_admin', async (_n, h) => {
    await expect(as([PlatformRole.CLIENT], h)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(as([PlatformRole.STAFF], h)).resolves.toBe(true);
    await expect(as([PlatformRole.FIRM_ADMIN], h)).resolves.toBe(true);
  });

  it('POST /ai/execute stays open to a client — the client-portal assistant uses it', async () => {
    await expect(as([PlatformRole.CLIENT], p.execute)).resolves.toBe(true);
  });
});
