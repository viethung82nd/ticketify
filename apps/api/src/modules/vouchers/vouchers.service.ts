import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type AdminVoucher,
  VOUCHER_LIMITS,
  VoucherErrorCode,
  voucherRuleErrors,
  type VoucherUsageCounts,
} from '@ticketify/shared';
import { apiException, validationFailed } from '../../common/errors/api-error';
import type { Prisma, Voucher } from '../../generated/prisma/client';
import { isPrismaError, PrismaErrorCode } from '../../infra/prisma/prisma-errors';
import { PrismaService } from '../../infra/prisma/prisma.service';
import type { CreateVoucherDto, UpdateVoucherDto } from './dto/voucher.dto';

type Tx = Prisma.TransactionClient;

const voucherNotFound = () =>
  apiException(HttpStatus.NOT_FOUND, VoucherErrorCode.VOUCHER_NOT_FOUND, 'Voucher not found');

const codeTaken = () =>
  apiException(
    HttpStatus.CONFLICT,
    VoucherErrorCode.VOUCHER_CODE_TAKEN,
    'Voucher code already in use',
    { field: 'code' },
  );

const inUse = (message: string, usageCount?: number) =>
  apiException(
    HttpStatus.CONFLICT,
    VoucherErrorCode.VOUCHER_IN_USE,
    message,
    usageCount === undefined ? undefined : { usageCount },
  );

const NO_USAGE: VoucherUsageCounts = { reserved: 0, consumed: 0, released: 0 };

const total = (usage: VoucherUsageCounts) => usage.reserved + usage.consumed + usage.released;

const toView = (voucher: Voucher, usage: VoucherUsageCounts): AdminVoucher => ({
  id: voucher.id,
  code: voucher.code,
  description: voucher.description,
  discountType: voucher.discountType,
  discountValue: voucher.discountValue,
  maxDiscount: voucher.maxDiscount,
  minSubtotal: voucher.minSubtotal,
  usageLimit: voucher.usageLimit,
  perUserLimit: voucher.perUserLimit,
  startsAt: voucher.startsAt.toISOString(),
  endsAt: voucher.endsAt.toISOString(),
  isActive: voucher.isActive,
  usage,
  createdAt: voucher.createdAt.toISOString(),
  updatedAt: voucher.updatedAt.toISOString(),
});

/** `400 VALIDATION_FAILED` for the rules that span fields, on the voucher as it would be stored. */
function assertRules(voucher: Parameters<typeof voucherRuleErrors>[0]): void {
  const errors = voucherRuleErrors(voucher);
  if (errors.length > 0) {
    throw validationFailed(errors.map(({ field, message }) => ({ field, messages: [message] })));
  }
}

/**
 * Vouchers, admin side (ROADMAP 5.1, PLAN §6). Usage is never stored on the voucher: it is
 * counted from `voucher_usages`. A booking keeps the discount it was given, so editing a voucher
 * never changes an existing order; but once any booking used it, the code is fixed and the
 * voucher can only be switched off, not deleted.
 *
 * Every write that depends on usage locks the voucher row FOR UPDATE first. 5.2 reserves a use
 * under the same lock, so a delete or a code change and a new reservation cannot interleave.
 */
@Injectable()
export class VouchersService {
  constructor(private readonly prisma: PrismaService) {}

  /** Newest first. */
  async list(): Promise<AdminVoucher[]> {
    const vouchers = await this.prisma.voucher.findMany({ orderBy: { createdAt: 'desc' } });
    const usage = await this.usageOf(
      this.prisma,
      vouchers.map((voucher) => voucher.id),
    );
    return vouchers.map((voucher) => toView(voucher, usage.get(voucher.id) ?? NO_USAGE));
  }

  async get(id: string): Promise<AdminVoucher> {
    const voucher = await this.prisma.voucher.findUnique({ where: { id } });
    if (!voucher) throw voucherNotFound();
    const usage = await this.usageOf(this.prisma, [id]);
    return toView(voucher, usage.get(id) ?? NO_USAGE);
  }

  async create(dto: CreateVoucherDto): Promise<AdminVoucher> {
    const maxDiscount = dto.maxDiscount ?? null;
    assertRules({ ...dto, maxDiscount });
    try {
      const voucher = await this.prisma.voucher.create({
        data: {
          code: dto.code,
          description: dto.description ?? null,
          discountType: dto.discountType,
          discountValue: dto.discountValue,
          maxDiscount,
          minSubtotal: dto.minSubtotal ?? 0,
          usageLimit: dto.usageLimit ?? null,
          perUserLimit:
            dto.perUserLimit === undefined ? VOUCHER_LIMITS.perUserLimitDefault : dto.perUserLimit,
          startsAt: new Date(dto.startsAt),
          endsAt: new Date(dto.endsAt),
          isActive: dto.isActive ?? true,
        },
      });
      return toView(voucher, NO_USAGE);
    } catch (error) {
      // vouchers.code is the only unique column besides the primary key.
      if (isPrismaError(error, PrismaErrorCode.uniqueViolation)) throw codeTaken();
      throw error;
    }
  }

  async update(id: string, dto: UpdateVoucherDto): Promise<AdminVoucher> {
    try {
      const [voucher, usage] = await this.prisma.$transaction(async (tx) => {
        const current = await this.lockVoucher(tx, id);
        const startsAt = dto.startsAt ?? current.startsAt.toISOString();
        const endsAt = dto.endsAt ?? current.endsAt.toISOString();
        assertRules({
          discountType: dto.discountType ?? current.discountType,
          discountValue: dto.discountValue ?? current.discountValue,
          maxDiscount: dto.maxDiscount === undefined ? current.maxDiscount : dto.maxDiscount,
          startsAt,
          endsAt,
        });

        const usage = (await this.usageOf(tx, [id])).get(id) ?? NO_USAGE;
        if (dto.code !== undefined && dto.code !== current.code && total(usage) > 0) {
          throw inUse(
            'Voucher was used by bookings, so its code cannot change; create a new voucher instead',
            total(usage),
          );
        }

        const updated = await tx.voucher.update({
          where: { id },
          data: {
            code: dto.code,
            description: dto.description,
            discountType: dto.discountType,
            discountValue: dto.discountValue,
            maxDiscount: dto.maxDiscount,
            minSubtotal: dto.minSubtotal,
            usageLimit: dto.usageLimit,
            perUserLimit: dto.perUserLimit,
            startsAt: new Date(startsAt),
            endsAt: new Date(endsAt),
            isActive: dto.isActive,
          },
        });
        return [updated, usage] as const;
      });
      return toView(voucher, usage);
    } catch (error) {
      if (isPrismaError(error, PrismaErrorCode.uniqueViolation)) throw codeTaken();
      throw error;
    }
  }

  /** `409 VOUCHER_IN_USE` once any booking used the voucher, whatever the use's status. */
  async remove(id: string): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.lockVoucher(tx, id);
        const usageCount = await tx.voucherUsage.count({ where: { voucherId: id } });
        if (usageCount > 0) {
          throw inUse(
            'Voucher was used by bookings and cannot be deleted; set isActive to false instead',
            usageCount,
          );
        }
        await tx.voucher.delete({ where: { id } });
      });
    } catch (error) {
      // voucher_usages.voucher_id is ON DELETE RESTRICT: the database is the last line of defence.
      if (isPrismaError(error, PrismaErrorCode.foreignKeyViolation)) {
        throw inUse('Voucher was used by bookings and cannot be deleted');
      }
      throw error;
    }
  }

  // ─── Helpers ───

  private async lockVoucher(tx: Tx, id: string): Promise<Voucher> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM vouchers WHERE id = ${id}::uuid FOR UPDATE`;
    if (rows.length === 0) throw voucherNotFound();
    return tx.voucher.findUniqueOrThrow({ where: { id } });
  }

  /** Uses per voucher and status, in one query. */
  private async usageOf(
    client: Tx | PrismaService,
    voucherIds: string[],
  ): Promise<Map<string, VoucherUsageCounts>> {
    const counts = new Map<string, VoucherUsageCounts>();
    if (voucherIds.length === 0) return counts;
    const groups = await client.voucherUsage.groupBy({
      by: ['voucherId', 'status'],
      where: { voucherId: { in: voucherIds } },
      _count: { _all: true },
    });
    for (const group of groups) {
      const usage = counts.get(group.voucherId) ?? { ...NO_USAGE };
      if (group.status === 'RESERVED') usage.reserved = group._count._all;
      else if (group.status === 'CONSUMED') usage.consumed = group._count._all;
      else usage.released = group._count._all;
      counts.set(group.voucherId, usage);
    }
    return counts;
  }
}
