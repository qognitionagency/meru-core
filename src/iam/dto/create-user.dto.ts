import { IsString, IsEmail, MinLength } from 'class-validator';
import { CreateUserInput } from '../../common/types';

export class CreateUserDto implements CreateUserInput {
  @IsString()
  tenantSlug: string; // Used to find tenant

  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;
}
