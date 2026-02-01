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
  @Roles('admin') // Example: Only admins can hit this
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get user profile' })
  @ApiResponse({ status: 200, description: 'Profile retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  getProfile(@Request() req) {
    return req.user;
  }
}
