import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { UserPayload } from '../../common/types';

/**
 * Refuse an impersonation token on routes that belong to the account holder
 * alone: their second factor, their device list, and signing them out.
 *
 * An impersonation token (`imp` claim, `IamService.issueImpersonationToken`)
 * acts as the tenant's first active user so an operator can see what that
 * user sees. It is for diagnosis. Enrolling or removing someone's MFA,
 * reading their IPs and devices, or revoking their sessions is not diagnosis
 * — and to the user it is indistinguishable from an account takeover.
 *
 * Reads `impersonatedBy`, which `JwtStrategy.validate` sets only from the
 * signed `imp` claim, never from request input. Must be listed AFTER
 * `AuthGuard('jwt')` so `req.user` exists; with no user it fails closed.
 *
 * 403 (`MER-AUTH-0008`), not 404: the route exists and the caller knows it;
 * the refusal is about the credential, not the resource.
 */
@Injectable()
export class NoImpersonationGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest().user as
      | UserPayload
      | undefined;

    if (!user) throw new ForbiddenException('Unauthorized');

    if (user.impersonatedBy) {
      throw new ForbiddenException(
        'Not available to an impersonation session: this action belongs to ' +
          'the account holder.',
      );
    }
    return true;
  }
}
