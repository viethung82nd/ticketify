import { readVnpayIpn, signedParams, VnpayIpnResponse } from './vnpay-ipn';

describe('VnpayIpnResponse', () => {
  it('the RspCode/Message pairs of the VNPay IPN documentation', () => {
    expect(Object.values(VnpayIpnResponse)).toEqual([
      { RspCode: '00', Message: 'Confirm Success' },
      { RspCode: '02', Message: 'Order already confirmed' },
      { RspCode: '01', Message: 'Order not found' },
      { RspCode: '04', Message: 'Invalid amount' },
      { RspCode: '97', Message: 'Invalid signature' },
      { RspCode: '99', Message: 'Unknown error' },
    ]);
  });
});

describe('readVnpayIpn', () => {
  const ipn = (responseCode?: string, transactionStatus?: string) => ({
    vnp_BankCode: 'NCB',
    vnp_TransactionNo: '14226112',
    ...(responseCode === undefined ? {} : { vnp_ResponseCode: responseCode }),
    ...(transactionStatus === undefined ? {} : { vnp_TransactionStatus: transactionStatus }),
  });

  it('paid only when vnp_ResponseCode and vnp_TransactionStatus are both 00', () => {
    expect(readVnpayIpn(ipn('00', '00'))).toEqual({
      succeeded: true,
      responseCode: '00',
      transactionStatus: '00',
      bankCode: 'NCB',
      transactionNo: '14226112',
    });
  });

  it.each([
    ['24', '02', 'customer cancelled'],
    ['00', '02', 'response 00 but transaction failed'],
    ['00', '01', 'response 00 but transaction not complete'],
    ['07', '00', 'money taken, transaction suspected (07)'],
    ['00', undefined, 'no vnp_TransactionStatus'],
    [undefined, '00', 'no vnp_ResponseCode'],
  ])('%s / %s (%s) → not paid', (responseCode, transactionStatus, _label) => {
    const result = readVnpayIpn(ipn(responseCode, transactionStatus));
    expect(result.succeeded).toBe(false);
    expect(result.responseCode).toBe(responseCode ?? null);
    expect(result.transactionStatus).toBe(transactionStatus ?? null);
  });

  it('empty bank code and transaction number are stored as null', () => {
    const result = readVnpayIpn({
      vnp_ResponseCode: '24',
      vnp_BankCode: '',
      vnp_TransactionNo: '',
    });
    expect(result).toMatchObject({ bankCode: null, transactionNo: null });
  });
});

describe('signedParams', () => {
  it('keeps the string values of the query', () => {
    expect(signedParams({ vnp_TxnRef: 'ABC', vnp_Amount: '100', other: ['x'] })).toEqual({
      vnp_TxnRef: 'ABC',
      vnp_Amount: '100',
    });
  });
});
