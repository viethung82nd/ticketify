import { createBrowserRouter } from 'react-router';
import { AppLayout } from '@/components/layout/app-layout';
import { HomePage } from '@/pages/home-page';
import { NotFoundPage } from '@/pages/not-found-page';
import { StatusPage } from '@/pages/status-page';

export const router = createBrowserRouter([
  {
    element: <AppLayout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'status', element: <StatusPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
