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
import { CrmService } from './crm.service';
import { CreateEntityDto } from './dto/create-entity.dto';
import { PolicyGuard } from '../iam/guards/policy.guard'; // Use our Context-Aware Guard

@Controller('crm')
@ApiTags('crm')
export class CrmController {
  constructor(private crmService: CrmService) {}

  @Post('entities')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Create a new CRM entity' })
  @ApiBody({ type: CreateEntityDto })
  @ApiResponse({ status: 201, description: 'Entity created successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  createEntity(@Request() req, @Body() dto: CreateEntityDto) {
    // req.user comes from JWT (has tenantId and vertical)
    return this.crmService.createEntity(req.user.tenantId, dto);
  }

  @Get('entities')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get all CRM entities for the tenant' })
  @ApiResponse({ status: 200, description: 'Entities retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  getEntities(@Request() req) {
    // Return entities for the user's tenant
    return this.crmService.getEntitiesByTenant(req.user.tenantId);
  }
}
