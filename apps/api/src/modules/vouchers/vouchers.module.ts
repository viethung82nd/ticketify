import { Module } from '@nestjs/common';
import { AdminVouchersController } from './vouchers.controller';
import { VouchersService } from './vouchers.service';

/** Discount vouchers, admin CRUD (ROADMAP 5.1). Reserving a use at booking time is 5.2. */
@Module({
  controllers: [AdminVouchersController],
  providers: [VouchersService],
})
export class VouchersModule {}
