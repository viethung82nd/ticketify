import { Agent, request } from 'node:http';
import { performance } from 'node:perf_hooks';
import { SCENARIO_MAX_SOCKETS } from './hold-client';

/** One `GET /payments/vnpay/ipn` as the scenario saw it. */
export interface IpnOutcome {
  /** HTTP status; 0 when the request never got an answer (`networkError`). */
  status: number;
  /** `RspCode` of the JSON body VNPay would read. */
  rspCode?: string;
  message?: string;
  /** Wall time from sending the request to the end of the response body. */
  ms: number;
  networkError?: string;
}

interface IpnBody {
  RspCode?: unknown;
  Message?: unknown;
}

const stringOr = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/**
 * A plain `node:http` client for IPN bursts, the counterpart of `holdClient`: one keep-alive
 * agent, no supertest in between, so a request's time is the API's time plus the socket. VNPay
 * calls the IPN with a GET whose query carries the signed parameters.
 */
export function ipnClient(baseUrl: string, maxSockets = SCENARIO_MAX_SOCKETS) {
  const agent = new Agent({ keepAlive: true, maxSockets });

  function send(query: Record<string, string>): Promise<IpnOutcome> {
    const url = new URL('/payments/vnpay/ipn', baseUrl);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const started = performance.now();
    return new Promise((resolve) => {
      const req = request(
        url,
        { method: 'GET', agent, headers: { accept: 'application/json' } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const ms = performance.now() - started;
            let parsed: IpnBody = {};
            try {
              parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as IpnBody;
            } catch {
              // Not JSON: only the status is reported.
            }
            resolve({
              status: res.statusCode ?? 0,
              rspCode: stringOr(parsed.RspCode),
              message: stringOr(parsed.Message),
              ms,
            });
          });
          res.on('error', (error) =>
            resolve({ status: 0, ms: performance.now() - started, networkError: error.message }),
          );
        },
      );
      req.on('error', (error) =>
        resolve({ status: 0, ms: performance.now() - started, networkError: error.message }),
      );
      req.end();
    });
  }

  return { send, maxSockets, destroy: () => agent.destroy() };
}

/** `{ "200 00": 1, "200 02": 9 }`: how many answers of each kind. */
export function tallyIpn(outcomes: readonly IpnOutcome[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const outcome of outcomes) {
    const key =
      outcome.status === 0
        ? `network ${outcome.networkError ?? ''}`.trim()
        : `${outcome.status} ${outcome.rspCode ?? '-'}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}
