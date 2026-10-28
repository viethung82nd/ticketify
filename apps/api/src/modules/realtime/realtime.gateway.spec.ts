import { Logger } from '@nestjs/common';
import {
  AuthErrorCode,
  type JoinShowtimeAck,
  REALTIME_LIMITS,
  RealtimeErrorCode,
  Role,
  showtimeRoom,
} from '@ticketify/shared';
import type { Redis } from 'ioredis';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { FakeRedis } from '../../common/rate-limit/testing/fake-redis';
import { testConfig } from '../../config/testing/test-config';
import { FakeClock } from '../../infra/clock/testing/fake-clock';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import { AccessTokenIssuer } from '../auth/tokens/access-token.issuer';
import { AccessTokenVerifier } from '../auth/tokens/access-token.verifier';
import { isAllowedOrigin } from './realtime-io.adapter';
import { joinRateKey, RealtimeGateway, type RealtimeSocket } from './realtime.gateway';

const USER = { id: '01a17e75-7100-7679-b8b1-000000000001', role: Role.USER };
const showtimeId = (n: number) => `01a17e75-7100-7679-b8b1-${String(n).padStart(12, '0')}`;
const CANCELLED = showtimeId(900);
const UNKNOWN = showtimeId(901);

/** The parts of a Socket.IO socket the gateway touches. */
function fakeSocket(auth: Record<string, unknown> = {}) {
  const rooms = new Set<string>(['socket-id']);
  const emitted: [string, unknown][] = [];
  const socket = {
    handshake: { auth },
    data: {},
    rooms,
    join: (room: string) => {
      rooms.add(room);
      return Promise.resolve();
    },
    leave: (room: string) => {
      rooms.delete(room);
      return Promise.resolve();
    },
    emit: (event: string, payload: unknown) => emitted.push([event, payload]),
  };
  return { socket: socket as unknown as RealtimeSocket, rooms, emitted };
}

describe('RealtimeGateway', () => {
  const config = testConfig();
  let clock: FakeClock;
  let redis: FakeRedis;
  let findUnique: jest.Mock;
  let gateway: RealtimeGateway;

  beforeEach(() => {
    clock = new FakeClock('2026-11-02T03:00:00.000Z');
    redis = new FakeRedis();
    findUnique = jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(
        where.id === UNKNOWN
          ? null
          : { status: where.id === CANCELLED ? 'CANCELLED' : 'SCHEDULED' },
      ),
    );
    gateway = new RealtimeGateway(
      new AccessTokenVerifier(config, clock),
      { showtime: { findUnique } } as unknown as PrismaService,
      new RateLimitService(redis as unknown as Redis),
    );
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  const token = () => new AccessTokenIssuer(config, clock).issue(USER).token;

  function connected() {
    const fake = fakeSocket({ token: token() });
    expect(gateway.authenticate(fake.socket)).toBeUndefined();
    return fake;
  }

  describe('handshake', () => {
    it('lets a valid access token in and keeps the user on the socket', () => {
      const { socket } = connected();

      expect(socket.data.user).toEqual(USER);
      expect(socket.data.showtimes.size).toBe(0);
    });

    it.each([
      ['no auth payload', {}],
      ['an empty token', { token: '' }],
      ['a token that is not a string', { token: 42 }],
    ])('refuses %s with UNAUTHORIZED', (_label, auth) => {
      const error = gateway.authenticate(fakeSocket(auth).socket);

      expect(error?.message).toBe(AuthErrorCode.UNAUTHORIZED);
      expect(error?.data).toEqual({
        code: AuthErrorCode.UNAUTHORIZED,
        message: 'Authentication required',
      });
    });

    it('refuses an expired token with TOKEN_EXPIRED (the client refreshes, then reconnects)', () => {
      const expired = token();
      clock.advance({ hours: 1 });

      expect(gateway.authenticate(fakeSocket({ token: expired }).socket)?.message).toBe(
        AuthErrorCode.TOKEN_EXPIRED,
      );
    });

    it('refuses a forged token with TOKEN_INVALID', () => {
      const forged = `${token().slice(0, -4)}AAAA`;

      expect(gateway.authenticate(fakeSocket({ token: forged }).socket)?.message).toBe(
        AuthErrorCode.TOKEN_INVALID,
      );
    });
  });

  describe('showtime:join', () => {
    it('joins room showtime:{id} and acks { joined: true }', async () => {
      const { socket, rooms, emitted } = connected();

      await expect(gateway.join(socket, { showtimeId: showtimeId(1) })).resolves.toEqual({
        joined: true,
      });
      expect(rooms.has(showtimeRoom(showtimeId(1)))).toBe(true);
      expect(emitted).toEqual([]);
    });

    it.each([
      ['no body', undefined],
      ['a missing id', {}],
      ['an id that is not a UUID', { showtimeId: 'abc' }],
    ])('%s → VALIDATION_FAILED in the ack and as an error event, no query', async (_l, body) => {
      const { socket, emitted } = connected();

      const ack = await gateway.join(socket, body);

      expect(ack).toMatchObject({
        joined: false,
        error: { event: 'showtime:join', code: 'VALIDATION_FAILED' },
      });
      expect(emitted).toEqual([['error', (ack as { error: unknown }).error]]);
      expect(findUnique).not.toHaveBeenCalled();
    });

    it.each([
      ['unknown', UNKNOWN],
      ['cancelled', CANCELLED],
    ])('an %s showtime → SHOWTIME_NOT_FOUND, not joined', async (_l, id) => {
      const { socket, rooms, emitted } = connected();

      const ack = await gateway.join(socket, { showtimeId: id });

      expect(ack).toMatchObject({ joined: false, error: { code: 'SHOWTIME_NOT_FOUND' } });
      expect(emitted.map(([event]) => event)).toEqual(['error']);
      expect(rooms.has(showtimeRoom(id))).toBe(false);
      expect(socket.data.showtimes.size).toBe(0);
    });

    it('allows 5 showtimes per socket; the 6th is TOO_MANY_SUBSCRIPTIONS until one is left', async () => {
      const { socket } = connected();
      for (let n = 1; n <= REALTIME_LIMITS.subscriptionsMax; n++) {
        await expect(gateway.join(socket, { showtimeId: showtimeId(n) })).resolves.toEqual({
          joined: true,
        });
      }

      await expect(gateway.join(socket, { showtimeId: showtimeId(6) })).resolves.toMatchObject({
        joined: false,
        error: { code: RealtimeErrorCode.TOO_MANY_SUBSCRIPTIONS },
      });
      // Joining one already joined is not a new subscription.
      await expect(gateway.join(socket, { showtimeId: showtimeId(1) })).resolves.toEqual({
        joined: true,
      });

      await expect(gateway.leave(socket, { showtimeId: showtimeId(1) })).resolves.toEqual({
        left: true,
      });
      await expect(gateway.join(socket, { showtimeId: showtimeId(6) })).resolves.toEqual({
        joined: true,
      });
    });

    it('concurrent joins on one socket cannot pass the limit together', async () => {
      const { socket } = connected();

      const acks = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          gateway.join(socket, { showtimeId: showtimeId(i + 1) }),
        ),
      );

      expect(acks.filter((ack) => ack.joined)).toHaveLength(REALTIME_LIMITS.subscriptionsMax);
    });

    it('a failed lookup is not left counted as a subscription', async () => {
      const { socket } = connected();
      findUnique.mockRejectedValueOnce(new Error('database down'));

      await expect(gateway.join(socket, { showtimeId: showtimeId(1) })).resolves.toMatchObject({
        joined: false,
        error: { code: 'INTERNAL_ERROR' },
      });
      expect(socket.data.showtimes.size).toBe(0);
    });

    it(`rate limit: ${REALTIME_LIMITS.joinsMax} joins per user per minute, then TOO_MANY_ATTEMPTS`, async () => {
      const { socket } = connected();
      const results: JoinShowtimeAck[] = [];
      for (let i = 0; i <= REALTIME_LIMITS.joinsMax; i++) {
        results.push(await gateway.join(socket, { showtimeId: showtimeId(1) }));
      }

      expect(results.slice(0, -1).every((ack) => ack.joined)).toBe(true);
      expect(results.at(-1)).toMatchObject({
        joined: false,
        error: {
          code: 'TOO_MANY_ATTEMPTS',
          details: { retryAfterSeconds: REALTIME_LIMITS.joinWindowSeconds },
        },
      });
      expect(redis.values.get(joinRateKey(USER.id))).toBe(REALTIME_LIMITS.joinsMax + 1);
    });
  });

  describe('showtime:leave', () => {
    it('an invalid id → VALIDATION_FAILED', async () => {
      const { socket, emitted } = connected();

      await expect(gateway.leave(socket, { showtimeId: 'x' })).resolves.toMatchObject({
        left: false,
        error: { code: 'VALIDATION_FAILED' },
      });
      expect(emitted.map(([event]) => event)).toEqual(['error']);
    });
  });
});

describe('isAllowedOrigin', () => {
  const origins = ['http://localhost:5173'];

  it.each([
    [undefined, true],
    ['http://localhost:5173', true],
    ['http://127.0.0.1:5173', false],
    ['https://evil.example', false],
  ])('%s → %s', (origin, allowed) => {
    expect(isAllowedOrigin(origin, origins)).toBe(allowed);
  });
});
