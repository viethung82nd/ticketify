import { useId, type ReactElement, cloneElement } from 'react';
import type { FieldError } from 'react-hook-form';

interface FormFieldProps {
  label: string;
  error?: FieldError;
  hint?: string;
  /** A single input; receives `id`, `aria-invalid` and `aria-describedby`. */
  children: ReactElement<{
    id?: string;
    'aria-invalid'?: boolean;
    'aria-describedby'?: string;
  }>;
}

/** Label + input + hint/error, wired for screen readers. */
export function FormField({ label, error, hint, children }: FormFieldProps) {
  const id = useId();
  const messageId = `${id}-message`;
  const message = error?.message ?? hint;

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-cream">
        {label}
      </label>
      {cloneElement(children, {
        id,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': message ? messageId : undefined,
      })}
      {message && (
        <p
          id={messageId}
          className={error ? 'text-sm text-destructive' : 'text-xs text-muted-foreground'}
        >
          {message}
        </p>
      )}
    </div>
  );
}
