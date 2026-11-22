import { signatureDiagnostics } from '../payment.service';

/**
 * The `97` log line (11/2026): names only, so an operator can tell the usual causes of an invalid
 * VNPay signature apart without any value — and never the hash, not even its parameter name.
 */
describe('signatureDiagnostics', () => {
  const hash = 'ab'.repeat(64);

  it('a complete query: lists the parameter names, no value, no hash name', () => {
    const line = signatureDiagnostics({
      vnp_Amount: '18000000',
      vnp_TxnRef: 'Bq2qmIzmEDBQ2nWyKR55',
      vnp_SecureHashType: 'HmacSHA512',
      vnp_SecureHash: hash,
    });

    expect(line).toBe(
      'hash 128 chars; params vnp_Amount,vnp_TxnRef; non-vnp -; empty -; repeated -',
    );
    expect(line).not.toContain('SecureHash');
    expect(line).not.toContain('18000000');
    expect(line).not.toContain(hash);
  });

  it('names the usual causes: no hash, empty values, extra non-vnp parameters, repeated keys', () => {
    expect(
      signatureDiagnostics({
        vnp_Amount: '18000000',
        vnp_BankTranNo: '',
        utm_source: 'tunnel',
        vnp_TxnRef: ['a', 'b'],
      }),
    ).toBe(
      'hash absent; params utm_source,vnp_Amount,vnp_BankTranNo,vnp_TxnRef; non-vnp utm_source; ' +
        'empty vnp_BankTranNo; repeated vnp_TxnRef',
    );
  });

  it('a repeated hash and a short one are told apart', () => {
    expect(signatureDiagnostics({ vnp_SecureHash: [hash, hash] })).toMatch(/^hash repeated;/);
    expect(signatureDiagnostics({ vnp_SecureHash: 'abc' })).toMatch(/^hash 3 chars;/);
  });

  it('bounded: a forged query cannot flood the log', () => {
    const query = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`x${'y'.repeat(100)}${i}`, '1']),
    );
    const line = signatureDiagnostics(query);
    const names = /params ([^;]*)/.exec(line)?.[1]?.split(',') ?? [];

    expect(names).toHaveLength(40);
    expect(names.every((name) => name.length <= 40)).toBe(true);
  });
});
