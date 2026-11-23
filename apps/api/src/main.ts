import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AppConfig } from './config/app-config.service';
import { configureHttp } from './http-setup';
import { setupRealtime } from './modules/realtime/realtime-io.adapter';
import { setupSwagger } from './swagger';

async function bootstrap(): Promise<void> {
  // rawBody: SePay's webhook signature covers the body bytes as received (req.rawBody), not a
  // re-serialized JSON. The parsed body is unchanged for every other route.
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });
  app.useLogger(app.get(Logger));

  const config = app.get(AppConfig);
  // helmet + CORS (ROADMAP 6.5), shared with the integration test that checks the headers.
  configureHttp(app, config);
  // Socket.IO on the same HTTP server: Redis adapter, CORS_ORIGINS (ROADMAP 2.11).
  await setupRealtime(app);
  app.enableShutdownHooks();
  setupSwagger(app);

  await app.listen(config.get('PORT'));
}

bootstrap().catch((error: unknown) => {
  // The Nest logger may not exist yet (e.g. invalid env), so print plainly and exit.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
