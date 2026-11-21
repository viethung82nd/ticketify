import { requestHash } from './request-hash';

const SHOWTIME = '01a17e75-0000-7000-8000-00000000a001';
const SEAT = (n: number) => `01a17e75-7100-7679-b8b1-${String(n).padStart(12, '0')}`;
const COMBO = (n: number) => `01a17e75-c000-7000-8000-${String(n).padStart(12, '0')}`;

const base = {
  showtimeId: SHOWTIME,
  seatIds: [SEAT(1), SEAT(2), SEAT(3)],
  comboItems: [
    { comboId: COMBO(1), quantity: 2 },
    { comboId: COMBO(2), quantity: 1 },
  ],
};

describe('requestHash', () => {
  it('is a SHA-256 hex digest', () => {
    expect(requestHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('same content in another order → same hash (seats, combo lines, object keys, id case)', () => {
    const reordered = {
      comboItems: [
        { quantity: 1, comboId: COMBO(2) },
        { quantity: 2, comboId: COMBO(1).toUpperCase() },
      ],
      seatIds: [SEAT(3), SEAT(1).toUpperCase(), SEAT(2)],
      showtimeId: SHOWTIME.toUpperCase(),
    };

    expect(requestHash(reordered)).toBe(requestHash(base));
  });

  it('different seatIds → different hash', () => {
    expect(requestHash({ ...base, seatIds: [SEAT(1), SEAT(2), SEAT(4)] })).not.toBe(
      requestHash(base),
    );
    expect(requestHash({ ...base, seatIds: [SEAT(1), SEAT(2)] })).not.toBe(requestHash(base));
  });

  it('different showtime, combo or quantity → different hash', () => {
    const hashes = new Set([
      requestHash(base),
      requestHash({ ...base, showtimeId: '01a17e75-0000-7000-8000-00000000a002' }),
      requestHash({ ...base, comboItems: [{ comboId: COMBO(1), quantity: 2 }] }),
      requestHash({
        ...base,
        comboItems: [
          { comboId: COMBO(1), quantity: 3 },
          { comboId: COMBO(2), quantity: 1 },
        ],
      }),
      requestHash({ ...base, comboItems: [] }),
    ]);

    expect(hashes.size).toBe(5);
  });

  it('does not move items between fields (a seat id is not a combo id)', () => {
    const asSeat = requestHash({ showtimeId: SHOWTIME, seatIds: [SEAT(1)], comboItems: [] });
    const asCombo = requestHash({
      showtimeId: SHOWTIME,
      seatIds: [],
      comboItems: [{ comboId: SEAT(1), quantity: 1 }],
    });
    expect(asSeat).not.toBe(asCombo);
  });

  describe('voucherCode (ROADMAP 5.2)', () => {
    it('no voucher hashes as before vouchers existed: left out, undefined and null alike', () => {
      // Pinned: the hash of a voucher-less request must not change, or a retry sent across the
      // deploy would get 422 IDEMPOTENCY_KEY_REUSED for the booking it already made.
      // The literal is what the code before 5.2 gave for `base`.
      const pinned = '3bfa8900b2c4e7c1d6f712cf13450e5acd00cd20440574bd35c37fc1a70cc978';
      expect(requestHash(base)).toBe(pinned);
      expect(requestHash({ ...base, voucherCode: undefined })).toBe(pinned);
      expect(requestHash({ ...base, voucherCode: null })).toBe(pinned);
    });

    it('a voucher, another voucher and none are three different requests', () => {
      const hashes = new Set([
        requestHash(base),
        requestHash({ ...base, voucherCode: 'SUMMER10' }),
        requestHash({ ...base, voucherCode: 'WINTER20' }),
      ]);
      expect(hashes.size).toBe(3);
    });

    it('the letter case of the code does not matter', () => {
      expect(requestHash({ ...base, voucherCode: 'summer10' })).toBe(
        requestHash({ ...base, voucherCode: 'SUMMER10' }),
      );
    });
  });
});
