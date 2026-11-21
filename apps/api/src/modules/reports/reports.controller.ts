import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { AdminBooking, OccupancyReport, Page, RevenueReport } from '@ticketify/shared';
import { Role } from '@ticketify/shared';
import { Roles } from '../../common/decorators/roles.decorator';
import { AdminBookingsService } from './admin-bookings.service';
import { DashboardService } from './dashboard.service';
import { AdminBookingsQueryDto, OccupancyQueryDto, RevenueQueryDto } from './dto/admin-report.dto';

/**
 * Every booking, for the admin (ROADMAP 5.5). Same path prefix as the NEEDS_REVIEW queue
 * (`/admin/bookings/needs-review`, PaymentsModule); this one is the list itself. ADMIN only.
 */
@ApiTags('admin: bookings')
@ApiBearerAuth()
@ApiForbiddenResponse({ description: 'FORBIDDEN: ADMIN only' })
@Roles(Role.ADMIN)
@Controller('admin/bookings')
export class AdminBookingsController {
  constructor(private readonly bookings: AdminBookingsService) {}

  @Get()
  @ApiOkResponse({ description: 'Bookings, newest first' })
  @ApiBadRequestResponse({
    description: 'VALIDATION_FAILED: status, q, from/to (YYYY-MM-DD, from <= to), page, pageSize',
  })
  list(@Query() query: AdminBookingsQueryDto): Promise<Page<AdminBooking>> {
    return this.bookings.list(query);
  }
}

/** Revenue per day and seats sold per showtime (ROADMAP 5.5). ADMIN only. */
@ApiTags('admin: dashboard')
@ApiBearerAuth()
@ApiForbiddenResponse({ description: 'FORBIDDEN: ADMIN only' })
@Roles(Role.ADMIN)
@Controller('admin/dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('revenue')
  @ApiOkResponse({
    description: 'Total of the bookings confirmed each cinema day (by confirmedAt), zeros included',
  })
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED: dates, from <= to, at most 31 days' })
  revenue(@Query() query: RevenueQueryDto): Promise<RevenueReport> {
    return this.dashboard.revenue(query);
  }

  @Get('occupancy')
  @ApiOkResponse({ description: 'Showtimes starting that cinema day, with seats sold and held' })
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED: date (YYYY-MM-DD)' })
  occupancy(@Query() query: OccupancyQueryDto): Promise<OccupancyReport> {
    return this.dashboard.occupancy(query);
  }
}
