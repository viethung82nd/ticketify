import { QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import { RouterProvider } from 'react-router/dom';
import { startSession } from '@/features/auth/session';
import { queryClient } from '@/lib/query-client';
import { router } from '@/router';

export function App() {
  // Restore the session from the refresh cookie once (startSession ignores repeat calls).
  useEffect(() => startSession(), []);
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
