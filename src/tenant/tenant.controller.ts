import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  UseGuards,
  Request,
  Param,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiBody,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { TenantSettingsService } from './tenant-settings.service';
import type { VerticalConfig } from './entities/tenant-setting.entity';
import { PolicyGuard } from '../iam/guards/policy.guard';
import { Roles } from '../iam/decorators/roles.decorator';

@Controller('tenant/settings')
@ApiTags('tenant')
export class TenantController {
  constructor(private tenantSettingsService: TenantSettingsService) {}

  @Get()
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get tenant settings' })
  @ApiResponse({ status: 200, description: 'Settings retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getSettings(@Request() req) {
    return this.tenantSettingsService.getSettings(req.user.tenantId);
  }

  @Post()
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @Roles('admin')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Create/update tenant settings' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        vertical: { type: 'string', enum: ['immigration', 'grc', 'labour'] },
        entityName: { type: 'string', example: 'Client' },
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              type: {
                type: 'string',
                enum: ['text', 'number', 'date', 'select'],
              },
              label: { type: 'string' },
              required: { type: 'boolean' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Settings saved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async updateSettings(@Request() req, @Body() config: VerticalConfig) {
    return this.tenantSettingsService.updateSettings(req.user.tenantId, config);
  }
}
