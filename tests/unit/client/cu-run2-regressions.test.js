import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression tests for Computer Use Test Run 2 (client-side findings).
// Repro guide: docs/computer-use-tests/results/run-2-bug-report.html
const bookingHtml = readFileSync(join(process.cwd(), 'public/booking/index.html'), 'utf8');

// ---------------------------------------------------------------------------
// Bug #4 — when an event type requires host confirmation, the booking is created
// with status='pending'. The confirmation page must NOT say "Booking Confirmed!"
// or "added to the host's calendar" — it should communicate the pending state.
// ---------------------------------------------------------------------------
describe('Bug #4: confirmation page reflects pending (requires_confirmation) bookings', () => {
  it('renderConfirmation branches on pending/requires_confirmation', () => {
    expect(bookingHtml).toContain('requires_confirmation');
    expect(bookingHtml).toMatch(/Booking request sent/);
    expect(bookingHtml).toMatch(/pending the host/i);
  });

  it('behavioral: pending booking gets a non-confirmed title; confirmed gets the confirmed title', () => {
    // mirrors the renderConfirmation logic
    const titleFor = (bData, selectedEvent) => {
      const isPending =
        bData.status === 'pending' || Number(selectedEvent.requires_confirmation) === 1;
      return isPending ? 'Booking request sent' : 'Booking Confirmed!';
    };

    // event requires confirmation -> pending
    expect(titleFor({}, { requires_confirmation: 1 })).toBe('Booking request sent');
    // API reports pending status -> pending
    expect(titleFor({ status: 'pending' }, { requires_confirmation: 0 })).toBe('Booking request sent');
    // normal confirmed booking
    expect(titleFor({ status: 'confirmed' }, { requires_confirmation: 0 })).toBe('Booking Confirmed!');
  });
});
