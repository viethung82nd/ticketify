import { PasswordHasher } from './password-hasher';

describe('PasswordHasher (argon2id)', () => {
  const hasher = new PasswordHasher();

  it('hashes with argon2id and a random salt', async () => {
    const [first, second] = await Promise.all([
      hasher.hash('correct horse battery'),
      hasher.hash('correct horse battery'),
    ]);

    expect(first).toMatch(/^\$argon2id\$v=19\$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain('correct horse battery');
  });

  it('matches the right password and rejects a wrong one', async () => {
    const hash = await hasher.hash('correct horse battery');

    await expect(hasher.matches(hash, 'correct horse battery')).resolves.toBe(true);
    await expect(hasher.matches(hash, 'Correct horse battery')).resolves.toBe(false);
  });

  it.each([
    ['empty', ''],
    ['not argon2', 'not-a-real-hash'],
    ['truncated', '$argon2id$v=19$m=19456,t=2,p=1$abc'],
  ])('returns false instead of throwing for a %s hash', async (_label, broken) => {
    await expect(hasher.matches(broken, 'whatever')).resolves.toBe(false);
  });

  it('burnTime() performs a real verification and resolves', async () => {
    const matches = jest.spyOn(hasher, 'matches');

    await expect(hasher.burnTime('some password')).resolves.toBeUndefined();
    await hasher.burnTime('another');

    expect(matches).toHaveBeenCalledTimes(2);
    const [dummyHash] = matches.mock.calls[0] ?? [];
    expect(dummyHash).toMatch(/^\$argon2id\$/);
    // The dummy hash is computed once and reused.
    expect(matches.mock.calls[1]?.[0]).toBe(dummyHash);
  });
});
