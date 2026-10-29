import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { DynamicModule } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import type { Options } from 'pino-http';
import { AppConfig } from './app-config.service';
import { redactRequest } from './log-redaction';

/**
 * Where pino writes. `null`, the default, is stdout (or pino-pretty in development); a test that
 * reads the log lines overrides it with its own stream (`payment-logs.int-spec.ts`).
 */
export const LOG_DESTINATION = Symbol('LOG_DESTINATION');

const requestIdFrom = (req: IncomingMessage): string => {
  const header = req.headers['x-request-id'];
  return typeof header === 'string' && header.length > 0 && header.length <= 128
    ? header
    : randomUUID();
};

/** Pino logger shared by the API and the worker (the HTTP options only apply to the API). */
export function pinoLoggerModule(): DynamicModule {
  return LoggerModule.forRootAsync({
    providers: [{ provide: LOG_DESTINATION, useValue: null }],
    inject: [AppConfig, LOG_DESTINATION],
    useFactory: (config: AppConfig, destination: DestinationStream | null) => {
      const options: Options = {
        level: config.get('LOG_LEVEL'),
        genReqId: requestIdFrom,
        redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        // The request line and query of the VNPay return URL and IPN carry vnp_SecureHash.
        serializers: { req: redactRequest },
        // pino takes a transport or a destination, never both.
        transport:
          config.get('NODE_ENV') === 'development' && !destination
            ? { target: 'pino-pretty', options: { singleLine: true } }
            : undefined,
      };
      return { pinoHttp: destination ? [options, destination] : options };
    },
  });
}
