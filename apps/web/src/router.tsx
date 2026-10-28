import { Role } from '@ticketify/shared';
import { createBrowserRouter, Navigate } from 'react-router';
import { AppLayout } from '@/components/layout/app-layout';
import { GuestOnly, RequireAuth } from '@/features/auth/route-guards';
import { AdminGenresPage } from '@/pages/admin/admin-genres-page';
import { AdminMoviesPage } from '@/pages/admin/admin-movies-page';
import { AdminPricingPage } from '@/pages/admin/admin-pricing-page';
import { AdminRoomsPage } from '@/pages/admin/admin-rooms-page';
import { EditMoviePage, NewMoviePage } from '@/pages/admin/movie-form-page';
import { RoomEditorPage } from '@/pages/admin/room-editor-page';
import { NewRoomPage } from '@/pages/admin/room-form-page';
import { HomePage } from '@/pages/home-page';
import { LoginPage } from '@/pages/login-page';
import { MovieDetailPage } from '@/pages/movie-detail-page';
import { MoviesPage } from '@/pages/movies-page';
import { NotFoundPage } from '@/pages/not-found-page';
import { RegisterPage } from '@/pages/register-page';
import { ForbiddenPage, StaffPage } from '@/pages/role-pages';
import { StatusPage } from '@/pages/status-page';

export const router = createBrowserRouter([
  {
    element: <AppLayout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'movies', element: <MoviesPage /> },
      { path: 'movies/:slug', element: <MovieDetailPage /> },
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
        children: [
          { path: 'admin', element: <Navigate to="/admin/movies" replace /> },
          { path: 'admin/movies', element: <AdminMoviesPage /> },
          { path: 'admin/movies/new', element: <NewMoviePage /> },
          { path: 'admin/movies/:id/edit', element: <EditMoviePage /> },
          { path: 'admin/genres', element: <AdminGenresPage /> },
          { path: 'admin/rooms', element: <AdminRoomsPage /> },
          { path: 'admin/rooms/new', element: <NewRoomPage /> },
          { path: 'admin/rooms/:id', element: <RoomEditorPage /> },
          { path: 'admin/pricing', element: <AdminPricingPage /> },
        ],
      },
      {
        element: <RequireAuth roles={[Role.STAFF, Role.ADMIN]} />,
        children: [{ path: 'staff', element: <StaffPage /> }],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
