import { HttpStatus, Injectable } from '@nestjs/common';
import { AuthErrorCode, type CurrentUser } from '@ticketify/shared';
import { apiException } from '../../common/errors/api-error';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { toCurrentUser } from './user-view';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /** The profile behind a still-valid access token; `404` if the account was deleted since. */
  async getProfile(userId: string): Promise<CurrentUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw apiException(HttpStatus.NOT_FOUND, AuthErrorCode.USER_NOT_FOUND, 'User not found');
    }
    return toCurrentUser(user);
  }
}
