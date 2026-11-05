import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../../config/app-config.service';
import { vnpayDate } from './vnpay-format';
import {
  type QuerydrAnswer,
  QuerydrVerdict,
  querydrBody,
  readQuerydrAnswer,
} from './vnpay-querydr';

/** What the caller knows about the payment attempt it is asking VNPay about. */
export interface QuerydrLookUp {
  /** `vnp_TxnRef` of the attempt. */
  txnRef: string;
  /** When the payment URL was built (`Payment.createdAt`): VNPay's `vnp_TransactionDate`. */
  paymentCreatedAt: Date;
  /** Goes into `vnp_OrderInfo`; unaccented, as VNPay asks. */
  orderInfo: string;
  /** "Now" on the caller's clock, for `vnp_CreateDate`. */
  now: Date;
}

/**
 * Asks VNPay about one payment attempt (`vnp_Command=querydr`, ROADMAP 3.7). Used by the booking
 * expiry **outside** any transaction (PLAN §4): an HTTP call must never run while row locks are
 * held.
 *
 * Never throws and never rejects: a network error, a timeout, a non-JSON body or an unverifiable
 * signature all come back as `QuerydrVerdict.UNKNOWN` with a `warn` in the log, and the caller
 * expires the booking exactly as it did before 3.7. The only way this makes the expiry change its
 * mind is a response that is signed with the merchant secret and says the payment went through.
 */
@Injectable()
export class VnpayQuerydrClient {
  private readonly logger = new Logger(VnpayQuerydrClient.name);

  constructor(private readonly config: AppConfig) {}

  /** `false` when `VNPAY_TMN_CODE` or `VNPAY_HASH_SECRET` is unset: no query can be signed. */
  get configured(): boolean {
    return Boolean(this.config.get('VNPAY_TMN_CODE') && this.config.get('VNPAY_HASH_SECRET'));
  }

  async lookUp(input: QuerydrLookUp): Promise<QuerydrAnswer> {
    const tmnCode = this.config.get('VNPAY_TMN_CODE');
    const hashSecret = this.config.get('VNPAY_HASH_SECRET');
    if (!tmnCode || !hashSecret) {
      // Expected in dev and in CI: the sandbox credentials are registered by hand (see README).
      return this.unknown(
        input.txnRef,
        'VNPAY_TMN_CODE or VNPAY_HASH_SECRET is not set: querydr skipped',
      );
    }

    const url = this.config.get('VNPAY_API_URL');
    const body = querydrBody(
      {
        tmnCode,
        txnRef: input.txnRef,
        transactionDate: vnpayDate(input.paymentCreatedAt),
        createDate: vnpayDate(input.now),
        orderInfo: input.orderInfo,
      },
      hashSecret,
    );

    let payload: unknown;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.get('VNPAY_QUERYDR_TIMEOUT_MS')),
      });
      if (!response.ok) {
        return this.unknown(input.txnRef, `querydr answered HTTP ${response.status}`);
      }
      payload = await response.json();
    } catch (error) {
      // AbortError (timeout), DNS, TLS, connection reset, a body that is not JSON.
      return this.unknown(
        input.txnRef,
        `querydr could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return this.unknown(input.txnRef, 'querydr answered something that is not a JSON object');
    }

    const answer = readQuerydrAnswer(payload as Record<string, unknown>, input.txnRef, hashSecret);
    const line =
      `querydr ${input.txnRef}: ${answer.verdict} — ${answer.reason} ` +
      `(vnp_ResponseCode ${answer.responseCode ?? '-'}, ` +
      `vnp_TransactionStatus ${answer.transactionStatus ?? '-'})`;
    if (answer.verdict === QuerydrVerdict.UNKNOWN) this.logger.warn(line);
    else this.logger.log(line);
    return answer;
  }

  private unknown(txnRef: string, reason: string): QuerydrAnswer {
    this.logger.warn(`querydr ${txnRef}: unknown — ${reason}; expiring as usual`);
    return {
      verdict: QuerydrVerdict.UNKNOWN,
      params: {},
      responseCode: null,
      transactionStatus: null,
      reason,
    };
  }
}
