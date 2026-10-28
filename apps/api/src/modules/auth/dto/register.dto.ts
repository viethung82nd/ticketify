import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AUTH_LIMITS, PHONE_PATTERN } from '@ticketify/shared';
import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { normalizeEmailValue, trimValue } from '../../../common/dto/transforms';

/** Mirrors `registerRequestSchema` in @ticketify/shared. */
export class RegisterDto {
  @ApiProperty({ example: 'an.nguyen@example.com' })
  @Transform(normalizeEmailValue)
  @IsEmail()
  @MaxLength(AUTH_LIMITS.emailMax)
  email: string;

  @ApiProperty({ minLength: AUTH_LIMITS.passwordMin, maxLength: AUTH_LIMITS.passwordMax })
  @IsString()
  @Length(AUTH_LIMITS.passwordMin, AUTH_LIMITS.passwordMax)
  password: string;

  @ApiProperty({ example: 'Nguyễn Văn An' })
  @Transform(trimValue)
  @IsString()
  @Length(1, AUTH_LIMITS.fullNameMax)
  fullName: string;

  @ApiPropertyOptional({ example: '0912345678' })
  @Transform(trimValue)
  @IsOptional()
  @Matches(PHONE_PATTERN)
  phone?: string;
}
