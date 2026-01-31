import {
  Controller,
  Post,
  Body,
  UseGuards,
  Request,
  Get,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CrmService } from './crm.service';
import { CreateEntityDto } from './dto/create-entity.dto';
import { PolicyGuard } from '../iam/guards/policy.guard'; // Use our Context-Aware Guard

@Controller('crm')
export class CrmController {
  constructor(private crmService: CrmService) {}

  @Post('entities')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  createEntity(@Request() req, @Body() dto: CreateEntityDto) {
    // req.user comes from JWT (has tenantId and vertical)
    return this.crmService.createEntity(req.user.tenantId, dto);
  }

  @Get('entities')
  @UseGuards(AuthGuard('jwt'), PolicyGuard)
  getEntities(@Request() req) {
    // Return entities for the user's tenant
    return this.crmService.getEntitiesByTenant(req.user.tenantId);
  }
}
