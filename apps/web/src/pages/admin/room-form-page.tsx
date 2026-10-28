import { zodResolver } from '@hookform/resolvers/zod';
import {
  type CreateRoomRequest,
  createRoomRequestSchema,
  ROOM_LIMITS,
  RoomErrorCode,
} from '@ticketify/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { type FieldPath, useForm, useWatch } from 'react-hook-form';
import { Link, useNavigate } from 'react-router';
import { AdminShell } from '@/components/admin/admin-shell';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { FormAlert } from '@/features/auth/auth-card';
import { catalogErrorMessage, errorCodeOf, errorFieldsOf } from '@/features/catalog/catalog-errors';
import { createRoom } from '@/features/rooms/rooms-api';
import { roomKeys } from '@/features/rooms/use-rooms';

const FORM_FIELDS: FieldPath<CreateRoomRequest>[] = ['name', 'rows', 'cols'];
const isFormField = (field: string): field is FieldPath<CreateRoomRequest> =>
  (FORM_FIELDS as string[]).includes(field);

/** Messages for fields the API refused with 400 (same limits as the zod schema). */
const FIELD_MESSAGES: Record<FieldPath<CreateRoomRequest>, string> = {
  name: `Tên phòng từ 1 đến ${ROOM_LIMITS.nameMax} ký tự`,
  rows: `Số hàng từ ${ROOM_LIMITS.rowsMin} đến ${ROOM_LIMITS.rowsMax}`,
  cols: `Số cột từ ${ROOM_LIMITS.colsMin} đến ${ROOM_LIMITS.colsMax}`,
};

export function NewRoomPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CreateRoomRequest>({
    resolver: zodResolver(createRoomRequestSchema),
    defaultValues: { name: '', rows: 10, cols: 12 },
  });
  const [rows, cols] = useWatch({ control, name: ['rows', 'cols'] });
  const seatCount = Number.isInteger(rows) && Number.isInteger(cols) ? rows * cols : null;

  const onSubmit = async (values: CreateRoomRequest) => {
    setFormError(null);
    try {
      const room = await createRoom(values);
      await queryClient.invalidateQueries({ queryKey: roomKeys.all });
      await navigate(`/admin/rooms/${room.id}`);
    } catch (error) {
      if (errorCodeOf(error) === RoomErrorCode.ROOM_NAME_TAKEN) {
        setError('name', { message: catalogErrorMessage(error) });
        return;
      }
      const fields = errorFieldsOf(error).filter(isFormField);
      for (const field of fields) setError(field, { message: FIELD_MESSAGES[field] });
      setFormError(catalogErrorMessage(error));
    }
  };

  return (
    <AdminShell
      title="Thêm phòng"
      description="Mọi ghế được tạo là ghế thường và đang bật. Sửa loại ghế ở bước tiếp theo."
    >
      <form
        noValidate
        onSubmit={(e) => void handleSubmit(onSubmit)(e)}
        className="max-w-xl space-y-5 rounded-2xl border border-white/10 bg-surface p-6"
      >
        <FormAlert message={formError} />
        <FormField label="Tên phòng" error={errors.name}>
          <Input
            placeholder="Ví dụ: Phòng 2"
            maxLength={ROOM_LIMITS.nameMax}
            {...register('name')}
          />
        </FormField>
        <div className="grid gap-5 sm:grid-cols-2">
          <FormField
            label="Số hàng"
            error={errors.rows}
            hint={`Từ ${ROOM_LIMITS.rowsMin} đến ${ROOM_LIMITS.rowsMax} (hàng A–Z).`}
          >
            <Input
              type="number"
              inputMode="numeric"
              min={ROOM_LIMITS.rowsMin}
              max={ROOM_LIMITS.rowsMax}
              {...register('rows', { valueAsNumber: true })}
            />
          </FormField>
          <FormField
            label="Số cột"
            error={errors.cols}
            hint={`Từ ${ROOM_LIMITS.colsMin} đến ${ROOM_LIMITS.colsMax} ghế mỗi hàng.`}
          >
            <Input
              type="number"
              inputMode="numeric"
              min={ROOM_LIMITS.colsMin}
              max={ROOM_LIMITS.colsMax}
              {...register('cols', { valueAsNumber: true })}
            />
          </FormField>
        </div>
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {seatCount === null ? ' ' : `Phòng sẽ có ${seatCount} ghế.`}
        </p>
        <div className="flex gap-2">
          <Button
            type="submit"
            disabled={isSubmitting}
            className="h-11 rounded-xl px-5 font-semibold"
          >
            {isSubmitting && <Loader2 className="animate-spin" aria-hidden />}
            Tạo phòng
          </Button>
          <Button asChild variant="outline" className="h-11 rounded-xl px-5">
            <Link to="/admin/rooms">Hủy</Link>
          </Button>
        </div>
      </form>
    </AdminShell>
  );
}
