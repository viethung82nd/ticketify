import { zodResolver } from '@hookform/resolvers/zod';
import { AUTH_LIMITS, type RegisterRequest, registerRequestSchema } from '@ticketify/shared';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useLocation, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { register as registerAccount } from '@/features/auth/auth-api';
import { AuthCard, FormAlert } from '@/features/auth/auth-card';
import { authErrorMessage } from '@/features/auth/auth-errors';
import type { FromState } from '@/features/auth/route-guards';

/** An empty optional input means "not provided", not "invalid". */
const blankAsUndefined = (value: string): string | undefined =>
  value.trim() === '' ? undefined : value;

export function RegisterPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as FromState | null)?.from ?? '/';
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm({ resolver: zodResolver(registerRequestSchema) });

  const onSubmit = async (values: RegisterRequest) => {
    setFormError(null);
    try {
      await registerAccount(values);
      await navigate(from, { replace: true });
    } catch (error) {
      setFormError(authErrorMessage(error));
    }
  };

  return (
    <AuthCard
      title="Tạo tài khoản"
      description="Chỉ mất một phút. Bạn sẽ được đăng nhập ngay sau khi đăng ký."
      footer={
        <>
          Đã có tài khoản?{' '}
          <Link
            to="/login"
            state={{ from } satisfies FromState}
            className="font-semibold text-brand hover:underline"
          >
            Đăng nhập
          </Link>
        </>
      }
    >
      <form noValidate onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="space-y-4">
        <FormAlert message={formError} />
        <FormField label="Họ và tên" error={errors.fullName}>
          <Input autoComplete="name" placeholder="Nguyễn Văn An" {...register('fullName')} />
        </FormField>
        <FormField label="Email" error={errors.email}>
          <Input
            type="email"
            autoComplete="email"
            placeholder="ban@example.com"
            {...register('email')}
          />
        </FormField>
        <FormField label="Số điện thoại (không bắt buộc)" error={errors.phone}>
          <Input
            type="tel"
            autoComplete="tel"
            placeholder="0912345678"
            {...register('phone', { setValueAs: blankAsUndefined })}
          />
        </FormField>
        <FormField
          label="Mật khẩu"
          error={errors.password}
          hint={`Ít nhất ${AUTH_LIMITS.passwordMin} ký tự.`}
        >
          <Input type="password" autoComplete="new-password" {...register('password')} />
        </FormField>
        <Button
          type="submit"
          disabled={isSubmitting}
          className="h-11 w-full rounded-xl text-sm font-semibold"
        >
          {isSubmitting && <Loader2 className="animate-spin" aria-hidden />}
          Đăng ký
        </Button>
      </form>
    </AuthCard>
  );
}
