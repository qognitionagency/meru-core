import { Strategy } from 'passport-local';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { IamService } from '../iam.service';
import { UserPayload } from '../../common/types';

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  constructor(private iamService: IamService) {
    super({
      usernameField: 'email', // Use email as username
    });
  }

  async validate(email: string, password: string): Promise<UserPayload> {
    const user = await this.iamService.validateUser(email, password);
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return user;
  }
}

export class LocalAuthGuard extends AuthGuard('local') {}
