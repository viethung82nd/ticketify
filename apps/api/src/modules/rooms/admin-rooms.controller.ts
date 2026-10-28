import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { type AdminRoom, type AdminRoomSummary, Role } from '@ticketify/shared';
import { Roles } from '../../common/decorators/roles.decorator';
import { CreateRoomDto, RenameRoomDto, UpdateSeatsDto } from './dto/room.dto';
import { RoomsService } from './rooms.service';

const uuid = new ParseUUIDPipe();

@ApiTags('admin: rooms')
@ApiBearerAuth()
@ApiForbiddenResponse({ description: 'FORBIDDEN: ADMIN only' })
@Roles(Role.ADMIN)
@Controller('admin/rooms')
export class AdminRoomsController {
  constructor(private readonly rooms: RoomsService) {}

  @Get()
  @ApiOkResponse({ description: 'Rooms by name, with total and active seat counts' })
  list(): Promise<AdminRoomSummary[]> {
    return this.rooms.list();
  }

  @Post()
  @ApiCreatedResponse({ description: 'Room with its rows×cols grid, every seat STANDARD and on' })
  @ApiConflictResponse({ description: 'ROOM_NAME_TAKEN' })
  create(@Body() dto: CreateRoomDto): Promise<AdminRoom> {
    return this.rooms.create(dto);
  }

  @Get(':id')
  @ApiOkResponse({ description: 'Room, every seat, and `lock` while showtimes freeze the layout' })
  @ApiNotFoundResponse({ description: 'ROOM_NOT_FOUND' })
  get(@Param('id', uuid) id: string): Promise<AdminRoom> {
    return this.rooms.get(id);
  }

  @Patch(':id')
  @ApiOkResponse({ description: 'Renamed (always allowed, even with upcoming showtimes)' })
  @ApiNotFoundResponse({ description: 'ROOM_NOT_FOUND' })
  @ApiConflictResponse({ description: 'ROOM_NAME_TAKEN' })
  rename(@Param('id', uuid) id: string, @Body() dto: RenameRoomDto): Promise<AdminRoom> {
    return this.rooms.rename(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Deleted with its seats' })
  @ApiNotFoundResponse({ description: 'ROOM_NOT_FOUND' })
  @ApiConflictResponse({ description: 'ROOM_HAS_SHOWTIMES' })
  remove(@Param('id', uuid) id: string): Promise<void> {
    return this.rooms.remove(id);
  }

  @Patch(':id/seats')
  @ApiOkResponse({ description: 'All changes applied (all-or-nothing); the full new grid' })
  @ApiNotFoundResponse({ description: 'ROOM_NOT_FOUND' })
  @ApiConflictResponse({ description: 'ROOM_IN_USE: upcoming showtimes freeze the layout' })
  @ApiUnprocessableEntityResponse({
    description: 'SEAT_NOT_FOUND, INVALID_COUPLE or COUPLE_INCONSISTENT (details.violations)',
  })
  updateSeats(@Param('id', uuid) id: string, @Body() dto: UpdateSeatsDto): Promise<AdminRoom> {
    return this.rooms.updateSeats(id, dto);
  }
}
