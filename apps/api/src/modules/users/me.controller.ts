import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { CurrentUser as CurrentUserView } from '@ticketify/shared';
import { type AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth()
@Controller('me')
export class MeController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOkResponse({ description: 'Profile of the authenticated user' })
  @ApiUnauthorizedResponse({ description: 'UNAUTHORIZED, TOKEN_EXPIRED or TOKEN_INVALID' })
  @ApiNotFoundResponse({ description: 'USER_NOT_FOUND: the account was deleted' })
  me(@CurrentUser() user: AuthUser): Promise<CurrentUserView> {
    return this.users.getProfile(user.id);
  }
}
