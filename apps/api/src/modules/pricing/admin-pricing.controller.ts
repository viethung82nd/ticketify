import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { DayType, type Holiday, Role, type SeatPrice, SeatType } from '@ticketify/shared';
import { Roles } from '../../common/decorators/roles.decorator';
import { HolidayDto, ListHolidaysQueryDto, SeatPriceDto } from './dto/pricing.dto';
import { HolidaysService } from './holidays.service';
import { SeatPricesService } from './seat-prices.service';

@ApiTags('admin: pricing')
@ApiBearerAuth()
@ApiForbiddenResponse({ description: 'FORBIDDEN: ADMIN only' })
@Roles(Role.ADMIN)
@Controller('admin/seat-prices')
export class AdminSeatPricesController {
  constructor(private readonly prices: SeatPricesService) {}

  @Get()
  @ApiOkResponse({ description: 'The 9 cells: seat type × day type' })
  list(): Promise<SeatPrice[]> {
    return this.prices.list();
  }

  @Put(':seatType/:dayType')
  @ApiOkResponse({ description: 'Updated. Existing showtimes keep the price they locked in' })
  @ApiNotFoundResponse({ description: 'PRICE_NOT_FOUND' })
  update(
    @Param('seatType', new ParseEnumPipe(SeatType)) seatType: SeatType,
    @Param('dayType', new ParseEnumPipe(DayType)) dayType: DayType,
    @Body() dto: SeatPriceDto,
  ): Promise<SeatPrice> {
    return this.prices.update(seatType, dayType, dto.price);
  }
}

@ApiTags('admin: pricing')
@ApiBearerAuth()
@ApiForbiddenResponse({ description: 'FORBIDDEN: ADMIN only' })
@Roles(Role.ADMIN)
@Controller('admin/holidays')
export class AdminHolidaysController {
  constructor(private readonly holidays: HolidaysService) {}

  @Get()
  @ApiOkResponse({ description: 'Holidays of the year, by date' })
  list(@Query() query: ListHolidaysQueryDto): Promise<Holiday[]> {
    return this.holidays.list(query.year);
  }

  @Post()
  @ApiConflictResponse({ description: 'HOLIDAY_EXISTS' })
  create(@Body() dto: HolidayDto): Promise<Holiday> {
    return this.holidays.create(dto.date);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Deleted' })
  @ApiNotFoundResponse({ description: 'HOLIDAY_NOT_FOUND' })
  remove(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    return this.holidays.remove(id);
  }
}
