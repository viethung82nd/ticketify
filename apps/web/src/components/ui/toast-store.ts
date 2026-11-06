import { create } from 'zustand';

/**
 * The queue of toasts on screen. Separate from `<Toaster />` so anything — a socket handler, a
 * mutation — can raise one without importing a component (and so Vite's fast refresh keeps
 * working on the component file).
 */

export type ToastTone = 'success' | 'warning' | 'info';

export interface ToastMessage {
  id: string;
  tone: ToastTone;
  title: string;
  description?: string;
  /** Where clicking the toast's action takes the reader, if anywhere. */
  to?: string;
}

export type NewToast = Omit<ToastMessage, 'id'> & { id?: string };

interface ToastStore {
  toasts: ToastMessage[];
  show: (toast: NewToast) => void;
  dismiss: (id: string) => void;
}

let counter = 0;

/**
 * An `id` given by the caller replaces the toast with that id instead of stacking a second one,
 * so a repeated event (a socket that reconnected and replayed) cannot pile up.
 */
export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  show: ({ id, ...toast }) => {
    counter += 1;
    const key = id ?? `toast-${counter}`;
    set((state) => ({
      toasts: [...state.toasts.filter((item) => item.id !== key), { ...toast, id: key }],
    }));
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) })),
}));

/** Shows one toast from anywhere, inside a component or not. */
export const toast = (message: NewToast): void => useToastStore.getState().show(message);
