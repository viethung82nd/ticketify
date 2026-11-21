import type { ShowtimeSeat } from '@ticketify/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { seatsFrom } from '@/test/seat-fixtures';
import { SeatMap } from './seat-map';

// Row A: A1 A2 _ A4 (gap at 3); row B: B1 held, B2 sold, B3–B4 couple; row C: C1 only.
const SEATS = seatsFrom(['.. .', 'hsCC', '.']);

function renderMap(selected: string[] = [], seats: ShowtimeSeat[] = SEATS) {
  const onToggle = vi.fn();
  render(
    <SeatMap
      rows={3}
      cols={4}
      seats={seats}
      selected={selected}
      onToggle={onToggle}
      label="Sơ đồ ghế Phòng 1"
    />,
  );
  return { onToggle, user: userEvent.setup() };
}

const seatButton = (name: RegExp) => screen.getByRole('button', { name });

describe('SeatMap', () => {
  it('a labelled grid: one row per room row with its header, one button per seat', () => {
    renderMap();
    const grid = screen.getByRole('grid', { name: 'Sơ đồ ghế Phòng 1' });

    expect(within(grid).getAllByRole('row')).toHaveLength(3);
    expect(
      within(grid)
        .getAllByRole('rowheader')
        .map((cell) => cell.textContent),
    ).toEqual(['A', 'B', 'C']);
    expect(within(grid).getAllByRole('button')).toHaveLength(SEATS.length);
  });

  it('each seat reads its row, number, type, status and whether it is chosen', () => {
    renderMap(['seat-A2']);

    expect(seatButton(/^Hàng A, ghế 1,/)).toHaveAccessibleName(
      'Hàng A, ghế 1, Thường, còn trống, chưa chọn',
    );
    expect(seatButton(/^Hàng A, ghế 2,/)).toHaveAttribute('aria-pressed', 'true');
    expect(seatButton(/^Hàng B, ghế 3,/)).toHaveAccessibleName(
      'Hàng B, ghế 3, Đôi, ghép với B4, còn trống, chưa chọn',
    );
  });

  it('held and sold seats stay focusable but say they cannot be picked', () => {
    renderMap();

    expect(seatButton(/^Hàng B, ghế 1,/)).toHaveAttribute('aria-disabled', 'true');
    expect(seatButton(/^Hàng B, ghế 2,/)).toHaveAttribute('aria-disabled', 'true');
    expect(seatButton(/^Hàng A, ghế 1,/)).not.toHaveAttribute('aria-disabled');
  });

  it('a click hands the seat to onToggle (the page decides; the map does not select)', async () => {
    const { onToggle, user } = renderMap();

    await user.click(seatButton(/^Hàng A, ghế 4,/));

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle.mock.calls[0]?.[0]).toMatchObject({ label: 'A4' });
  });

  it('the grid is one Tab stop: the first seat, then out of the grid', async () => {
    const { user } = renderMap();
    const buttons = screen.getAllByRole('button');

    expect(buttons.filter((button) => button.tabIndex === 0)).toHaveLength(1);
    await user.tab();
    expect(seatButton(/^Hàng A, ghế 1,/)).toHaveFocus();
    await user.tab();
    expect(document.body).toHaveFocus();
  });

  it('arrow keys move between seats, skip gaps, stop at the edges; Home and End', async () => {
    const { user } = renderMap();
    await user.tab();

    await user.keyboard('{ArrowRight}');
    expect(seatButton(/^Hàng A, ghế 2,/)).toHaveFocus();
    // A3 is a gap: the next seat to the right is A4.
    await user.keyboard('{ArrowRight}');
    expect(seatButton(/^Hàng A, ghế 4,/)).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(seatButton(/^Hàng A, ghế 4,/)).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(seatButton(/^Hàng B, ghế 4,/)).toHaveFocus();
    await user.keyboard('{Home}');
    expect(seatButton(/^Hàng B, ghế 1,/)).toHaveFocus();
    await user.keyboard('{End}');
    expect(seatButton(/^Hàng B, ghế 4,/)).toHaveFocus();
    // Column 4 has no seat in row C: down stays on B4.
    await user.keyboard('{ArrowDown}');
    expect(seatButton(/^Hàng B, ghế 4,/)).toHaveFocus();
    // The focused seat is now the grid's only Tab stop.
    expect(seatButton(/^Hàng B, ghế 4,/)).toHaveAttribute('tabindex', '0');
    expect(seatButton(/^Hàng A, ghế 1,/)).toHaveAttribute('tabindex', '-1');
  });

  it('Enter and Space toggle the focused seat', async () => {
    const { onToggle, user } = renderMap();
    await user.tab();

    await user.keyboard('{Enter}');
    await user.keyboard('{ArrowRight}');
    await user.keyboard(' ');

    expect(onToggle.mock.calls.map((call) => (call[0] as ShowtimeSeat).label)).toEqual([
      'A1',
      'A2',
    ]);
  });

  it('the screen strip is decoration, hidden from screen readers', () => {
    renderMap();

    expect(screen.getByText('Màn hình')).toHaveAttribute('aria-hidden', 'true');
  });
});
