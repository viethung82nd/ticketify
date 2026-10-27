import { z } from 'zod';

const envSchema = z.object({
  /** Base URL of the Ticketify API (called cross-origin, so CORS must allow this app). */
  VITE_API_URL: z.url().default('http://localhost:3000'),
});

const parsed = envSchema.safeParse(import.meta.env);
if (!parsed.success) {
  throw new Error(`Invalid web environment:\n${z.prettifyError(parsed.error)}`);
}

export const env = parsed.data;
