import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { DynamicModule } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AppConfig } from './app-config.service';
import { redactRequest } from './log-redaction';

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
        // The request line and query of the VNPay return URL and IPN carry vnp_SecureHash.
        serializers: { req: redactRequest },
        transport:
          config.get('NODE_ENV') === 'development'
            ? { target: 'pino-pretty', options: { singleLine: true } }
            : undefined,
      },
    }),
  });
}
