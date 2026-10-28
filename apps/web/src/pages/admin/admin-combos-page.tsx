import { zodResolver } from '@hookform/resolvers/zod';
import {
  type AdminCombo,
  COMBO_LIMITS,
  ComboErrorCode,
  createComboRequestSchema,
  formatVnd,
  updateComboRequestSchema,
} from '@ticketify/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, EyeOff, Loader2, Pencil, Plus, Power, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
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
import { FormAlert } from '@/features/auth/auth-card';
import { catalogErrorMessage, errorCodeOf } from '@/features/catalog/catalog-errors';
import {
  comboKeys,
  createCombo,
  deleteCombo,
  updateCombo,
  useAdminCombos,
} from '@/features/combos/combos-api';
import { cn } from '@/lib/utils';

type ComboFormInput = z.input<typeof createComboRequestSchema>;
type ComboFormValues = z.output<typeof createComboRequestSchema>;

/** Digits only → the number, or `undefined` for an empty input (so the schema says "required"). */
const parseVnd = (text: unknown): number | undefined => {
  const raw = typeof text === 'number' ? String(text) : typeof text === 'string' ? text : '';
  const digits = raw.replace(/\D/g, '');
  return digits === '' ? undefined : Number(digits);
};

function useRefreshCombos() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: comboKeys.admin });
}

function AddComboForm() {
  const refresh = useRefreshCombos();
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ComboFormInput, unknown, ComboFormValues>({
    resolver: zodResolver(createComboRequestSchema),
    defaultValues: { name: '', description: '' },
  });

  const onSubmit = async (values: ComboFormValues) => {
    try {
      await createCombo(values);
      reset({ name: '', description: '', price: undefined });
      await refresh();
    } catch (error) {
      const message = catalogErrorMessage(error);
      setError(errorCodeOf(error) === 'VALIDATION_FAILED' ? 'price' : 'name', { message });
    }
  };

  return (
    <form
      noValidate
      aria-label="Thêm combo"
      onSubmit={(e) => void handleSubmit(onSubmit)(e)}
      className="mb-6 grid gap-4 rounded-2xl border border-white/10 bg-surface p-5 md:grid-cols-[1fr_180px_1.4fr_auto] md:items-start"
    >
      <FormField label="Tên combo" error={errors.name}>
        <Input
          placeholder="Ví dụ: Combo bắp nước"
          maxLength={COMBO_LIMITS.nameMax}
          {...register('name')}
        />
      </FormField>
      <FormField label="Giá (VND)" error={errors.price}>
        <Input
          inputMode="numeric"
          placeholder="89.000"
          {...register('price', { setValueAs: parseVnd })}
        />
      </FormField>
      <FormField label="Mô tả (không bắt buộc)" error={errors.description}>
        <Input
          placeholder="1 bắp ngọt lớn, 2 nước ngọt"
          maxLength={COMBO_LIMITS.descriptionMax}
          {...register('description')}
        />
      </FormField>
      <Button
        type="submit"
        disabled={isSubmitting}
        className="h-11 rounded-xl px-4 font-semibold md:mt-7"
      >
        {isSubmitting ? <Loader2 className="animate-spin" aria-hidden /> : <Plus aria-hidden />}
        Thêm
      </Button>
    </form>
  );
}

function ComboRow({ combo, onDelete }: { combo: AdminCombo; onDelete: () => void }) {
  const refresh = useRefreshCombos();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(combo.name);
  const [price, setPrice] = useState(formatVnd(combo.price));
  const [description, setDescription] = useState(combo.description ?? '');

  const save = useMutation({
    mutationFn: (body: z.input<typeof updateComboRequestSchema>) => updateCombo(combo.id, body),
    onSuccess: async () => {
      await refresh();
      setEditing(false);
    },
  });
  const toggle = useMutation({
    mutationFn: () => updateCombo(combo.id, { isActive: !combo.isActive }),
    onSuccess: refresh,
  });

  const parsed = updateComboRequestSchema.safeParse({
    name,
    price: parseVnd(price),
    description,
  });
  const localError = editing && !parsed.success ? parsed.error.issues[0]?.message : undefined;
  const error =
    localError ??
    (save.error ? catalogErrorMessage(save.error) : undefined) ??
    (toggle.error ? catalogErrorMessage(toggle.error) : undefined);

  const cancelEdit = () => {
    setEditing(false);
    setName(combo.name);
    setPrice(formatVnd(combo.price));
    setDescription(combo.description ?? '');
    save.reset();
  };

  return (
    <tr data-combo={combo.name} className={cn('align-top', !combo.isActive && 'opacity-70')}>
      {editing ? (
        <td colSpan={2} className="px-4 py-3">
          <form
            aria-label={`Sửa ${combo.name}`}
            className="grid gap-2 sm:grid-cols-[1fr_140px]"
            onSubmit={(e) => {
              e.preventDefault();
              if (parsed.success) save.mutate(parsed.data);
            }}
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="Tên combo"
              maxLength={COMBO_LIMITS.nameMax}
              className="h-9"
              autoFocus
            />
            <Input
              value={price}
              inputMode="numeric"
              onChange={(e) => {
                const value = parseVnd(e.target.value);
                setPrice(value === undefined ? '' : formatVnd(value));
              }}
              aria-label="Giá (VND)"
              className="h-9 text-right tabular-nums"
            />
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              aria-label="Mô tả"
              maxLength={COMBO_LIMITS.descriptionMax}
              className="h-9 sm:col-span-2"
            />
            <div className="flex gap-1 sm:col-span-2">
              <Button
                type="submit"
                size="sm"
                className="rounded-lg"
                disabled={save.isPending || !parsed.success}
              >
                {save.isPending ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <Check aria-hidden />
                )}
                Lưu
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="rounded-lg"
                onClick={cancelEdit}
              >
                <X aria-hidden />
                Hủy
              </Button>
            </div>
          </form>
          {error && (
            <p role="alert" className="mt-1 text-sm text-destructive">
              {error}
            </p>
          )}
        </td>
      ) : (
        <>
          <td className="px-4 py-3">
            <span className="font-medium text-cream">{combo.name}</span>
            {combo.description && (
              <span className="block text-xs text-muted-foreground">{combo.description}</span>
            )}
            {error && (
              <p role="alert" className="mt-1 text-sm text-destructive">
                {error}
              </p>
            )}
          </td>
          <td className="px-4 py-3 text-right text-cream tabular-nums">
            {formatVnd(combo.price)} ₫
          </td>
        </>
      )}
      <td className="px-4 py-3">
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={combo.isActive}
          aria-label={`${combo.isActive ? 'Tắt' : 'Bật'} combo ${combo.name}`}
          disabled={toggle.isPending}
          onClick={() => toggle.mutate()}
          className={cn(
            'rounded-full border px-3',
            combo.isActive
              ? 'border-brand/40 bg-brand/10 text-brand hover:bg-brand/20 hover:text-brand'
              : 'border-white/15 text-muted-foreground',
          )}
        >
          {toggle.isPending ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : combo.isActive ? (
            <Power aria-hidden />
          ) : (
            <EyeOff aria-hidden />
          )}
          {combo.isActive ? 'Đang bán' : 'Đã tắt'}
        </Button>
      </td>
      <td className="px-4 py-3 text-cream tabular-nums">{combo.bookingCount}</td>
      <td className="px-4 py-3">
        {!editing && (
          <div className="flex justify-end gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="rounded-lg"
              aria-label={`Sửa combo ${combo.name}`}
              onClick={() => setEditing(true)}
            >
              <Pencil aria-hidden />
              Sửa
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="rounded-lg text-destructive hover:text-destructive"
              aria-label={`Xóa combo ${combo.name}`}
              onClick={onDelete}
            >
              <Trash2 aria-hidden />
              Xóa
            </Button>
          </div>
        )}
      </td>
    </tr>
  );
}

function DeleteComboDialog({ combo, onClose }: { combo: AdminCombo | null; onClose: () => void }) {
  const refresh = useRefreshCombos();
  const remove = useMutation({
    mutationFn: (id: string) => deleteCombo(id),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });
  const switchOff = useMutation({
    mutationFn: (id: string) => updateCombo(id, { isActive: false }),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });
  const inUse = errorCodeOf(remove.error) === ComboErrorCode.COMBO_IN_USE;

  return (
    <AlertDialog
      open={combo !== null}
      onOpenChange={(open) => {
        if (open) return;
        remove.reset();
        switchOff.reset();
        onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogTitle>Xóa combo?</AlertDialogTitle>
        <AlertDialogDescription>
          Combo <strong className="text-cream">{combo?.name}</strong> sẽ bị xóa. Chỉ xóa được combo
          chưa có trong đơn đặt vé nào; nếu đã có, hãy tắt combo để ẩn khỏi khách hàng.
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
          {inUse && combo?.isActive ? (
            <Button
              className="rounded-xl"
              disabled={switchOff.isPending}
              onClick={() => switchOff.mutate(combo.id)}
            >
              {switchOff.isPending && <Loader2 className="animate-spin" aria-hidden />}
              Tắt combo
            </Button>
          ) : (
            <Button
              variant="destructive"
              className="rounded-xl"
              disabled={remove.isPending || inUse}
              onClick={() => combo && remove.mutate(combo.id)}
            >
              {remove.isPending && <Loader2 className="animate-spin" aria-hidden />}
              Xóa combo
            </Button>
          )}
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function AdminCombosPage() {
  const { data, isPending, error, refetch } = useAdminCombos();
  const [toDelete, setToDelete] = useState<AdminCombo | null>(null);

  return (
    <AdminShell
      title="Combo"
      description={`Bắp nước bán kèm vé, giá từ ${formatVnd(COMBO_LIMITS.priceMin)} ₫ đến ${formatVnd(COMBO_LIMITS.priceMax)} ₫. Đơn đã đặt giữ nguyên tên và giá lúc đặt.`}
    >
      <AddComboForm />
      {isPending ? (
        <div
          role="status"
          aria-label="Đang tải"
          className="h-48 animate-pulse rounded-2xl bg-white/5"
        />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : data.length === 0 ? (
        <EmptyState title="Chưa có combo nào" />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-white/10 bg-surface">
          <table className="w-full min-w-[720px] text-left text-sm">
            <caption className="sr-only">Danh sách combo</caption>
            <thead className="border-b border-white/10 text-xs text-muted-foreground uppercase">
              <tr>
                <th scope="col" className="px-4 py-3">
                  Combo
                </th>
                <th scope="col" className="px-4 py-3 text-right">
                  Giá
                </th>
                <th scope="col" className="px-4 py-3">
                  Trạng thái
                </th>
                <th scope="col" className="px-4 py-3">
                  Số đơn
                </th>
                <th scope="col" className="px-4 py-3">
                  <span className="sr-only">Thao tác</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {data.map((combo) => (
                <ComboRow
                  key={`${combo.id}:${combo.updatedAt}`}
                  combo={combo}
                  onDelete={() => setToDelete(combo)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <DeleteComboDialog combo={toDelete} onClose={() => setToDelete(null)} />
    </AdminShell>
  );
}
