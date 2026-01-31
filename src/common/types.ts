import { EntityType } from '../crm/entities/universal-entity.entity';

export interface JwtPayload {
  sub: string;
  email: string;
  tenantId: string;
  roles: string[];
}

export interface UserPayload {
  id: string;
  email: string;
  tenantId: string;
  roles: string[];
}

export interface TenantInfo {
  id: string;
  slug: string;
  vertical: string;
}

export interface AuthenticatedUser extends UserPayload {
  tenant: TenantInfo;
}

export interface CreateUserInput {
  tenantSlug: string;
  email: string;
  password: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface CreateEntityInput {
  type: EntityType;
  firstName?: string;
  lastName?: string;
  email?: string;
  phoneNumber?: string;
  verticalAttributes?: Record<string, any>;
}
