import axios from 'axios';
import { env } from './env';

/** Shared HTTP client for the Ticketify API. */
export const apiClient = axios.create({
  baseURL: env.VITE_API_URL,
  timeout: 10_000,
  // Refresh tokens will travel in an httpOnly cookie (phase 1).
  withCredentials: true,
  headers: { Accept: 'application/json' },
});
