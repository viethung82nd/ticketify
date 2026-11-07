import type { Prisma } from '../../generated/prisma/client';

type Tx = Prisma.TransactionClient;

/**
 * Actions an admin takes by hand that the system records but does not perform (ROADMAP 3.8).
 * Append-only: a row is never updated or deleted, so the log is the history of who did what.
 */
export const AuditAction = {
  /**
   * An admin marked a NEEDS_REVIEW booking handled: the refund or the call happened outside the
   * system (PLAN §5 "Xử lý NEEDS_REVIEW"). The booking keeps its status; no money moves.
   */
  BOOKING_REVIEW_RESOLVED: 'booking.review_resolved',
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

/** The kind of row an action was about; `entityId` is that row's id. */
export const AuditEntity = { BOOKING: 'booking' } as const;
export type AuditEntity = (typeof AuditEntity)[keyof typeof AuditEntity];

export interface AuditLogInput {
  action: AuditAction;
  entityType: AuditEntity;
  entityId: string;
  /** The admin who acted. */
  actorId: string;
  /** What the admin wrote. Required for every action logged so far. */
  note: string;
  /** The fields the action changed, as they were and as they became. */
  before: Prisma.InputJsonObject;
  after: Prisma.InputJsonObject;
}

/**
 * Appends one audit entry. Call it inside the transaction that makes the change it describes: if
 * that transaction rolls back, the entry was never written, so the log never claims an action
 * that did not happen.
 */
export async function writeAuditLog(tx: Tx, entry: AuditLogInput, now: Date): Promise<string> {
  const row = await tx.auditLog.create({
    data: {
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      actorId: entry.actorId,
      note: entry.note,
      before: entry.before,
      after: entry.after,
      createdAt: now,
    },
    select: { id: true },
  });
  return row.id;
}
