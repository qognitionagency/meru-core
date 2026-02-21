import {
  Controller,
  Post,
  Body,
  UseGuards,
  Request,
  Get,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { IamService } from './iam.service';
import { PolicyGuard } from './guards/policy.guard';
import { Roles } from './decorators/roles.decorator';
import type { CreateUserInput } from '../common/types';

@Controller('auth')
@ApiTags('auth')
export class IamController {
  constructor(private iamService: IamService) {}

  @Post('login')
  @UseGuards(AuthGuard('local')) // Requires local.strategy.ts (omitted for brevity, standard impl)
  @ApiOperation({ summary: 'Login with email and password' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        email: { type: 'string', example: 'user@example.com' },
        password: { type: 'string', example: 'password123' },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Login successful' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async login(@Request() req) {
    return this.iamService.login(req.user);
  }

  @Get('profile')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @Roles('admin')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get user profile' })
  @ApiResponse({ status: 200, description: 'Profile retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  getProfile(@Request() req) {
    return req.user;
  }

  @Post('register')
  @ApiOperation({ summary: 'Register a new user' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        tenantSlug: { type: 'string', example: 'acme-immigration' },
        email: { type: 'string', example: 'user@example.com' },
        password: { type: 'string', example: 'password123' },
      },
      required: ['tenantSlug', 'email', 'password'],
    },
  })
  @ApiResponse({ status: 201, description: 'User registered successfully' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  async register(@Body() createUserDto: CreateUserInput) {
    return this.iamService.register(createUserDto);
  }
}
