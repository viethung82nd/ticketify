import { readTicketToken, signTicketCode, ticketToken } from './ticket-token';

const SECRET = 'ticket-qr-secret-for-tests-0123456789';
const OTHER_SECRET = 'another-ticket-qr-secret-0123456789ab';
const CODE = 'K7PX3MQ9TAZB';

describe('ticketToken', () => {
  it('is the code, a dot and a 27-character signature', () => {
    const token = ticketToken(CODE, SECRET);

    expect(token.startsWith(`${CODE}.`)).toBe(true);
    expect(token.split('.')[1]).toHaveLength(27);
    expect(token).toMatch(/^[A-Z0-9]+\.[A-Za-z0-9_-]{27}$/);
  });

  it('is stable for one code and secret, and different for another code', () => {
    expect(ticketToken(CODE, SECRET)).toBe(ticketToken(CODE, SECRET));
    expect(ticketToken('OTHERCODE123', SECRET)).not.toBe(ticketToken(CODE, SECRET));
  });

  it('depends on the secret, so a token of another environment does not pass', () => {
    const token = ticketToken(CODE, OTHER_SECRET);

    expect(readTicketToken(token, SECRET)).toBeNull();
  });
});

describe('readTicketToken', () => {
  it('returns the code of a token it signed', () => {
    expect(readTicketToken(ticketToken(CODE, SECRET), SECRET)).toBe(CODE);
  });

  it.each([
    ['empty', ''],
    ['no separator', CODE],
    ['no signature', `${CODE}.`],
    ['no code', `.${signTicketCode(CODE, SECRET)}`],
    ['a signature of the wrong length', `${CODE}.aGVsbG8`],
    ['a changed code', `${CODE}X.${signTicketCode(CODE, SECRET)}`],
    ['a changed signature', `${CODE}.${signTicketCode(`${CODE}X`, SECRET)}`],
    ['not base64url at all', `${CODE}.${'!'.repeat(27)}`],
  ])('returns null for %s', (_label, token) => {
    expect(readTicketToken(token, SECRET)).toBeNull();
  });
});
