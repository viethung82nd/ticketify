import { Module } from '@nestjs/common';
import { MyNotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/** Notifications on the API: the user's own list and marking them read (ROADMAP 4.2). */
@Module({
  controllers: [MyNotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}

/** Notifications in the worker: only writing them (no controller). */
@Module({
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsWorkerModule {}
