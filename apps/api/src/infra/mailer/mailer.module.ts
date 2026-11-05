import { Global, Module } from '@nestjs/common';
import { Mailer } from './mailer';
import { SmtpMailer } from './smtp-mailer';

/** Provides `Mailer`. Tests override it with `FakeMailer`. */
@Global()
@Module({
  providers: [{ provide: Mailer, useClass: SmtpMailer }],
  exports: [Mailer],
})
export class MailerModule {}
