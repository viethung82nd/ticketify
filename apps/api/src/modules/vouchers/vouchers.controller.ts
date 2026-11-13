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
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { type AdminVoucher, Role } from '@ticketify/shared';
import { Roles } from '../../common/decorators/roles.decorator';
import { CreateVoucherDto, UpdateVoucherDto } from './dto/voucher.dto';
import { VouchersService } from './vouchers.service';

const uuid = new ParseUUIDPipe();

@ApiTags('admin: vouchers')
@ApiBearerAuth()
@ApiForbiddenResponse({ description: 'FORBIDDEN: ADMIN only' })
@Roles(Role.ADMIN)
@Controller('admin/vouchers')
export class AdminVouchersController {
  constructor(private readonly vouchers: VouchersService) {}

  @Get()
  @ApiOkResponse({ description: 'Every voucher (active or not), newest first, with usage counts' })
  list(): Promise<AdminVoucher[]> {
    return this.vouchers.list();
  }

  @Get(':id')
  @ApiOkResponse({ description: 'One voucher with its usage counts' })
  @ApiNotFoundResponse({ description: 'VOUCHER_NOT_FOUND' })
  get(@Param('id', uuid) id: string): Promise<AdminVoucher> {
    return this.vouchers.get(id);
  }

  @Post()
  @ApiCreatedResponse({ description: 'Created' })
  @ApiBadRequestResponse({
    description: 'VALIDATION_FAILED, also for the rules across fields (type/value, cap, dates)',
  })
  @ApiConflictResponse({ description: 'VOUCHER_CODE_TAKEN (codes are compared upper-cased)' })
  create(@Body() dto: CreateVoucherDto): Promise<AdminVoucher> {
    return this.vouchers.create(dto);
  }

  @Patch(':id')
  @ApiOkResponse({ description: 'Updated; bookings keep the discount they were given' })
  @ApiBadRequestResponse({ description: 'VALIDATION_FAILED, checked on the merged voucher' })
  @ApiNotFoundResponse({ description: 'VOUCHER_NOT_FOUND' })
  @ApiConflictResponse({
    description: 'VOUCHER_CODE_TAKEN; VOUCHER_IN_USE when changing the code of a used voucher',
  })
  update(@Param('id', uuid) id: string, @Body() dto: UpdateVoucherDto): Promise<AdminVoucher> {
    return this.vouchers.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Deleted' })
  @ApiNotFoundResponse({ description: 'VOUCHER_NOT_FOUND' })
  @ApiConflictResponse({ description: 'VOUCHER_IN_USE: used by bookings, switch it off' })
  remove(@Param('id', uuid) id: string): Promise<void> {
    return this.vouchers.remove(id);
  }
}
