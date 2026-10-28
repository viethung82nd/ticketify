import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AppConfig } from './config/app-config.service';
import { setupRealtime } from './modules/realtime/realtime-io.adapter';
import { setupSwagger } from './swagger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  const config = app.get(AppConfig);
  app.enableCors({ origin: config.get('CORS_ORIGINS'), credentials: true });
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
