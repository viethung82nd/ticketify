import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { NeedsReviewBooking, Page } from '@ticketify/shared';
import { Role } from '@ticketify/shared';
import { type AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AdminReviewService } from './admin-review.service';
import { NeedsReviewQueryDto, ResolveReviewDto } from './dto/admin-review.dto';

/**
 * Bookings that were paid but could not keep their seats (ROADMAP 3.8, PLAN §5 "Xử lý
 * NEEDS_REVIEW"). ADMIN only.
 *
 * Marking one handled **refunds nothing**: the money goes back through the VNPay merchant portal
 * by hand, or the customer is called. The endpoint records who did it, when, and the required
 * note, in `audit_logs`.
 */
@ApiTags('admin: bookings under review')
@ApiBearerAuth()
@ApiForbiddenResponse({ description: 'FORBIDDEN: ADMIN only' })
@Roles(Role.ADMIN)
@Controller('admin/bookings')
export class AdminReviewController {
  constructor(private readonly review: AdminReviewService) {}

  @Get('needs-review')
  @ApiOkResponse({
    description: 'NEEDS_REVIEW bookings; `open` (default) oldest first, the others newest first',
  })
  list(@Query() query: NeedsReviewQueryDto): Promise<Page<NeedsReviewBooking>> {
    return this.review.list(query);
  }

  @Post(':id/resolve-review')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ description: 'Recorded. The booking stays NEEDS_REVIEW; no refund was made' })
  @ApiNotFoundResponse({ description: 'BOOKING_NOT_FOUND' })
  @ApiConflictResponse({ description: 'BOOKING_NOT_IN_REVIEW, REVIEW_ALREADY_RESOLVED' })
  resolve(
    @CurrentUser() admin: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ResolveReviewDto,
  ): Promise<NeedsReviewBooking> {
    return this.review.resolve(admin.id, id, dto.note);
  }
}
