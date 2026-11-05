import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { type CheckInResponse, Role } from '@ticketify/shared';
import { type AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { validationFailed } from '../../common/errors/api-error';
import { CheckInService } from './check-in.service';
import { CheckInDto } from './dto/check-in.dto';

/**
 * Check-in at the door (ROADMAP 4.7). Staff only; an admin is staff enough to cover for them.
 *
 * Every verdict is HTTP 200 with a `result`, including `NOT_FOUND`: a device at the door wants an
 * answer to put on screen, and "this code does not exist" is as normal an answer as "welcome in".
 * A `400` is kept for a malformed request — neither a token nor a code, or both at once.
 */
@ApiTags('tickets')
@ApiBearerAuth()
@Roles(Role.STAFF, Role.ADMIN)
@Controller('tickets')
export class CheckInController {
  constructor(private readonly checkIn: CheckInService) {}

  @Post('check-in')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({
    description:
      'result: OK (was ISSUED, now CHECKED_IN) | ALREADY_USED (with checkedInAt) | ' +
      'WRONG_SHOWTIME (a real ticket, another showtime) | VOID | NOT_FOUND. ' +
      '`ticket` is absent only for NOT_FOUND',
  })
  @ApiBadRequestResponse({
    description: 'VALIDATION_FAILED: neither token nor code, both at once, or a bad showtimeId',
  })
  @ApiForbiddenResponse({ description: 'FORBIDDEN: not a STAFF or ADMIN account' })
  scan(@CurrentUser() staff: AuthUser, @Body() dto: CheckInDto): Promise<CheckInResponse> {
    if (Boolean(dto.token) === Boolean(dto.code)) {
      throw validationFailed([
        { field: 'token', messages: ['Provide either token or code, not both'] },
      ]);
    }
    return this.checkIn.check({
      token: dto.token,
      code: dto.code,
      showtimeId: dto.showtimeId,
      staffId: staff.id,
    });
  }
}
