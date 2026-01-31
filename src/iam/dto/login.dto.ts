import { IsEmail, IsString, MinLength } from 'class-validator';
import { LoginInput } from '../../common/types';

export class LoginDto implements LoginInput {
  @IsEmail({}, { message: 'Invalid email format' })
  email: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  password: string;
}
