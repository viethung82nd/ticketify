import type { CurrentUser } from '@ticketify/shared';
import type { User } from '../../generated/prisma/client';

/** Public projection of a user (never exposes `passwordHash`). */
export function toCurrentUser(user: User): CurrentUser {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    phone: user.phone,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
  };
}
