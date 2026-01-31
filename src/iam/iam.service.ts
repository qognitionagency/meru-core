import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { User } from './entities/user.entity';
import { Tenant } from './entities/tenant.entity';
import { AuthProvider } from './enums/auth-provider.enum';
import * as bcrypt from 'bcrypt';

@Injectable()
export class IamService {
  constructor(
    @InjectRepository(User) private userRepo: Repository<User>,
    @InjectRepository(Tenant) private tenantRepo: Repository<Tenant>,
    private jwtService: JwtService,
  ) {}

  async validateUser(email: string, password: string): Promise<any> {
    const user = await this.userRepo.findOne({ 
      where: { email },
      relations: ['tenant'] 
    });
    
    if (user && await bcrypt.compare(password, user.password)) {
      const { password, ...result } = user;
      return result;
    }
    return null;
  }

  async login(user: any) {
    const payload = { 
      email: user.email, 
      sub: user.id, 
      tenantId: user.tenantId,
      roles: user.roles
    };
    return {
      access_token: this.jwtService.sign(payload),
    };
  }

  async register(dto: any) {
    // Find Tenant
    const tenant = await this.tenantRepo.findOne({ where: { slug: dto.tenantSlug } });
    if (!tenant) throw new Error('Invalid Tenant Slug');

    const hashedPassword = await bcrypt.hash(dto.password, 10);
    const user = this.userRepo.create({
      email: dto.email,
      password: hashedPassword,
      tenantId: tenant.id,
      tenant: tenant,
      provider: AuthProvider.LOCAL,
    });
    return this.userRepo.save(user);
  }
}