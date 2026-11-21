import { PublicSeatStatus, SeatType, type ShowtimeSeat } from '@ticketify/shared';

/**
 * Seats for tests, from a picture of the room: one string per row, one character per column.
 * `.` standard, `V` VIP, `C` couple (two adjacent `C`s form a pair, left to right), ` ` no seat,
 * `h` held, `s` sold, `x` not sold for this showtime (no price). Ids are `seat-A1`, `seat-B5`…
 */
export function seatsFrom(rows: readonly string[]): ShowtimeSeat[] {
  const seats: ShowtimeSeat[] = [];
  let couple = 0;
  rows.forEach((line, r) => {
    const row = String.fromCharCode(65 + r);
    let pending = false;
    [...line].forEach((char, c) => {
      if (char === ' ') return;
      const number = c + 1;
      const type = char === 'V' ? SeatType.VIP : char === 'C' ? SeatType.COUPLE : SeatType.STANDARD;
      if (type === SeatType.COUPLE) {
        if (!pending) couple += 1;
        pending = !pending;
      }
      seats.push({
        id: `seat-${row}${number}`,
        row,
        number,
        label: `${row}${number}`,
        type,
        isActive: true,
        coupleGroup: type === SeatType.COUPLE ? couple : null,
        price: char === 'x' ? null : 90_000,
        status:
          char === 'h'
            ? PublicSeatStatus.HELD
            : char === 's'
              ? PublicSeatStatus.SOLD
              : PublicSeatStatus.AVAILABLE,
      });
    });
  });
  return seats;
}

/** The seat labelled `label` (`A1`); throws when the picture has none. */
export function seat(seats: readonly ShowtimeSeat[], label: string): ShowtimeSeat {
  const found = seats.find((item) => item.label === label);
  if (!found) throw new Error(`No seat ${label}`);
  return found;
}
