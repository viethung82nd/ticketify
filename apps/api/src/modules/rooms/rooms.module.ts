import { Module } from '@nestjs/common';
import { AdminRoomsController } from './admin-rooms.controller';
import { RoomsService } from './rooms.service';

/** Rooms and seat layouts (ROADMAP 1.9). */
@Module({
  controllers: [AdminRoomsController],
  providers: [RoomsService],
})
export class RoomsModule {}
