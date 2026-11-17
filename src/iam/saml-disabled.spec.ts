import { NotImplementedException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SamlService } from './services/saml.service';

/**
 * SAML SSO is disabled, unconditionally, until it is rebuilt on a maintained
 * library. Anton confirmed (2026-11) that the hand-rolled verifier is unsound
 * even WITH a certificate configured:
 *
 *  · `verifySignature` checks that SignatureValue signs *some* SignedInfo but
 *    never binds a Reference/DigestValue to the assertion and does no
 *    canonicalisation — classic XML signature wrapping.
 *  · With no `ssoConfig.cert`, the assertion was accepted unsigned after a
 *    single `logger.warn`.
 *  · `InResponseTo`, `StatusCode` and `Audience` are regex-read element text a
 *    forged document can supply; Audience and the validity window are optional.
 *  · Locked and inactive users got tokens; absent users were JIT-provisioned
 *    from an attacker-chosen email.
 *
 * There is deliberately no `SAML_ENABLED` flag: a flag would re-enable exactly
 * this verifier. Re-enable only on `@node-saml/node-saml` with signed
 * assertions required, Audience required, persisted pending state, a user
 * status check, and tokens from `IamService.issueSession`.
 */
describe('SamlService — disabled pending a library-backed implementation', () => {
  function build() {
    const jwtService = { sign: jest.fn(() => 'signed') };
    const tenantRepo = { findOne: jest.fn() };
    const userRepo = { findOne: jest.fn(), create: jest.fn(), save: jest.fn() };
    const config = { get: jest.fn(() => undefined) };
    const saml = new SamlService(
      config as any,
      jwtService as any,
      tenantRepo as any,
      userRepo as any,
    );
    return { saml, jwtService, tenantRepo, userRepo };
  }

  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

  it('handleCallback refuses any SAMLResponse with 501 and signs nothing', async () => {
    const { saml, jwtService, tenantRepo, userRepo } = build();
    const forged =
      '<samlp:Response InResponseTo="_x"><samlp:StatusCode Value="Success"/>' +
      '<saml:Attribute Name="email"><saml:AttributeValue>a@example.test' +
      '</saml:AttributeValue></saml:Attribute></samlp:Response>';
    await expect(
      saml.handleCallback(b64(forged), ''),
    ).rejects.toBeInstanceOf(NotImplementedException);
    expect(jwtService.sign).not.toHaveBeenCalled();
    expect(tenantRepo.findOne).not.toHaveBeenCalled();
    expect(userRepo.findOne).not.toHaveBeenCalled();
  });

  it('initiateLogin refuses with 501 before looking up any tenant', async () => {
    const { saml, tenantRepo } = build();
    await expect(saml.initiateLogin('any-slug')).rejects.toBeInstanceOf(
      NotImplementedException,
    );
    expect(tenantRepo.findOne).not.toHaveBeenCalled();
  });

  it('the no-certificate branch fails closed rather than warning and continuing', () => {
    const src = readFileSync(
      join(__dirname, 'services', 'saml.service.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/logger\.warn\([^)]*no cert configured/);
    expect(src).toMatch(/SAML signature verification is required/);
  });
});
