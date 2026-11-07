import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Role } from '@ticketify/shared';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { AccessTokenIssuer } from '../../src/modules/auth/tokens/access-token.issuer';

/**
 * Creates a user with `role` and returns an access token for it, signed by the app itself.
 * Skips register/login (covered by auth.int-spec) and so the login rate limit.
 */
export async function accessTokenFor(
  app: INestApplication,
  prisma: PrismaClient,
  role: Role,
): Promise<string> {
  const id = await userIdWithRole(prisma, role);
  return app.get(AccessTokenIssuer).issue({ id, role }).token;
}

/**
 * Creates a user with `role` and returns its id, for a suite that must sign a **fresh** token per
 * call: a token lives 15 minutes on the app's clock, and a suite that moves a `FakeClock` past
 * that (the payment grace period, an expiry) would otherwise get `401 TOKEN_EXPIRED`.
 */
export async function userIdWithRole(prisma: PrismaClient, role: Role): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `${role.toLowerCase()}-${randomUUID()}@test.local`,
      passwordHash: 'not-a-real-hash',
      fullName: `Test ${role}`,
      role,
    },
  });
  return user.id;
}
