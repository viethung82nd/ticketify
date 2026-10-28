import { Injectable, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Application } from 'express';
import { AppConfig } from './app-config.service';

/**
 * Applies `TRUST_PROXY` to Express, which decides where `req.ip` comes from.
 * A provider (not main.ts) so test apps get exactly the same behaviour.
 */
@Injectable()
export class TrustProxySetup implements OnModuleInit {
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    // Absent when the module runs as a plain application context (no HTTP server).
    const http = this.adapterHost.httpAdapter as HttpAdapterHost['httpAdapter'] | undefined;
    http?.getInstance<Application>().set('trust proxy', this.config.get('TRUST_PROXY'));
  }
}
