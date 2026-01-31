import { IsString, IsEmail, MinLength } from 'class-validator';
import { VerticalType } from '../enums/vertical.enum';

export class CreateUserDto {
  @IsString()
  tenantSlug: string; // Used to find tenant

  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;
}