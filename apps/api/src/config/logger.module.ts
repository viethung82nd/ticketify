import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { DynamicModule } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AppConfig } from './app-config.service';

const requestIdFrom = (req: IncomingMessage): string => {
  const header = req.headers['x-request-id'];
  return typeof header === 'string' && header.length > 0 && header.length <= 128
    ? header
    : randomUUID();
};

/** Pino logger shared by the API and the worker (the HTTP options only apply to the API). */
export function pinoLoggerModule(): DynamicModule {
  return LoggerModule.forRootAsync({
    inject: [AppConfig],
    useFactory: (config: AppConfig) => ({
      pinoHttp: {
        level: config.get('LOG_LEVEL'),
        genReqId: requestIdFrom,
        redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        transport:
          config.get('NODE_ENV') === 'development'
            ? { target: 'pino-pretty', options: { singleLine: true } }
            : undefined,
      },
    }),
  });
}
