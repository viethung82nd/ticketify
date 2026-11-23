import { Injectable } from '@nestjs/common';
import { AppConfig } from '../../../config/app-config.service';

/** Everything the SePay flow needs; only `webhookSecret` is secret. */
export interface SepaySettings {
  webhookSecret: string;
  accountNumber: string;
  bankCode: string;
  accountHolder: string | null;
  paymentCodePrefix: string;
}

/**
 * The SePay settings, read per call like the other gateways' (`MomoClient.merchant`). `null` when
 * the webhook secret, the account number or the bank is missing: SePay is then off as a whole — a
 * QR whose transfer could never be verified is not handed out, and the webhook settles nothing.
 */
@Injectable()
export class SepayConfig {
  constructor(private readonly config: AppConfig) {}

  settings(): SepaySettings | null {
    const webhookSecret = this.config.get('SEPAY_WEBHOOK_SECRET');
    const accountNumber = this.config.get('SEPAY_BANK_ACCOUNT_NUMBER');
    const bankCode = this.config.get('SEPAY_BANK_CODE');
    if (!webhookSecret || !accountNumber || !bankCode) return null;
    return {
      webhookSecret,
      accountNumber,
      bankCode,
      accountHolder: this.config.get('SEPAY_ACCOUNT_HOLDER') ?? null,
      paymentCodePrefix: this.config.get('SEPAY_PAYMENT_CODE_PREFIX'),
    };
  }
}
