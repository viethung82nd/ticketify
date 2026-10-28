import { randomUUID } from 'node:crypto';
import { Agent, request } from 'node:http';
import { performance } from 'node:perf_hooks';

/**
 * Sockets the client keeps open at most. Windows caps a listening socket's backlog near 200, so a
 * larger burst there ends in connection resets; Linux takes 500 at once (Node's backlog is 511).
 * `SCENARIO_MAX_SOCKETS` overrides it.
 */
export const SCENARIO_MAX_SOCKETS = Number(
  process.env.SCENARIO_MAX_SOCKETS ?? (process.platform === 'win32' ? 200 : 500),
);

export interface HoldBody {
  showtimeId: string;
  seatIds: string[];
}

/** One `POST /bookings` as the scenario saw it. */
export interface HoldOutcome {
  /** HTTP status; 0 when the request never got an answer (`networkError`). */
  status: number;
  /** `code` of an error body. */
  code?: string;
  /** Booking id and holdUntil of a 201/200. */
  bookingId?: string;
  holdUntil?: string;
  /** Wall time from sending the request to the end of the response body. */
  ms: number;
  networkError?: string;
}

interface ResponseBody {
  code?: unknown;
  id?: unknown;
  holdUntil?: unknown;
}

const stringOr = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/**
 * A plain `node:http` client for scenario bursts: one keep-alive agent, no supertest in between,
 * so a request's time is the API's time plus the socket.
 */
export function holdClient(baseUrl: string, maxSockets = SCENARIO_MAX_SOCKETS) {
  const agent = new Agent({ keepAlive: true, maxSockets });
  const url = new URL('/bookings', baseUrl);

  function hold(token: string, body: HoldBody): Promise<HoldOutcome> {
    const payload = JSON.stringify(body);
    const started = performance.now();
    return new Promise((resolve) => {
      const req = request(
        url,
        {
          method: 'POST',
          agent,
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
            'idempotency-key': randomUUID(),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const ms = performance.now() - started;
            let parsed: ResponseBody = {};
            try {
              parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ResponseBody;
            } catch {
              // Not JSON: only the status is reported.
            }
            resolve({
              status: res.statusCode ?? 0,
              code: stringOr(parsed.code),
              bookingId: stringOr(parsed.id),
              holdUntil: stringOr(parsed.holdUntil),
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
      req.end(payload);
    });
  }

  return { hold, maxSockets, destroy: () => agent.destroy() };
}

export type HoldClient = ReturnType<typeof holdClient>;
