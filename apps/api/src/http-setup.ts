import type { INestApplication } from '@nestjs/common';
import helmet from 'helmet';
import type { AppConfig } from './config/app-config.service';

/**
 * HTTP-level protections of the API process (PLAN §11, ROADMAP 6.5), in one place so main.ts and
 * the integration test that checks them apply exactly the same thing.
 *
 * - helmet with its defaults: no `X-Powered-By`, `X-Content-Type-Options: nosniff`, a strict
 *   `Content-Security-Policy` (`default-src 'self'`; Swagger UI at /docs only loads its own
 *   scripts and inline styles, which the default allows), `Strict-Transport-Security` (ignored by
 *   browsers over plain http, so harmless locally), frame and referrer protections. The web app
 *   is served from another origin; it reads this API with CORS fetches, which
 *   `Cross-Origin-Resource-Policy` does not restrict.
 * - CORS: only CORS_ORIGINS, with credentials (the refresh cookie). `Date` is exposed so the web
 *   can anchor countdowns to the server clock (ROADMAP 2.13).
 */
export function configureHttp(app: INestApplication, config: AppConfig): void {
  app.use(helmet());
  app.enableCors({
    origin: config.get('CORS_ORIGINS'),
    credentials: true,
    exposedHeaders: ['Date'],
  });
}
