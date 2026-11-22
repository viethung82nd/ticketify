import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifyMomoSignature } from '../../src/modules/payment/momo/momo-signature';

/** One request the fake gateway received. */
export interface FakeMomoRequest {
  path: string;
  body: Record<string, unknown>;
  /** Whether its `signature` verified with the test credentials, as MoMo would check it. */
  signatureValid: boolean;
}

export interface FakeMomoReply {
  status?: number;
  body: Record<string, unknown>;
  /** Wait this long before answering (to make the client time out). */
  delayMs?: number;
}

export type FakeMomoHandler = (request: FakeMomoRequest) => FakeMomoReply;

/**
 * A stand-in for `https://test-payment.momo.vn` on a local port, for integration suites: the
 * API's real `fetch` reaches it over real HTTP. By default it behaves like MoMo for a correct
 * request — `create` answers `resultCode 0` with a `payUrl`, a badly signed request gets
 * `resultCode 13` (merchant authentication failed), and `query` answers whatever the test put in
 * `queryResults` for the order (1000, "waiting for the user", otherwise). A test overrides
 * `handler` for anything else.
 */
export class FakeMomo {
  readonly requests: FakeMomoRequest[] = [];
  /** `resultCode` (and extra fields) the query of an order answers with. */
  readonly queryResults = new Map<string, Record<string, unknown>>();
  handler: FakeMomoHandler | null = null;
  private server: Server | null = null;

  constructor(private readonly credentials: { accessKey: string; secretKey: string }) {}

  get url(): string {
    const address = this.server?.address() as AddressInfo | null;
    if (!address) throw new Error('FakeMomo is not listening');
    return `http://127.0.0.1:${address.port}`;
  }

  /** Requests to one path, oldest first. */
  calls(path: string): FakeMomoRequest[] {
    return this.requests.filter((request) => request.path === path);
  }

  reset(): void {
    this.requests.length = 0;
    this.queryResults.clear();
    this.handler = null;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void readJson(req).then((body) => {
        const path = req.url ?? '/';
        const message = path.endsWith('/create') ? 'create' : 'query';
        const request: FakeMomoRequest = {
          path,
          body,
          signatureValid: verifyMomoSignature(message, body, this.credentials),
        };
        this.requests.push(request);
        const reply = (this.handler ?? ((r) => this.defaultReply(r)))(request);
        const send = () => {
          if (res.destroyed) return;
          res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(reply.body));
        };
        if (reply.delayMs) setTimeout(send, reply.delayMs);
        else send();
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  /** What MoMo answers a create call that went through. */
  created(request: FakeMomoRequest, overrides: Record<string, unknown> = {}): FakeMomoReply {
    const { body } = request;
    return {
      body: {
        partnerCode: body.partnerCode,
        orderId: body.orderId,
        requestId: body.requestId,
        amount: body.amount,
        responseTime: 1_793_534_700_000,
        message: 'Thành công.',
        resultCode: 0,
        payUrl: `https://test-payment.momo.vn/v2/gateway/pay?t=${String(body.orderId)}`,
        ...overrides,
      },
    };
  }

  private defaultReply(request: FakeMomoRequest): FakeMomoReply {
    const { body } = request;
    if (!request.signatureValid) {
      return {
        status: 400,
        body: { ...body, resultCode: 13, message: 'Merchant authentication failed' },
      };
    }
    if (request.path.endsWith('/create')) return this.created(request);
    const result = this.queryResults.get(String(body.orderId)) ?? { resultCode: 1000 };
    return {
      body: {
        partnerCode: body.partnerCode,
        orderId: body.orderId,
        requestId: body.requestId,
        extraData: '',
        amount: 0,
        transId: 0,
        payType: '',
        message: '',
        responseTime: 1_793_534_700_000,
        lastUpdated: 1_793_534_700_000,
        ...result,
      },
    };
  }
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
  });
}
