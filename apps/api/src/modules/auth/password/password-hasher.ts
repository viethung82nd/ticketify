import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

/**
 * argon2id password hashing (library defaults: argon2id, m=19 MiB, t=2, p=1 — OWASP baseline;
 * the dev seed uses the same defaults).
 */
@Injectable()
export class PasswordHasher {
  private dummyHash?: Promise<string>;

  hash(password: string): Promise<string> {
    return hash(password);
  }

  /** `false` for a wrong password and also for a malformed/corrupted hash (never throws). */
  async matches(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  /**
   * Spends the same time as a real verification. Used when the email does not exist so
   * response timing does not reveal which emails are registered.
   */
  async burnTime(password: string): Promise<void> {
    this.dummyHash ??= hash('ticketify-timing-equalizer');
    await this.matches(await this.dummyHash, password);
  }
}
