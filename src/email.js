// Calendo - Email Notification System
// ICS generation, email templates, and sending via Resend

// ============================================================
// ICS Calendar File Generation
// ============================================================

export function generateICS(booking, eventType, hostName, hostEmail) {
  const uid = booking.uid || booking.id;
  const startDt = formatICSDate(booking.start_time);
  const endDt = formatICSDate(booking.end_time);
  const now = formatICSDate(new Date().toISOString());
  const summary = escapeICS(`${eventType.name} with ${hostName}`);
  const description = escapeICS(
    eventType.description
      ? `${eventType.name} - ${eventType.description}`
      : eventType.name
  );

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Calendo//Calendo//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}@calendo.dev`,
    `DTSTAMP:${now}`,
    `DTSTART:${startDt}`,
    `DTEND:${endDt}`,
    `SUMMARY:${summary}`,
    `DESCRIPTION:${description}`,
    `ORGANIZER;CN=${escapeICS(hostName)}:mailto:${hostEmail}`,
    `ATTENDEE;CN=${escapeICS(booking.invitee_name)};RSVP=TRUE:mailto:${booking.invitee_email}`,
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

function formatICSDate(dateStr) {
  // Convert "2026-03-15 14:00:00" or "2026-03-15T14:00:00Z" to "20260315T140000Z"
  const d = parseStoredUtcDate(dateStr);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function escapeICS(str) {
  if (!str) return '';
  return str.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

// ============================================================
// Email Templates
// ============================================================

function formatDateTime(dateStr, timezone) {
  const tz = timezone || 'UTC';
  const d = parseStoredUtcDate(dateStr);
  return d.toLocaleString('en-US', {
    timeZone: tz,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    // Always label the timezone so the reader knows which zone the time is in
    // (e.g. "... at 10:30 PM GMT+5:30"). Without this, the time was ambiguous.
    timeZoneName: 'short',
  });
}

function formatDate(dateStr, timezone) {
  const tz = timezone || 'UTC';
  const d = parseStoredUtcDate(dateStr);
  return d.toLocaleDateString('en-US', {
    timeZone: tz,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function parseStoredUtcDate(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (!value) return new Date(NaN);

  let normalized = String(value).trim();
  if (normalized.includes(' ') && !normalized.includes('T')) {
    normalized = normalized.replace(' ', 'T');
  }
  if (!/(Z|[+-]\d{2}:\d{2})$/i.test(normalized)) {
    normalized += 'Z';
  }

  return new Date(normalized);
}

function emailLayout(content) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Calendo</title>
</head>
<body style="margin:0;padding:0;background-color:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f5f5;padding:32px 16px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:8px;overflow:hidden;">
<tr><td style="background-color:#2563eb;padding:20px 32px;">
<table cellpadding="0" cellspacing="0" border="0"><tr>
<td style="vertical-align:middle;padding-right:12px;"><img src="https://calendo.dev/calendo-logo-256.png" alt="" width="32" height="32" style="display:block;border-radius:6px;background:#ffffff;" /></td>
<td style="vertical-align:middle;"><span style="color:#ffffff;font-size:20px;font-weight:700;text-decoration:none;">Calendo</span></td>
</tr></table>
</td></tr>
<tr><td style="padding:32px;">
${content}
</td></tr>
<tr><td style="padding:16px 32px 24px;border-top:1px solid #e5e7eb;">
<p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">Powered by Calendo &mdash; free scheduling for everyone</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

export function bookingConfirmationEmail(booking, eventType, host, appOrigin) {
  const origin = appOrigin || 'https://calendo.dev';
  const dateTime = formatDateTime(booking.start_time, booking.invitee_timezone);
  const cancelUrl = `${origin}/cancel/${booking.uid}?token=${booking.cancel_token}`;
  const rescheduleUrl = `${origin}/reschedule/${booking.uid}?token=${booking.cancel_token}`;

  // Parse guest emails
  let guestList = [];
  if (booking.guest_emails) {
    try {
      guestList = typeof booking.guest_emails === 'string' ? JSON.parse(booking.guest_emails) : booking.guest_emails;
      if (!Array.isArray(guestList)) guestList = [];
    } catch { guestList = []; }
  }

  const guestsHtml = guestList.length > 0
    ? `<p style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Additional Guests</p>
<p style="margin:0 0 16px;font-size:16px;color:#111827;">${guestList.map(g => escapeHtml(g)).join(', ')}</p>`
    : '';

  const guestsText = guestList.length > 0 ? `Additional Guests: ${guestList.join(', ')}\n` : '';

  const subject = `Confirmed: ${eventType.name} with ${host.name}`;

  const html = emailLayout(`
<h2 style="margin:0 0 8px;font-size:20px;color:#111827;">Your meeting is confirmed</h2>
<p style="margin:0 0 24px;font-size:14px;color:#6b7280;">Here are the details for your upcoming meeting.</p>
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb;border-radius:8px;padding:20px;margin-bottom:24px;">
<tr><td>
<p style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Event</p>
<p style="margin:0 0 16px;font-size:16px;color:#111827;font-weight:600;">${escapeHtml(eventType.name)}</p>
<p style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">When</p>
<p style="margin:0 0 16px;font-size:16px;color:#111827;">${escapeHtml(dateTime)}</p>
<p style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Duration</p>
<p style="margin:0 0 16px;font-size:16px;color:#111827;">${eventType.duration_minutes} minutes</p>
<p style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Host</p>
<p style="margin:0 0 16px;font-size:16px;color:#111827;">${escapeHtml(host.name)}</p>
${guestsHtml}
</td></tr>
</table>
<table width="100%" cellpadding="0" cellspacing="0">
<tr>
<td style="padding-right:8px;" width="50%">
<a href="${escapeHtml(rescheduleUrl)}" style="display:block;text-align:center;padding:12px 16px;background-color:#2563eb;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">Reschedule</a>
</td>
<td style="padding-left:8px;" width="50%">
<a href="${escapeHtml(cancelUrl)}" style="display:block;text-align:center;padding:12px 16px;background-color:#ffffff;color:#dc2626;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;border:1px solid #dc2626;">Cancel</a>
</td>
</tr>
</table>`);

  const text = `Your meeting is confirmed

Event: ${eventType.name}
When: ${dateTime}
Duration: ${eventType.duration_minutes} minutes
Host: ${host.name}
${guestsText}
Reschedule: ${rescheduleUrl}
Cancel: ${cancelUrl}

Powered by Calendo`;

  return { subject, html, text };
}

export function hostNotificationEmail(booking, eventType, host) {
  const dateTime = formatDateTime(booking.start_time, host.timezone);

  // Parse guest emails
  let guestList = [];
  if (booking.guest_emails) {
    try {
      guestList = typeof booking.guest_emails === 'string' ? JSON.parse(booking.guest_emails) : booking.guest_emails;
      if (!Array.isArray(guestList)) guestList = [];
    } catch { guestList = []; }
  }

  const guestsHtml = guestList.length > 0
    ? `<p style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Additional Guests</p>
<p style="margin:0 0 16px;font-size:16px;color:#111827;">${guestList.map(g => escapeHtml(g)).join(', ')}</p>`
    : '';

  const guestsText = guestList.length > 0 ? `Additional Guests: ${guestList.join(', ')}\n` : '';

  const subject = `New booking: ${booking.invitee_name} - ${eventType.name}`;

  const html = emailLayout(`
<h2 style="margin:0 0 8px;font-size:20px;color:#111827;">New booking received</h2>
<p style="margin:0 0 24px;font-size:14px;color:#6b7280;">Someone has booked a meeting with you.</p>
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb;border-radius:8px;padding:20px;margin-bottom:24px;">
<tr><td>
<p style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Event</p>
<p style="margin:0 0 16px;font-size:16px;color:#111827;font-weight:600;">${escapeHtml(eventType.name)}</p>
<p style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Invitee</p>
<p style="margin:0 0 16px;font-size:16px;color:#111827;">${escapeHtml(booking.invitee_name)} (${escapeHtml(booking.invitee_email)})</p>
<p style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">When</p>
<p style="margin:0 0 16px;font-size:16px;color:#111827;">${escapeHtml(dateTime)}</p>
<p style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Duration</p>
<p style="margin:0 0 16px;font-size:16px;color:#111827;">${eventType.duration_minutes} minutes</p>
${guestsHtml}
</td></tr>
</table>`);

  const text = `New booking received

Event: ${eventType.name}
Invitee: ${booking.invitee_name} (${booking.invitee_email})
When: ${dateTime}
Duration: ${eventType.duration_minutes} minutes
${guestsText}
Powered by Calendo`;

  return { subject, html, text };
}

export function guestNotificationEmail(booking, eventType, host) {
  const dateTime = formatDateTime(booking.start_time, booking.invitee_timezone);

  const subject = `You're invited: ${eventType.name} with ${host.name}`;

  const html = emailLayout(`
<h2 style="margin:0 0 8px;font-size:20px;color:#111827;">You've been added to a meeting</h2>
<p style="margin:0 0 24px;font-size:14px;color:#6b7280;">${escapeHtml(booking.invitee_name)} has added you as a guest to their meeting.</p>
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb;border-radius:8px;padding:20px;margin-bottom:24px;">
<tr><td>
<p style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Event</p>
<p style="margin:0 0 16px;font-size:16px;color:#111827;font-weight:600;">${escapeHtml(eventType.name)}</p>
<p style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">When</p>
<p style="margin:0 0 16px;font-size:16px;color:#111827;">${escapeHtml(dateTime)}</p>
<p style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Duration</p>
<p style="margin:0 0 16px;font-size:16px;color:#111827;">${eventType.duration_minutes} minutes</p>
<p style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Host</p>
<p style="margin:0 0 16px;font-size:16px;color:#111827;">${escapeHtml(host.name)}</p>
<p style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Booked by</p>
<p style="margin:0;font-size:16px;color:#111827;">${escapeHtml(booking.invitee_name)} (${escapeHtml(booking.invitee_email)})</p>
</td></tr>
</table>`);

  const text = `You've been added to a meeting

Event: ${eventType.name}
When: ${dateTime}
Duration: ${eventType.duration_minutes} minutes
Host: ${host.name}
Booked by: ${booking.invitee_name} (${booking.invitee_email})

Powered by Calendo`;

  return { subject, html, text };
}

export function cancellationEmail(booking, eventType, cancelledBy, recipientName, displayTimezone) {
  const tz = displayTimezone || booking.invitee_timezone;
  const dateTime = formatDateTime(booking.start_time, tz);
  const dateOnly = formatDate(booking.start_time, tz);
  const cancelledByLabel = cancelledBy === 'host' ? 'the host' : 'the invitee';
  const reason = booking.cancellation_reason;

  const subject = `Cancelled: ${eventType.name} on ${dateOnly}`;

  const reasonHtml = reason
    ? `<p style="margin:16px 0 0;font-size:14px;color:#6b7280;"><strong>Reason:</strong> ${escapeHtml(reason)}</p>`
    : '';

  const html = emailLayout(`
<h2 style="margin:0 0 8px;font-size:20px;color:#111827;">Meeting cancelled</h2>
<p style="margin:0 0 24px;font-size:14px;color:#6b7280;">This meeting has been cancelled by ${escapeHtml(cancelledByLabel)}.</p>
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb;border-radius:8px;padding:20px;margin-bottom:24px;">
<tr><td>
<p style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Event</p>
<p style="margin:0 0 16px;font-size:16px;color:#111827;font-weight:600;text-decoration:line-through;">${escapeHtml(eventType.name)}</p>
<p style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Was scheduled for</p>
<p style="margin:0;font-size:16px;color:#111827;">${escapeHtml(dateTime)}</p>
${reasonHtml}
</td></tr>
</table>
<p style="margin:0;font-size:14px;color:#6b7280;">Hi ${escapeHtml(recipientName)}, this meeting has been removed from your schedule.</p>`);

  const text = `Meeting cancelled

Event: ${eventType.name}
Was scheduled for: ${dateTime}
Cancelled by: ${cancelledByLabel}${reason ? '\nReason: ' + reason : ''}

Hi ${recipientName}, this meeting has been removed from your schedule.

Powered by Calendo`;

  return { subject, html, text };
}

export function rescheduleEmail(newBooking, oldBooking, eventType, recipientName, appOrigin, displayTimezone) {
  const origin = appOrigin || 'https://calendo.dev';
  const oldDateTime = formatDateTime(oldBooking.start_time, displayTimezone || oldBooking.invitee_timezone || newBooking.invitee_timezone);
  const newDateTime = formatDateTime(newBooking.start_time, displayTimezone || newBooking.invitee_timezone);
  const cancelUrl = `${origin}/booking/cancel.html?token=${newBooking.cancel_token}`;
  const rescheduleUrl = `${origin}/booking/reschedule.html?token=${newBooking.cancel_token}`;

  const subject = `Rescheduled: ${eventType.name} — new time`;

  const html = emailLayout(`
<h2 style="margin:0 0 8px;font-size:20px;color:#111827;">Meeting rescheduled</h2>
<p style="margin:0 0 24px;font-size:14px;color:#6b7280;">Hi ${escapeHtml(recipientName)}, this meeting has been moved to a new time.</p>
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb;border-radius:8px;padding:20px;margin-bottom:24px;">
<tr><td>
<p style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Event</p>
<p style="margin:0 0 16px;font-size:16px;color:#111827;font-weight:600;">${escapeHtml(eventType.name)}</p>
<p style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Previous Time</p>
<p style="margin:0 0 16px;font-size:16px;color:#111827;text-decoration:line-through;">${escapeHtml(oldDateTime)}</p>
<p style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">New Time</p>
<p style="margin:0 0 16px;font-size:16px;color:#111827;font-weight:600;">${escapeHtml(newDateTime)}</p>
<p style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Invitee</p>
<p style="margin:0;font-size:16px;color:#111827;">${escapeHtml(newBooking.invitee_name)} (${escapeHtml(newBooking.invitee_email)})</p>
</td></tr>
</table>
<table width="100%" cellpadding="0" cellspacing="0">
<tr>
<td style="padding-right:8px;" width="50%">
<a href="${escapeHtml(rescheduleUrl)}" style="display:block;text-align:center;padding:12px 16px;background-color:#2563eb;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">Reschedule</a>
</td>
<td style="padding-left:8px;" width="50%">
<a href="${escapeHtml(cancelUrl)}" style="display:block;text-align:center;padding:12px 16px;background-color:#ffffff;color:#dc2626;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;border:1px solid #dc2626;">Cancel</a>
</td>
</tr>
</table>`);

  const text = `Meeting rescheduled

Event: ${eventType.name}
Previous time: ${oldDateTime}
New time: ${newDateTime}
Invitee: ${newBooking.invitee_name} (${newBooking.invitee_email})

Reschedule: ${rescheduleUrl}
Cancel: ${cancelUrl}

Powered by Calendo`;

  return { subject, html, text };
}

export function reminderEmail(booking, eventType, hoursUntil, recipientName, displayTimezone) {
  const dateTime = formatDateTime(booking.start_time, displayTimezone || booking.invitee_timezone);

  const subject = `Reminder: ${eventType.name} in ${hoursUntil} hours`;

  const html = emailLayout(`
<h2 style="margin:0 0 8px;font-size:20px;color:#111827;">Meeting reminder</h2>
<p style="margin:0 0 24px;font-size:14px;color:#6b7280;">Hi ${escapeHtml(recipientName)}, your meeting is coming up in ${hoursUntil} hours.</p>
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb;border-radius:8px;padding:20px;margin-bottom:24px;">
<tr><td>
<p style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Event</p>
<p style="margin:0 0 16px;font-size:16px;color:#111827;font-weight:600;">${escapeHtml(eventType.name)}</p>
<p style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">When</p>
<p style="margin:0;font-size:16px;color:#111827;">${escapeHtml(dateTime)}</p>
</td></tr>
</table>`);

  const text = `Meeting reminder

Hi ${recipientName}, your meeting is coming up in ${hoursUntil} hours.

Event: ${eventType.name}
When: ${dateTime}

Powered by Calendo`;

  return { subject, html, text };
}

export function verificationEmail(verifyUrl) {
  const subject = 'Verify your Calendo email address';

  const html = emailLayout(`
<h2 style="margin:0 0 8px;font-size:20px;color:#111827;">Verify your email</h2>
<p style="margin:0 0 24px;font-size:14px;color:#6b7280;">Welcome to Calendo! Please verify your email address to get the most out of your account.</p>
<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
<tr><td align="center">
<a href="${escapeHtml(verifyUrl)}" style="display:inline-block;padding:14px 32px;background-color:#2563eb;color:#ffffff;text-decoration:none;border-radius:6px;font-size:15px;font-weight:600;">Verify Email</a>
</td></tr>
</table>
<p style="margin:0 0 8px;font-size:13px;color:#6b7280;">Or copy and paste this link into your browser:</p>
<p style="margin:0 0 24px;font-size:13px;color:#2563eb;word-break:break-all;">${escapeHtml(verifyUrl)}</p>
<p style="margin:0;font-size:13px;color:#9ca3af;">This link expires in 24 hours. If you did not create a Calendo account, you can safely ignore this email.</p>`);

  const text = `Verify your email

Welcome to Calendo! Please verify your email address by visiting the link below:

${verifyUrl}

This link expires in 24 hours. If you did not create a Calendo account, you can safely ignore this email.

Powered by Calendo`;

  return { subject, html, text };
}

export function reconfirmationEmail(booking, eventType, host, confirmUrl, cancelUrl) {
  const dateTime = formatDateTime(booking.start_time, booking.invitee_timezone);

  const subject = `Please confirm: ${eventType.name} with ${host.name}`;

  const html = emailLayout(`
<h2 style="margin:0 0 8px;font-size:20px;color:#111827;">Please confirm your attendance</h2>
<p style="margin:0 0 24px;font-size:14px;color:#6b7280;">Hi ${escapeHtml(booking.invitee_name)}, your meeting is coming up. Please confirm that you'll be attending.</p>
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb;border-radius:8px;padding:20px;margin-bottom:24px;">
<tr><td>
<p style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Event</p>
<p style="margin:0 0 16px;font-size:16px;color:#111827;font-weight:600;">${escapeHtml(eventType.name)}</p>
<p style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">When</p>
<p style="margin:0 0 16px;font-size:16px;color:#111827;">${escapeHtml(dateTime)}</p>
<p style="margin:0 0 12px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Host</p>
<p style="margin:0;font-size:16px;color:#111827;">${escapeHtml(host.name)}</p>
</td></tr>
</table>
<table width="100%" cellpadding="0" cellspacing="0">
<tr>
<td style="padding-right:8px;" width="50%">
<a href="${escapeHtml(confirmUrl)}" style="display:block;text-align:center;padding:12px 16px;background-color:#16a34a;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">Confirm Attendance</a>
</td>
<td style="padding-left:8px;" width="50%">
<a href="${escapeHtml(cancelUrl)}" style="display:block;text-align:center;padding:12px 16px;background-color:#ffffff;color:#dc2626;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;border:1px solid #dc2626;">Cancel Meeting</a>
</td>
</tr>
</table>`);

  const text = `Please confirm your attendance

Hi ${booking.invitee_name}, your meeting is coming up. Please confirm that you'll be attending.

Event: ${eventType.name}
When: ${dateTime}
Host: ${host.name}

Confirm: ${confirmUrl}
Cancel: ${cancelUrl}

Powered by Calendo`;

  return { subject, html, text };
}

export function passwordResetEmail(resetUrl) {
  const subject = 'Reset your Calendo password';

  const html = emailLayout(`
<h2 style="margin:0 0 8px;font-size:20px;color:#111827;">Reset your password</h2>
<p style="margin:0 0 24px;font-size:14px;color:#6b7280;">We received a request to reset your password. Click the button below to choose a new one.</p>
<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
<tr><td align="center">
<a href="${escapeHtml(resetUrl)}" style="display:inline-block;padding:14px 32px;background-color:#2563eb;color:#ffffff;text-decoration:none;border-radius:6px;font-size:15px;font-weight:600;">Reset Password</a>
</td></tr>
</table>
<p style="margin:0 0 8px;font-size:13px;color:#6b7280;">Or copy and paste this link into your browser:</p>
<p style="margin:0 0 24px;font-size:13px;color:#2563eb;word-break:break-all;">${escapeHtml(resetUrl)}</p>
<p style="margin:0;font-size:13px;color:#9ca3af;">This link expires in 1 hour. If you did not request a password reset, you can safely ignore this email.</p>`);

  const text = `Reset your password

We received a request to reset your password. Use the link below to choose a new one:

${resetUrl}

This link expires in 1 hour. If you did not request a password reset, you can safely ignore this email.

Powered by Calendo`;

  return { subject, html, text };
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================
// Email Sending via Resend
// NOTE: The sending domain calendo.dev must be verified in the
// Resend dashboard (https://resend.com/domains) before emails
// will be delivered.
// ============================================================

export async function sendEmail(env, { to, subject, html, text, bookingId, type }) {
  const payload = {
    from: 'Calendo <notifications@calendo.dev>',
    to: [to],
    subject,
    html,
    text,
  };

  let status = 'sent';
  let error = null;

  if (env.DISABLE_OUTBOUND_NOTIFICATIONS === '1' || env.DISABLE_OUTBOUND_NOTIFICATIONS === 1 || env.DISABLE_OUTBOUND_NOTIFICATIONS === true) {
    status = 'skipped';
  } else {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const body = await response.text();
        status = 'failed';
        error = `Resend ${response.status}: ${body}`;
        console.error('Email send failed:', error);
      }
    } catch (err) {
      status = 'failed';
      error = err.message;
      console.error('Email send error:', err);
    }
  }

  // Log in notification_log
  try {
    await env.DB.prepare(
      `INSERT INTO notification_log (booking_id, type, channel, recipient, subject, status, error)
       VALUES (?, ?, 'email', ?, ?, ?, ?)`
    ).bind(bookingId || null, type || 'confirmation', to, subject, status, error).run();
  } catch (logErr) {
    console.error('Failed to log notification:', logErr);
  }

  return { success: status === 'sent', status, error };
}
