import {
  addDays,
  type AdminVoucher,
  createVoucherRequestSchema,
  fieldErrorSchema,
  formatVnd,
  isIsoDate,
  type UpdateVoucherRequest,
  VOUCHER_LIMITS,
  VoucherDiscountType,
  VoucherErrorCode,
} from '@ticketify/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, EyeOff, Loader2, Pencil, Plus, Power, Trash2, X } from 'lucide-react';
import { type ChangeEvent, useState } from 'react';
import { type FieldPath, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { AdminShell } from '@/components/admin/admin-shell';
import { EmptyState, ErrorState } from '@/components/catalog/query-states';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { FormAlert } from '@/features/auth/auth-card';
import { catalogErrorMessage, errorCodeOf } from '@/features/catalog/catalog-errors';
import {
  createVoucher,
  deleteVoucher,
  updateVoucher,
  useAdminVouchers,
  voucherKeys,
} from '@/features/vouchers/vouchers-api';
import { apiErrorOf } from '@/lib/api-error';
import { cinemaDate, cinemaIso, cinemaToday } from '@/lib/cinema-time';
import { cn } from '@/lib/utils';

/**
 * What the admin types. Every number is text (thousands separators allowed) and the validity is
 * two calendar dates on the cinema's clock: from the start of `fromDate` to the end of `toDate`.
 * `toBody` turns it into the API request, which `createVoucherRequestSchema` then checks, so the
 * form and the API apply the same rules.
 */
interface VoucherFormValues {
  code: string;
  description: string;
  discountType: VoucherDiscountType;
  discountValue: string;
  maxDiscount: string;
  minSubtotal: string;
  usageLimit: string;
  perUserLimit: string;
  fromDate: string;
  toDate: string;
}

type FormKey = FieldPath<VoucherFormValues>;

/** Digits only → the number; empty → `undefined`. */
const parseNumber = (text: string): number | undefined => {
  const digits = text.replace(/\D/g, '');
  return digits === '' ? undefined : Number(digits);
};

/** Shows a number with thousands separators while typing. */
const asVnd = (text: string): string => {
  const value = parseNumber(text);
  return value === undefined ? '' : formatVnd(value);
};

/** `endsAt` is exclusive (start of the next day); the form shows the last day it is valid. */
const lastDayOf = (endsAt: string): string =>
  cinemaDate(new Date(Date.parse(endsAt) - 1).toISOString());

const startOf = (date: string) => (isIsoDate(date) ? cinemaIso(date, '00:00') : null);
const endOf = (date: string) => (isIsoDate(date) ? cinemaIso(addDays(date, 1), '00:00') : null);

/** The request the form describes; empty optional numbers mean "none" / "unlimited". */
function toBody(values: VoucherFormValues) {
  const discountValue = parseNumber(values.discountValue);
  return {
    code: values.code,
    description: values.description,
    discountType: values.discountType,
    discountValue: discountValue ?? Number.NaN,
    maxDiscount:
      values.discountType === VoucherDiscountType.PERCENT
        ? (parseNumber(values.maxDiscount) ?? null)
        : null,
    minSubtotal: parseNumber(values.minSubtotal) ?? 0,
    usageLimit: parseNumber(values.usageLimit) ?? null,
    perUserLimit: parseNumber(values.perUserLimit) ?? null,
    startsAt: startOf(values.fromDate) ?? '',
    endsAt: endOf(values.toDate) ?? '',
  };
}

/** API field → form field. */
const FORM_FIELD: Record<string, FormKey> = {
  code: 'code',
  description: 'description',
  discountType: 'discountType',
  discountValue: 'discountValue',
  maxDiscount: 'maxDiscount',
  minSubtotal: 'minSubtotal',
  usageLimit: 'usageLimit',
  perUserLimit: 'perUserLimit',
  startsAt: 'fromDate',
  endsAt: 'toDate',
};

const EMPTY: VoucherFormValues = {
  code: '',
  description: '',
  discountType: VoucherDiscountType.PERCENT,
  discountValue: '',
  maxDiscount: '',
  minSubtotal: '',
  usageLimit: '',
  perUserLimit: String(VOUCHER_LIMITS.perUserLimitDefault),
  fromDate: '',
  toDate: '',
};

const valuesOf = (voucher: AdminVoucher): VoucherFormValues => ({
  code: voucher.code,
  description: voucher.description ?? '',
  discountType: voucher.discountType,
  discountValue:
    voucher.discountType === VoucherDiscountType.PERCENT
      ? String(voucher.discountValue)
      : formatVnd(voucher.discountValue),
  maxDiscount: voucher.maxDiscount === null ? '' : formatVnd(voucher.maxDiscount),
  minSubtotal: voucher.minSubtotal === 0 ? '' : formatVnd(voucher.minSubtotal),
  usageLimit: voucher.usageLimit === null ? '' : String(voucher.usageLimit),
  perUserLimit: voucher.perUserLimit === null ? '' : String(voucher.perUserLimit),
  fromDate: cinemaDate(voucher.startsAt),
  toDate: lastDayOf(voucher.endsAt),
});

const usedCount = (voucher: AdminVoucher) =>
  voucher.usage.reserved + voucher.usage.consumed + voucher.usage.released;

function useRefreshVouchers() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: voucherKeys.admin });
}

/** Create (no `voucher`) or edit form. On edit only the fields the admin changed are sent. */
function VoucherForm({ voucher, onDone }: { voucher?: AdminVoucher; onDone: () => void }) {
  const refresh = useRefreshVouchers();
  const [formError, setFormError] = useState<string | null>(null);
  const codeLocked = voucher !== undefined && usedCount(voucher) > 0;
  const {
    register,
    handleSubmit,
    reset,
    setError,
    setValue,
    control,
    formState: { errors, isSubmitting, dirtyFields },
  } = useForm<VoucherFormValues>({ defaultValues: voucher ? valuesOf(voucher) : EMPTY });
  const discountType = useWatch({ control, name: 'discountType' });
  const isPercent = discountType === VoucherDiscountType.PERCENT;

  const showErrors = (issues: { field: string; message: string }[]) => {
    for (const { field, message } of issues) {
      const target = FORM_FIELD[field];
      if (target) setError(target, { message });
    }
  };

  const onSubmit = async (values: VoucherFormValues) => {
    setFormError(null);
    const missing: { field: string; message: string }[] = [];
    if (!isIsoDate(values.fromDate))
      missing.push({ field: 'startsAt', message: 'Chọn ngày bắt đầu' });
    if (!isIsoDate(values.toDate)) missing.push({ field: 'endsAt', message: 'Chọn ngày kết thúc' });
    if (parseNumber(values.discountValue) === undefined) {
      missing.push({ field: 'discountValue', message: 'Vui lòng nhập mức giảm' });
    }
    if (missing.length > 0) return showErrors(missing);

    const body = toBody(values);
    const checked = createVoucherRequestSchema.safeParse(body);
    if (!checked.success) {
      return showErrors(
        checked.error.issues.map((issue) => ({
          field: String(issue.path[0] ?? ''),
          message: issue.message,
        })),
      );
    }

    try {
      if (voucher) {
        // Only what changed, so an untouched validity keeps its exact instants.
        const changed: UpdateVoucherRequest = {};
        const dirty = (field: keyof VoucherFormValues) => dirtyFields[field] === true;
        if (dirty('code')) changed.code = body.code;
        if (dirty('description')) changed.description = body.description;
        if (dirty('discountType')) changed.discountType = body.discountType;
        if (dirty('discountValue')) changed.discountValue = body.discountValue;
        if (dirty('maxDiscount') || dirty('discountType')) changed.maxDiscount = body.maxDiscount;
        if (dirty('minSubtotal')) changed.minSubtotal = body.minSubtotal;
        if (dirty('usageLimit')) changed.usageLimit = body.usageLimit;
        if (dirty('perUserLimit')) changed.perUserLimit = body.perUserLimit;
        if (dirty('fromDate')) changed.startsAt = body.startsAt;
        if (dirty('toDate')) changed.endsAt = body.endsAt;
        await updateVoucher(voucher.id, changed);
      } else {
        await createVoucher(body);
        reset(EMPTY);
      }
      await refresh();
      onDone();
    } catch (error) {
      const details = z.array(fieldErrorSchema).safeParse(apiErrorOf(error)?.details);
      if (details.success && details.data.length > 0) {
        showErrors(details.data.map((d) => ({ field: d.field, message: d.messages[0] ?? '' })));
      } else if (errorCodeOf(error) === VoucherErrorCode.VOUCHER_CODE_TAKEN) {
        setError('code', { message: catalogErrorMessage(error) });
      } else {
        setFormError(catalogErrorMessage(error));
      }
    }
  };

  const vnd = (field: 'discountValue' | 'maxDiscount' | 'minSubtotal') =>
    register(field, {
      onChange: (e: ChangeEvent<HTMLInputElement>) => {
        if (field !== 'discountValue' || !isPercent) {
          setValue(field, asVnd(e.target.value), { shouldDirty: true });
        }
      },
    });

  return (
    <form
      noValidate
      aria-label={voucher ? `Sửa voucher ${voucher.code}` : 'Thêm voucher'}
      onSubmit={(e) => void handleSubmit(onSubmit)(e)}
      className="mb-6 space-y-4 rounded-2xl border border-white/10 bg-surface p-5"
    >
      {voucher && (
        <h2 className="font-display text-lg text-cream">
          Sửa voucher <span className="font-mono">{voucher.code}</span>
        </h2>
      )}
      <div className="grid gap-4 md:grid-cols-4">
        <FormField
          label="Mã voucher"
          error={errors.code}
          hint={
            codeLocked
              ? 'Đã có đơn dùng nên không đổi được mã'
              : `${VOUCHER_LIMITS.codeMin}–${VOUCHER_LIMITS.codeMax} chữ không dấu hoặc số`
          }
        >
          <Input
            placeholder="SUMMER10"
            maxLength={VOUCHER_LIMITS.codeMax + 2}
            disabled={codeLocked}
            className="font-mono uppercase"
            {...register('code')}
          />
        </FormField>
        <FormField label="Kiểu giảm" error={errors.discountType}>
          <Select
            {...register('discountType', {
              onChange: () => setValue('discountValue', '', { shouldDirty: true }),
            })}
          >
            <option value={VoucherDiscountType.PERCENT}>Theo phần trăm</option>
            <option value={VoucherDiscountType.FIXED}>Số tiền cố định</option>
          </Select>
        </FormField>
        <FormField
          label={isPercent ? 'Mức giảm (%)' : 'Mức giảm (VND)'}
          error={errors.discountValue}
          hint={
            isPercent
              ? `${VOUCHER_LIMITS.percentMin}–${VOUCHER_LIMITS.percentMax}%`
              : `${formatVnd(VOUCHER_LIMITS.fixedMin)}–${formatVnd(VOUCHER_LIMITS.fixedMax)} ₫`
          }
        >
          <Input
            inputMode="numeric"
            placeholder={isPercent ? '10' : '20.000'}
            {...vnd('discountValue')}
          />
        </FormField>
        <FormField
          label="Giảm tối đa (VND)"
          error={errors.maxDiscount}
          hint={isPercent ? 'Để trống nếu không giới hạn' : 'Chỉ dùng cho kiểu phần trăm'}
        >
          <Input
            inputMode="numeric"
            placeholder="50.000"
            disabled={!isPercent}
            {...vnd('maxDiscount')}
          />
        </FormField>
        <FormField label="Đơn tối thiểu (VND)" error={errors.minSubtotal} hint="Để trống = mọi đơn">
          <Input inputMode="numeric" placeholder="0" {...vnd('minSubtotal')} />
        </FormField>
        <FormField label="Tổng số lượt" error={errors.usageLimit} hint="Để trống = không giới hạn">
          <Input inputMode="numeric" placeholder="100" {...register('usageLimit')} />
        </FormField>
        <FormField
          label="Lượt mỗi người"
          error={errors.perUserLimit}
          hint="Để trống = không giới hạn"
        >
          <Input inputMode="numeric" placeholder="1" {...register('perUserLimit')} />
        </FormField>
        <FormField label="Mô tả (không bắt buộc)" error={errors.description}>
          <Input
            placeholder="Khuyến mãi mùa hè"
            maxLength={VOUCHER_LIMITS.descriptionMax}
            {...register('description')}
          />
        </FormField>
        <FormField label="Từ ngày" error={errors.fromDate} hint="Từ 00:00, giờ Việt Nam">
          <Input type="date" min={voucher ? undefined : cinemaToday()} {...register('fromDate')} />
        </FormField>
        <FormField label="Đến hết ngày" error={errors.toDate} hint="Đến 23:59, giờ Việt Nam">
          <Input type="date" min={voucher ? undefined : cinemaToday()} {...register('toDate')} />
        </FormField>
      </div>
      <FormAlert message={formError} />
      <div className="flex gap-2">
        <Button
          type="submit"
          disabled={isSubmitting}
          className="h-11 rounded-xl px-4 font-semibold"
        >
          {isSubmitting ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : voucher ? (
            <Check aria-hidden />
          ) : (
            <Plus aria-hidden />
          )}
          {voucher ? 'Lưu' : 'Thêm voucher'}
        </Button>
        {voucher && (
          <Button type="button" variant="ghost" className="h-11 rounded-xl" onClick={onDone}>
            <X aria-hidden />
            Hủy
          </Button>
        )}
      </div>
    </form>
  );
}

const discountLabel = (voucher: AdminVoucher) =>
  voucher.discountType === VoucherDiscountType.PERCENT
    ? `${voucher.discountValue}%${voucher.maxDiscount === null ? '' : `, tối đa ${formatVnd(voucher.maxDiscount)} ₫`}`
    : `${formatVnd(voucher.discountValue)} ₫`;

const shortDate = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;

function VoucherRow({
  voucher,
  onEdit,
  onDelete,
}: {
  voucher: AdminVoucher;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const refresh = useRefreshVouchers();
  const toggle = useMutation({
    mutationFn: () => updateVoucher(voucher.id, { isActive: !voucher.isActive }),
    onSuccess: refresh,
  });
  const counted = voucher.usage.reserved + voucher.usage.consumed;

  return (
    <tr data-voucher={voucher.code} className={cn('align-top', !voucher.isActive && 'opacity-70')}>
      <td className="px-4 py-3">
        <span className="font-mono font-medium text-cream">{voucher.code}</span>
        {voucher.description && (
          <span className="block text-xs text-muted-foreground">{voucher.description}</span>
        )}
        {toggle.error && (
          <p role="alert" className="mt-1 text-sm text-destructive">
            {catalogErrorMessage(toggle.error)}
          </p>
        )}
      </td>
      <td className="px-4 py-3 text-cream">
        {discountLabel(voucher)}
        {voucher.minSubtotal > 0 && (
          <span className="block text-xs text-muted-foreground">
            Đơn từ {formatVnd(voucher.minSubtotal)} ₫
          </span>
        )}
      </td>
      <td className="px-4 py-3 text-cream tabular-nums">
        {shortDate(cinemaDate(voucher.startsAt))} – {shortDate(lastDayOf(voucher.endsAt))}
      </td>
      <td className="px-4 py-3 text-cream tabular-nums">
        {counted}/{voucher.usageLimit ?? '∞'}
        <span className="block text-xs text-muted-foreground">
          {voucher.perUserLimit === null
            ? 'Không giới hạn mỗi người'
            : `${voucher.perUserLimit} lượt/người`}
        </span>
      </td>
      <td className="px-4 py-3">
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={voucher.isActive}
          aria-label={`${voucher.isActive ? 'Tắt' : 'Bật'} voucher ${voucher.code}`}
          disabled={toggle.isPending}
          onClick={() => toggle.mutate()}
          className={cn(
            'rounded-full border px-3',
            voucher.isActive
              ? 'border-brand/40 bg-brand/10 text-brand hover:bg-brand/20 hover:text-brand'
              : 'border-white/15 text-muted-foreground',
          )}
        >
          {toggle.isPending ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : voucher.isActive ? (
            <Power aria-hidden />
          ) : (
            <EyeOff aria-hidden />
          )}
          {voucher.isActive ? 'Đang bật' : 'Đã tắt'}
        </Button>
      </td>
      <td className="px-4 py-3">
        <div className="flex justify-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="rounded-lg"
            aria-label={`Sửa voucher ${voucher.code}`}
            onClick={onEdit}
          >
            <Pencil aria-hidden />
            Sửa
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="rounded-lg text-destructive hover:text-destructive"
            aria-label={`Xóa voucher ${voucher.code}`}
            onClick={onDelete}
          >
            <Trash2 aria-hidden />
            Xóa
          </Button>
        </div>
      </td>
    </tr>
  );
}

function DeleteVoucherDialog({
  voucher,
  onClose,
}: {
  voucher: AdminVoucher | null;
  onClose: () => void;
}) {
  const refresh = useRefreshVouchers();
  const remove = useMutation({
    mutationFn: (id: string) => deleteVoucher(id),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });
  const switchOff = useMutation({
    mutationFn: (id: string) => updateVoucher(id, { isActive: false }),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });
  const inUse = errorCodeOf(remove.error) === VoucherErrorCode.VOUCHER_IN_USE;

  return (
    <AlertDialog
      open={voucher !== null}
      onOpenChange={(open) => {
        if (open) return;
        remove.reset();
        switchOff.reset();
        onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogTitle>Xóa voucher?</AlertDialogTitle>
        <AlertDialogDescription>
          Voucher <strong className="font-mono text-cream">{voucher?.code}</strong> sẽ bị xóa. Chỉ
          xóa được voucher chưa có đơn nào dùng; nếu đã có, hãy tắt voucher để ngừng nhận lượt mới.
        </AlertDialogDescription>
        <FormAlert
          message={
            remove.error
              ? catalogErrorMessage(remove.error)
              : switchOff.error
                ? catalogErrorMessage(switchOff.error)
                : null
          }
        />
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <AlertDialogCancel asChild>
            <Button variant="outline" className="rounded-xl">
              Đóng
            </Button>
          </AlertDialogCancel>
          {inUse && voucher?.isActive ? (
            <Button
              className="rounded-xl"
              disabled={switchOff.isPending}
              onClick={() => switchOff.mutate(voucher.id)}
            >
              {switchOff.isPending && <Loader2 className="animate-spin" aria-hidden />}
              Tắt voucher
            </Button>
          ) : (
            <Button
              variant="destructive"
              className="rounded-xl"
              disabled={remove.isPending || inUse}
              onClick={() => voucher && remove.mutate(voucher.id)}
            >
              {remove.isPending && <Loader2 className="animate-spin" aria-hidden />}
              Xóa voucher
            </Button>
          )}
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function AdminVouchersPage() {
  const { data, isPending, error, refetch } = useAdminVouchers();
  const [editing, setEditing] = useState<AdminVoucher | null>(null);
  const [toDelete, setToDelete] = useState<AdminVoucher | null>(null);

  return (
    <AdminShell
      title="Voucher"
      description="Mã giảm giá áp vào tạm tính của đơn. Lượt dùng tính từ các đơn đang giữ hoặc đã thanh toán; đơn hết hạn trả lại lượt. Đơn đã đặt giữ nguyên số tiền được giảm."
    >
      {editing ? (
        <VoucherForm
          key={`${editing.id}:${editing.updatedAt}`}
          voucher={editing}
          onDone={() => setEditing(null)}
        />
      ) : (
        <VoucherForm onDone={() => undefined} />
      )}
      {isPending ? (
        <div
          role="status"
          aria-label="Đang tải"
          className="h-48 animate-pulse rounded-2xl bg-white/5"
        />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : data.length === 0 ? (
        <EmptyState title="Chưa có voucher nào" />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-white/10 bg-surface">
          <table className="w-full min-w-[860px] text-left text-sm">
            <caption className="sr-only">Danh sách voucher</caption>
            <thead className="border-b border-white/10 text-xs text-muted-foreground uppercase">
              <tr>
                <th scope="col" className="px-4 py-3">
                  Mã
                </th>
                <th scope="col" className="px-4 py-3">
                  Giảm
                </th>
                <th scope="col" className="px-4 py-3">
                  Hiệu lực
                </th>
                <th scope="col" className="px-4 py-3">
                  Đã dùng
                </th>
                <th scope="col" className="px-4 py-3">
                  Trạng thái
                </th>
                <th scope="col" className="px-4 py-3">
                  <span className="sr-only">Thao tác</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {data.map((voucher) => (
                <VoucherRow
                  key={`${voucher.id}:${voucher.updatedAt}`}
                  voucher={voucher}
                  onEdit={() => setEditing(voucher)}
                  onDelete={() => setToDelete(voucher)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <DeleteVoucherDialog voucher={toDelete} onClose={() => setToDelete(null)} />
    </AdminShell>
  );
}
