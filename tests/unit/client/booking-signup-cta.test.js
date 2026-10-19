import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The public booking-page footer is a growth surface: instead of a quiet
// "powered by" credit it now pitches Calendo as free-forever with a sign-up CTA.
// It must still be gated by hide_branding (a Pro perk), so it stays the
// .powered-by element that the existing gate hides.
const html = readFileSync(join(process.cwd(), 'public/booking/index.html'), 'utf8');

describe('Booking page free-forever sign-up CTA', () => {
  it('keeps the .powered-by element so the hide_branding gate still applies', () => {
    expect(html).toMatch(/class="powered-by"/);
    // The Pro gate must still hide that element.
    expect(html).toMatch(/\.powered-by[\s\S]{0,60}page\.hide_branding[\s\S]{0,80}display\s*=\s*['"]none['"]/);
  });
  it('states the free-forever value proposition', () => {
    const footer = html.match(/<div class="powered-by">[\s\S]*?<\/div>/);
    expect(footer).not.toBeNull();
    expect(footer[0]).toMatch(/free,?\s*forever/i);
  });
  it('has a sign-up CTA linking to registration that opens in a new tab', () => {
    const footer = html.match(/<div class="powered-by">[\s\S]*?<\/div>/);
    expect(footer[0]).toMatch(/href="\/auth\/register"/);
    expect(footer[0]).toMatch(/sign up free/i);
    // Opens in a new tab so the invitee doesn't lose their booking flow.
    expect(footer[0]).toMatch(/target="_blank"/);
    expect(footer[0]).toMatch(/rel="noopener"/);
  });
});
