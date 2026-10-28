import { ApiProperty } from '@nestjs/swagger';
import { AUTH_LIMITS } from '@ticketify/shared';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, Length, MaxLength } from 'class-validator';
import { normalizeEmailValue } from '../../../common/dto/transforms';

/** Mirrors `loginRequestSchema` in @ticketify/shared. */
export class LoginDto {
  @ApiProperty({ example: 'an.nguyen@example.com' })
  @Transform(normalizeEmailValue)
  @IsEmail()
  @MaxLength(AUTH_LIMITS.emailMax)
  email: string;

  @ApiProperty()
  @IsString()
  @Length(1, AUTH_LIMITS.passwordMax)
  password: string;
}
