import { Injectable } from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';
import { AppConfig } from '../../config/app-config.service';

export const REFRESH_COOKIE = 'refresh_token';
/** The browser sends the cookie to /auth/* only (refresh, logout), never to the rest of the API. */
export const REFRESH_COOKIE_PATH = '/auth';

/** Reads and writes the httpOnly refresh-token cookie. */
@Injectable()
export class RefreshCookie {
  constructor(private readonly config: AppConfig) {}

  private get baseOptions(): CookieOptions {
    return {
      httpOnly: true,
      sameSite: 'strict',
      secure: this.config.isProduction,
      path: REFRESH_COOKIE_PATH,
    };
  }

  set(res: Response, token: string): void {
    res.cookie(REFRESH_COOKIE, token, {
      ...this.baseOptions,
      maxAge: this.config.get('REFRESH_TOKEN_TTL_SECONDS') * 1_000,
    });
  }

  clear(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, this.baseOptions);
  }

  read(req: Request): string | undefined {
    const value = (req.cookies as Record<string, unknown> | undefined)?.[REFRESH_COOKIE];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
}
