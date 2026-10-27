import { z } from 'zod';

const password = z.string().min(8, { error: 'must be at least 8 characters' });

/** Variables used only by the development seed (also documented in .env.example). */
export const seedEnvSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, error: 'must be a postgresql:// URL' }),
  SEED_ADMIN_PASSWORD: password,
  SEED_STAFF_PASSWORD: password,
  SEED_USER_PASSWORD: password,
});

export type SeedEnv = z.infer<typeof seedEnvSchema>;

export function loadSeedEnv(raw: Record<string, unknown>): SeedEnv {
  if (raw.NODE_ENV === 'production') {
    throw new Error('Refusing to run the development seed with NODE_ENV=production.');
  }
  const result = seedEnvSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid seed configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
