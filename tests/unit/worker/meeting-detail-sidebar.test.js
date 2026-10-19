import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const html = readFileSync(
  new URL('../../../public/dashboard/index.html', import.meta.url),
  'utf-8'
);

describe('Meeting Detail Sidebar', () => {
  describe('HTML structure', () => {
    it('should have sidebar container with correct ID', () => {
      expect(html).toContain('id="meetingDetailSidebar"');
      expect(html).toContain('class="meeting-detail-sidebar"');
    });

    it('should have overlay for dismissing sidebar', () => {
      expect(html).toContain('id="mdsOverlay"');
      expect(html).toContain('onclick="closeMeetingDetail()"');
    });

    it('should have header sections for status, title, datetime, actions', () => {
      expect(html).toContain('id="mdsStatus"');
      expect(html).toContain('id="mdsTitle"');
      expect(html).toContain('id="mdsDatetime"');
      expect(html).toContain('id="mdsActions"');
    });

    it('should have body container for detail sections', () => {
      expect(html).toContain('id="mdsBody"');
    });

    it('should have close button', () => {
      expect(html).toContain('class="mds-close"');
    });
  });

  describe('CSS', () => {
    it('should have sidebar positioned off-screen by default', () => {
      expect(html).toContain('.meeting-detail-sidebar');
      expect(html).toContain('right: -420px');
    });

    it('should slide in when open class is added', () => {
      expect(html).toContain('.meeting-detail-sidebar.open');
      expect(html).toContain('right: 0');
    });

    it('should have overlay hidden by default', () => {
      expect(html).toContain('.mds-overlay');
      expect(html).toContain('display: none');
    });
  });

  describe('JavaScript functions', () => {
    it('should define openMeetingDetail function', () => {
      expect(html).toContain('function openMeetingDetail(idx)');
    });

    it('should define closeMeetingDetail function', () => {
      expect(html).toContain('function closeMeetingDetail()');
    });

    it('should define saveSidebarNotes function', () => {
      expect(html).toContain('function saveSidebarNotes(id)');
    });

    it('should store filtered meetings for sidebar access', () => {
      expect(html).toContain('window._meetingsFiltered = filtered');
    });
  });

  describe('Meeting cards (uniform)', () => {
    it('should have fixed height meeting rows', () => {
      expect(html).toContain('height: 52px');
    });

    it('should have click handler on meeting rows', () => {
      expect(html).toContain('onclick="openMeetingDetail(');
    });

    it('should have selected state for active card', () => {
      expect(html).toContain('.meeting-row.selected');
    });

    it('should not have inline meeting-actions in cards', () => {
      // The old inline actions div is gone from renderBookings
      // Actions are now only in the sidebar
      const renderFn = html.substring(
        html.indexOf('function renderBookings()'),
        html.indexOf('function openMeetingDetail(')
      );
      expect(renderFn).not.toContain('class="meeting-actions"');
      expect(renderFn).not.toContain('Join meeting');
      expect(renderFn).not.toContain('cancelBooking(');
    });
  });

  describe('Sidebar content sections', () => {
    it('should show invitee section with avatar', () => {
      expect(html).toContain('mds-invitee-avatar');
    });

    it('should show location section', () => {
      expect(html).toContain('mds-section-title">Location');
    });

    it('should show notes textarea', () => {
      expect(html).toContain('mds-notes-textarea');
      expect(html).toContain('mdsNotesTextarea');
    });

    it('should show timeline section', () => {
      expect(html).toContain('mds-timeline-item');
      expect(html).toContain('Event booked by');
    });

    it('should show booking questions section', () => {
      expect(html).toContain('Booking Questions');
      expect(html).toContain('mds-answer-q');
    });

    it('should show reconfirmation status when applicable', () => {
      expect(html).toContain('Reconfirmation:');
      expect(html).toContain('reconfirmation_sent_at');
    });

    it('should show event type reference', () => {
      expect(html).toContain('Based on the');
      expect(html).toContain('event type');
    });
  });

  describe('Today divider', () => {
    it('should have today divider elements', () => {
      expect(html).toContain('today-divider');
      expect(html).toContain('today-divider-dot');
      expect(html).toContain('today-divider-line');
    });
  });
});
