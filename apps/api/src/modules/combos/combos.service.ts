import { HttpStatus, Injectable } from '@nestjs/common';
import { type AdminCombo, type Combo as ComboView, ComboErrorCode } from '@ticketify/shared';
import { apiException } from '../../common/errors/api-error';
import type { Combo, Prisma } from '../../generated/prisma/client';
import { isPrismaError, PrismaErrorCode } from '../../infra/prisma/prisma-errors';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { comboNameKey } from './combo-name';
import type { CreateComboDto, UpdateComboDto } from './dto/combo.dto';

type Tx = Prisma.TransactionClient;

/** Vietnamese order (Đ after D), independent of the database collation. */
const byName = new Intl.Collator('vi', { sensitivity: 'base', numeric: true });

/** One transaction-scoped advisory lock serializes every name check + write. */
const NAME_LOCK = 'combo-name';

const comboNotFound = () =>
  apiException(HttpStatus.NOT_FOUND, ComboErrorCode.COMBO_NOT_FOUND, 'Combo not found');

const nameTaken = () =>
  apiException(HttpStatus.CONFLICT, ComboErrorCode.COMBO_NAME_TAKEN, 'Combo name already in use', {
    field: 'name',
  });

const inUse = (bookingCount?: number) =>
  apiException(
    HttpStatus.CONFLICT,
    ComboErrorCode.COMBO_IN_USE,
    'Combo is part of existing bookings and cannot be deleted; set isActive to false instead',
    bookingCount === undefined ? undefined : { bookingCount },
  );

const toView = (combo: Combo): ComboView => ({
  id: combo.id,
  name: combo.name,
  description: combo.description,
  price: combo.price,
});

const toAdminView = (combo: Combo & { _count: { bookingCombos: number } }): AdminCombo => ({
  ...toView(combo),
  isActive: combo.isActive,
  bookingCount: combo._count.bookingCombos,
  createdAt: combo.createdAt.toISOString(),
  updatedAt: combo.updatedAt.toISOString(),
});

const WITH_COUNT = { _count: { select: { bookingCombos: true } } } as const;

/**
 * Combos (ROADMAP 1.16). A booking copies the combo's name and unit price into BookingCombo, so
 * editing or switching off a combo never changes an existing order; deleting is only possible
 * while no booking references it.
 */
@Injectable()
export class CombosService {
  constructor(private readonly prisma: PrismaService) {}

  async listPublic(): Promise<ComboView[]> {
    const combos = await this.prisma.combo.findMany({ where: { isActive: true } });
    return combos.map(toView).sort((a, b) => byName.compare(a.name, b.name));
  }

  async listAdmin(): Promise<AdminCombo[]> {
    const combos = await this.prisma.combo.findMany({ include: WITH_COUNT });
    return combos.map(toAdminView).sort((a, b) => byName.compare(a.name, b.name));
  }

  async create(dto: CreateComboDto): Promise<AdminCombo> {
    const combo = await this.prisma.$transaction(async (tx) => {
      await this.assertNameFree(tx, dto.name);
      return tx.combo.create({
        data: {
          name: dto.name,
          description: dto.description ?? null,
          price: dto.price,
          isActive: dto.isActive ?? true,
        },
        include: WITH_COUNT,
      });
    });
    return toAdminView(combo);
  }

  async update(id: string, dto: UpdateComboDto): Promise<AdminCombo> {
    const combo = await this.prisma.$transaction(async (tx) => {
      await this.lockCombo(tx, id);
      if (dto.name !== undefined) await this.assertNameFree(tx, dto.name, id);
      return tx.combo.update({
        where: { id },
        data: {
          name: dto.name,
          description: dto.description,
          price: dto.price,
          isActive: dto.isActive,
        },
        include: WITH_COUNT,
      });
    });
    return toAdminView(combo);
  }

  /** `409 COMBO_IN_USE` once any booking references the combo. */
  async remove(id: string): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        // Inserting a BookingCombo takes a key-share lock on the combo (FK check), which
        // conflicts with FOR UPDATE: a concurrent booking is either counted below or waits and
        // then fails its FK check.
        await this.lockCombo(tx, id);
        const bookingCount = await tx.bookingCombo.count({ where: { comboId: id } });
        if (bookingCount > 0) throw inUse(bookingCount);
        await tx.combo.delete({ where: { id } });
      });
    } catch (error) {
      // booking_combos.combo_id is ON DELETE RESTRICT: the database is the last line of defence.
      if (isPrismaError(error, PrismaErrorCode.foreignKeyViolation)) throw inUse();
      throw error;
    }
  }

  // ─── Helpers ───

  private async lockCombo(tx: Tx, id: string): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM combos WHERE id = ${id}::uuid FOR UPDATE`;
    if (rows.length === 0) throw comboNotFound();
  }

  /**
   * Names are unique ignoring case and diacritics (`comboNameKey`). The table has no unique
   * index for that (no schema change this phase), so every check runs under one advisory lock:
   * two concurrent creates of "Bắp rang" and "bap rang" run one after the other and the second
   * sees the first. Combos are few, so comparing in memory is cheap.
   */
  private async assertNameFree(tx: Tx, name: string, exceptId?: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${NAME_LOCK}))`;
    const key = comboNameKey(name);
    const combos = await tx.combo.findMany({ select: { id: true, name: true } });
    if (combos.some((combo) => combo.id !== exceptId && comboNameKey(combo.name) === key)) {
      throw nameTaken();
    }
  }
}
