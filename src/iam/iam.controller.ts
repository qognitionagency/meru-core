import { Controller, Post, Body, UseGuards, Request, Get } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { IamService } from './iam.service';
import { PolicyGuard } from './guards/policy.guard';
import { Roles } from './decorators/roles.decorator';

@Controller('auth')
export class IamController {
  constructor(private iamService: IamService) {}

  @Post('login')
  @UseGuards(AuthGuard('local')) // Requires local.strategy.ts (omitted for brevity, standard impl)
  async login(@Request() req) {
    return this.iamService.login(req.user);
  }

  @Get('profile')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @Roles('admin') // Example: Only admins can hit this
  getProfile(@Request() req) {
    return req.user;
  }
}