import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { AuthSession } from '@ticketify/shared';
import type { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RefreshCookie } from './refresh-cookie';

/**
 * Every route here is public: they authenticate with credentials or the refresh cookie,
 * not with an access token (which may be expired when refresh/logout are called).
 */
@ApiTags('auth')
@Public()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly cookie: RefreshCookie,
  ) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiCreatedResponse({ description: 'Account created and signed in; sets the refresh cookie' })
  @ApiConflictResponse({ description: 'EMAIL_TAKEN' })
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSession> {
    const { session, refreshToken } = await this.auth.register(dto);
    this.cookie.set(res, refreshToken);
    return session;
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ description: 'Signed in; sets the refresh cookie' })
  @ApiUnauthorizedResponse({ description: 'INVALID_CREDENTIALS' })
  @ApiTooManyRequestsResponse({ description: 'TOO_MANY_ATTEMPTS, details.retryAfterSeconds' })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSession> {
    const { session, refreshToken } = await this.auth.login(dto, req.ip ?? 'unknown');
    this.cookie.set(res, refreshToken);
    return session;
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ description: 'New access token; rotates the refresh cookie' })
  @ApiUnauthorizedResponse({
    description:
      'REFRESH_TOKEN_MISSING, REFRESH_TOKEN_INVALID, REFRESH_TOKEN_EXPIRED or ' +
      'REFRESH_TOKEN_REUSED (every session of the user is revoked)',
  })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSession> {
    const presented = this.cookie.read(req);
    try {
      const { session, refreshToken } = await this.auth.refresh(presented);
      this.cookie.set(res, refreshToken);
      return session;
    } catch (error) {
      // A rejected token is useless; stop the browser from sending it again.
      if (presented) this.cookie.clear(res);
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Always succeeds; revokes this session only' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(this.cookie.read(req));
    this.cookie.clear(res);
  }
}
