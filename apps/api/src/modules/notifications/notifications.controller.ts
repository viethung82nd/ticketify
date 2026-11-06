import { Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Notification, NotificationPage, NotificationsRead } from '@ticketify/shared';
import { type AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { validationFailed } from '../../common/errors/api-error';
import { MyNotificationsQueryDto } from './dto/my-notifications-query.dto';
import { NotificationsService } from './notifications.service';

/** A malformed id is a format error like any other: `400 VALIDATION_FAILED`. */
function notificationId(): ParseUUIDPipe {
  return new ParseUUIDPipe({
    exceptionFactory: () => validationFailed([{ field: 'id', messages: ['id must be a UUID'] }]),
  });
}

/**
 * The signed-in user's own notifications (ROADMAP 4.2). Written by the worker when it delivers an
 * outbox event; new ones also arrive over the socket (`notification:new`, room `user:{id}`), but
 * this list is the source of truth and what a client reloads when it reconnects.
 */
@ApiTags('notifications')
@ApiBearerAuth()
@Controller('me/notifications')
export class MyNotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOkResponse({
    description:
      "The user's notifications, newest first. `unreadCount` counts every unread one, not " +
      'only those on this page, so a bell can show it without a second request',
  })
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED: unread, page or pageSize (1–50)' })
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: MyNotificationsQueryDto,
  ): Promise<NotificationPage> {
    return this.notifications.listOfUser(user.id, query);
  }

  @Post('read')
  @ApiOkResponse({
    description: 'Marks every unread notification of the user read; `updated` is how many changed',
  })
  readAll(@CurrentUser() user: AuthUser): Promise<NotificationsRead> {
    return this.notifications.markAllRead(user.id);
  }

  @Post(':id/read')
  @ApiOkResponse({
    description: 'The notification, now read. One that was already read is returned unchanged',
  })
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED: id is not a UUID' })
  @ApiNotFoundResponse({
    description: "NOTIFICATION_NOT_FOUND: no such notification, or another user's (never 403)",
  })
  read(
    @CurrentUser() user: AuthUser,
    @Param('id', notificationId()) id: string,
  ): Promise<Notification> {
    return this.notifications.markRead(user.id, id);
  }
}
