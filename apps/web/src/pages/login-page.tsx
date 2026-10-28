import { zodResolver } from '@hookform/resolvers/zod';
import { type LoginRequest, loginRequestSchema } from '@ticketify/shared';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useLocation, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { login } from '@/features/auth/auth-api';
import { AuthCard, FormAlert } from '@/features/auth/auth-card';
import { authErrorMessage } from '@/features/auth/auth-errors';
import type { FromState } from '@/features/auth/route-guards';

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as FromState | null)?.from ?? '/';
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm({ resolver: zodResolver(loginRequestSchema) });

  const onSubmit = async (values: LoginRequest) => {
    setFormError(null);
    try {
      await login(values);
      await navigate(from, { replace: true });
    } catch (error) {
      setFormError(authErrorMessage(error));
    }
  };

  return (
    <AuthCard
      title="Đăng nhập"
      description="Đăng nhập để đặt vé và xem lịch sử vé của bạn."
      footer={
        <>
          Chưa có tài khoản?{' '}
          <Link
            to="/register"
            state={{ from } satisfies FromState}
            className="font-semibold text-brand hover:underline"
          >
            Đăng ký
          </Link>
        </>
      }
    >
      <form noValidate onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="space-y-4">
        <FormAlert message={formError} />
        <FormField label="Email" error={errors.email}>
          <Input
            type="email"
            autoComplete="email"
            placeholder="ban@example.com"
            {...register('email')}
          />
        </FormField>
        <FormField label="Mật khẩu" error={errors.password}>
          <Input type="password" autoComplete="current-password" {...register('password')} />
        </FormField>
        <Button
          type="submit"
          disabled={isSubmitting}
          className="h-11 w-full rounded-xl text-sm font-semibold"
        >
          {isSubmitting && <Loader2 className="animate-spin" aria-hidden />}
          Đăng nhập
        </Button>
      </form>
    </AuthCard>
  );
}
