import { APP_INTERCEPTOR } from '@nestjs/core';
import { IamModule } from './iam.module';
import { AuthAttemptLimiter } from './services/auth-attempt-limiter.service';
import { MfaAttemptLimitInterceptor } from './interceptors/mfa-attempt-limit.interceptor';

/**
 * The MFA attempt limit is a global interceptor acting on two handlers. If
 * its registration is dropped nothing else fails: the routes keep working,
 * unlimited. This pins it.
 */
describe('IamModule — attempt-limit wiring', () => {
  const providers: any[] = Reflect.getMetadata('providers', IamModule);

  it('provides the limiter', () => {
    expect(providers).toContain(AuthAttemptLimiter);
  });

  it('registers the MFA attempt-limit interceptor globally', () => {
    expect(providers).toContainEqual({
      provide: APP_INTERCEPTOR,
      useClass: MfaAttemptLimitInterceptor,
    });
  });
});
