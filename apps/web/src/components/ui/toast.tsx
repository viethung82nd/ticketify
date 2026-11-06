import { Toast as ToastPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';
import { type ToastTone, useToastStore } from './toast-store';

/**
 * Short-lived messages in the corner of the screen (Radix Toast: an `aria-live` region that
 * pauses on hover and focus and closes with Esc). Nothing important may live only in a toast — a
 * notification that matters is also in the bell and in the list.
 *
 * Mounted once, in the app layout; it renders whatever is in `useToastStore`.
 */

const TONE_CLASS: Record<ToastTone, string> = {
  success: 'border-brand/40',
  warning: 'border-amber-400/50',
  info: 'border-white/15',
};

const DURATION_MS = 8_000;

export function Toaster() {
  const toasts = useToastStore((state) => state.toasts);
  const dismiss = useToastStore((state) => state.dismiss);

  return (
    <ToastPrimitive.Provider duration={DURATION_MS} swipeDirection="right">
      {toasts.map((item) => (
        <ToastPrimitive.Root
          key={item.id}
          open
          onOpenChange={(open) => {
            if (!open) dismiss(item.id);
          }}
          className={cn(
            'relative rounded-xl border bg-surface p-4 pr-8 shadow-xl backdrop-blur',
            'data-[state=open]:animate-in data-[state=open]:slide-in-from-right-4',
            'data-[swipe=end]:animate-out data-[swipe=end]:slide-out-to-right-full',
            TONE_CLASS[item.tone],
          )}
        >
          <ToastPrimitive.Title className="text-sm font-semibold text-cream">
            {item.title}
          </ToastPrimitive.Title>
          {item.description && (
            <ToastPrimitive.Description className="mt-1 text-sm text-muted-foreground">
              {item.description}
            </ToastPrimitive.Description>
          )}
          {item.to && (
            <ToastPrimitive.Action asChild altText="Xem chi tiết">
              <a
                href={item.to}
                className="mt-2 inline-block text-sm font-semibold text-brand hover:underline"
              >
                Xem chi tiết
              </a>
            </ToastPrimitive.Action>
          )}
          <ToastPrimitive.Close
            aria-label="Đóng thông báo"
            className="absolute right-2 top-2 rounded-full px-2 text-muted-foreground transition-colors hover:text-cream"
          >
            ×
          </ToastPrimitive.Close>
        </ToastPrimitive.Root>
      ))}
      <ToastPrimitive.Viewport className="fixed bottom-4 right-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 outline-none" />
    </ToastPrimitive.Provider>
  );
}
