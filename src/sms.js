// Calendo - SMS Notification System
// Sends SMS via Twilio API

export async function sendSMS(env, { to, body, bookingId, type }) {
  if (env.DISABLE_OUTBOUND_NOTIFICATIONS === '1' || env.DISABLE_OUTBOUND_NOTIFICATIONS === 1 || env.DISABLE_OUTBOUND_NOTIFICATIONS === true) {
    return { success: true, status: 'skipped', error: null };
  }

  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;
  const fromNumber = env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !authToken || !fromNumber) {
    console.error('SMS: Twilio credentials not configured');
    return { success: false, status: 'failed', error: 'Twilio not configured' };
  }

  let status = 'sent';
  let error = null;

  try {
    const credentials = btoa(`${accountSid}:${authToken}`);
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          To: to,
          From: fromNumber,
          Body: body,
        }),
      }
    );

    if (!response.ok) {
      const responseBody = await response.text();
      status = 'failed';
      error = `Twilio ${response.status}: ${responseBody}`;
      console.error('SMS send failed:', error);
    }
  } catch (err) {
    status = 'failed';
    error = err.message;
    console.error('SMS send error:', err);
  }

  // Log in notification_log
  try {
    await env.DB.prepare(
      `INSERT INTO notification_log (booking_id, type, channel, recipient, subject, status, error)
       VALUES (?, ?, 'sms', ?, ?, ?, ?)`
    ).bind(bookingId || null, type || 'confirmation', to, body.slice(0, 100), status, error).run();
  } catch (logErr) {
    console.error('Failed to log SMS notification:', logErr);
  }

  return { success: status === 'sent', status, error };
}
