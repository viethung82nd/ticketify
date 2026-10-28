import { Role } from '@ticketify/shared';
import { createBrowserRouter } from 'react-router';
import { AppLayout } from '@/components/layout/app-layout';
import { GuestOnly, RequireAuth } from '@/features/auth/route-guards';
import { HomePage } from '@/pages/home-page';
import { LoginPage } from '@/pages/login-page';
import { NotFoundPage } from '@/pages/not-found-page';
import { RegisterPage } from '@/pages/register-page';
import { AdminPage, ForbiddenPage, StaffPage } from '@/pages/role-pages';
import { StatusPage } from '@/pages/status-page';

export const router = createBrowserRouter([
  {
    element: <AppLayout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'status', element: <StatusPage /> },
      { path: 'forbidden', element: <ForbiddenPage /> },
      {
        element: <GuestOnly />,
        children: [
          { path: 'login', element: <LoginPage /> },
          { path: 'register', element: <RegisterPage /> },
        ],
      },
      {
        element: <RequireAuth roles={[Role.ADMIN]} />,
        children: [{ path: 'admin', element: <AdminPage /> }],
      },
      {
        element: <RequireAuth roles={[Role.STAFF, Role.ADMIN]} />,
        children: [{ path: 'staff', element: <StaffPage /> }],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
