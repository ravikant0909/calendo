import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const booking = readFileSync(join(process.cwd(), 'public/booking/index.html'), 'utf8');
const dash = readFileSync(join(process.cwd(), 'public/dashboard/index.html'), 'utf8');

// The booking page must read the target from the pretty path, falling back to
// the legacy query form.
describe('Short links: booking page resolves target from path or query', () => {
  it('booking page defines getBookingTarget and uses it for user/event', () => {
    expect(booking).toContain('function getBookingTarget');
    expect(booking).toContain('getBookingTarget().user');
    expect(booking).toContain('getBookingTarget().event');
  });

  it('behavioral: pretty path and legacy query both resolve correctly', () => {
    // mirrors getBookingTarget in public/booking/index.html
    const resolve = (search, pathname) => {
      const qp = new URLSearchParams(search);
      let user = qp.get('user');
      let event = qp.get('event');
      if (!user) {
        const segs = pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
        if (segs.length && segs[0] !== 'booking') {
          user = decodeURIComponent(segs[0]);
          if (segs.length > 1) event = decodeURIComponent(segs[1]);
        }
      }
      return { user, event };
    };
    expect(resolve('', '/ravi/30-min')).toEqual({ user: 'ravi', event: '30-min' });
    expect(resolve('', '/ravi')).toEqual({ user: 'ravi', event: null });
    expect(resolve('?user=x&event=y', '/booking/')).toEqual({ user: 'x', event: 'y' }); // legacy form
    expect(resolve('?user=x', '/ravi/30-min')).toEqual({ user: 'x', event: null }); // query wins
    expect(resolve('', '/booking/')).toEqual({ user: null, event: null }); // canonical path, no target
  });
});

// The dashboard must surface the pretty link as the default everywhere.
describe('Short links: dashboard uses pretty links by default', () => {
  it('no dashboard link still uses the ugly /booking/?user= form', () => {
    expect(dash).not.toContain('/booking/?user=');
  });
  it('host link is /<slug> and event link is /<slug>/<event>', () => {
    expect(dash).toContain('`${window.location.origin}/${bookingPage.slug}`');
    expect(dash).toContain('`${window.location.origin}/${bookingPage.slug}/${et.slug}`');
  });
});
