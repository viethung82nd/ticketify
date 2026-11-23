import { Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { MomoPaymentService } from './momo/momo-payment.service';
import { MomoPaymentsController } from './momo/momo-payments.controller';
import type { PaymentRateLimiter } from './payment-rate-limiter';
import type { SepayPaymentService } from './sepay/sepay-payment.service';
import { SepayPaymentsController } from './sepay/sepay-payments.controller';

/**
 * What the two gateway callbacks answer, as seen by MoMo and SePay. The answer decides whether the
 * gateway calls again: a 500 must stay a 500 (retry), never a "handled" or an API error body that
 * the gateway would read as final. The services' own decisions are tested in their specs.
 */

function response() {
  const res = { status: jest.fn(), json: jest.fn(), end: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

let errors: jest.SpyInstance;
beforeEach(() => {
  errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('POST /payments/momo/ipn', () => {
  const controller = (ipn: jest.Mock) =>
    new MomoPaymentsController(
      { ipn } as unknown as MomoPaymentService,
      {} as unknown as PaymentRateLimiter,
    );

  it('204 without a body once the IPN is handled', async () => {
    const res = response();
    await controller(jest.fn().mockResolvedValue({ acknowledged: true })).momoIpn(
      { orderId: 'o-1' },
      res as unknown as Response,
    );
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.end).toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('400 with the reason when the body does not verify', async () => {
    const res = response();
    await controller(
      jest.fn().mockResolvedValue({ acknowledged: false, reason: 'invalid signature' }),
    ).momoIpn({ orderId: 'o-1' }, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: 'invalid signature' });
  });

  it('an unexpected error is a 500 MoMo retries, logged with the orderId, details kept out', async () => {
    const res = response();
    await controller(jest.fn().mockRejectedValue(new Error('db down: secret detail'))).momoIpn(
      { orderId: 'gEV4gr9uHQT9uVBxsetK', amount: 90000 },
      res as unknown as Response,
    );
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: 'Unknown error' });
    expect(errors).toHaveBeenCalledWith(
      'MoMo IPN 500 for orderId gEV4gr9uHQT9uVBxsetK, nothing written',
      expect.stringContaining('db down'),
    );
  });

  it('a 500 for a body that is not an object logs "-" and caps a long orderId', async () => {
    for (const [body, logged] of [
      ['not json', '-'],
      [null, '-'],
      [{ orderId: 'x'.repeat(200) }, 'x'.repeat(64)],
    ] as const) {
      const res = response();
      await controller(jest.fn().mockRejectedValue('thrown string')).momoIpn(
        body,
        res as unknown as Response,
      );
      expect(res.status).toHaveBeenCalledWith(500);
      expect(errors).toHaveBeenLastCalledWith(
        `MoMo IPN 500 for orderId ${logged}, nothing written`,
        'thrown string',
      );
    }
  });
});

describe('POST /payments/sepay/webhook', () => {
  const controller = (webhook: jest.Mock) =>
    new SepayPaymentsController(
      { webhook } as unknown as SepayPaymentService,
      {} as unknown as PaymentRateLimiter,
    );
  const request = (rawBody = Buffer.from('{}')) =>
    ({ rawBody, headers: { 'content-type': 'application/json' } }) as unknown as Request & {
      rawBody: Buffer;
    };

  it('200 {"success": true} once handled, with the raw body and headers passed on', async () => {
    const webhook = jest.fn().mockResolvedValue({ status: 200 });
    const res = response();
    const req = request(Buffer.from('{"id":1}'));
    await controller(webhook).webhook(req, { id: 1 }, res as unknown as Response);
    expect(webhook).toHaveBeenCalledWith({
      body: { id: 1 },
      rawBody: req.rawBody,
      headers: req.headers,
      contentType: 'application/json',
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  it('the status the service chose (401, 400, 503) with {"success": false}', async () => {
    for (const status of [401, 400, 503]) {
      const res = response();
      await controller(jest.fn().mockResolvedValue({ status, reason: 'why' })).webhook(
        request(),
        {},
        res as unknown as Response,
      );
      expect(res.status).toHaveBeenCalledWith(status);
      expect(res.json).toHaveBeenCalledWith({ success: false, message: 'why' });
    }
  });

  it('an unexpected error is a 500 SePay retries, logged with the transaction id', async () => {
    const res = response();
    await controller(jest.fn().mockRejectedValue(new Error('pool exhausted'))).webhook(
      request(),
      { id: 92704 },
      res as unknown as Response,
    );
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: 'Internal error' });
    expect(errors).toHaveBeenCalledWith(
      'SePay webhook 500 for transaction 92704, nothing written',
      expect.stringContaining('pool exhausted'),
    );
  });

  it('a 500 for a body without an id logs "-"', async () => {
    const res = response();
    await controller(jest.fn().mockRejectedValue(new Error('x'))).webhook(
      request(),
      'garbage',
      res as unknown as Response,
    );
    expect(res.status).toHaveBeenCalledWith(500);
    expect(errors).toHaveBeenCalledWith(
      'SePay webhook 500 for transaction -, nothing written',
      expect.any(String),
    );
  });
});
