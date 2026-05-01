// Netlify form submission handler.
// Fires automatically when any Netlify form on this site is submitted.
// Forwards beta-signup submissions to the Railway webhook which creates the user,
// generates an API key, and sends the welcome email via Resend.

const CLOUD_URL = 'https://what-next-production.up.railway.app';

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body);
    const { payload } = body;

    if (!payload || !payload.data) {
      return { statusCode: 400, body: 'Missing payload' };
    }

    const formName = payload.form_name || '';
    if (!formName.includes('beta') && !formName.includes('signup')) {
      // Ignore unrelated form submissions (contact, etc.)
      return { statusCode: 200, body: 'Ignored' };
    }

    const { name, email } = payload.data;
    if (!email) {
      return { statusCode: 400, body: 'Missing email' };
    }

    const secret = process.env.WEBHOOK_SECRET;
    if (!secret) {
      console.error('[submission-created] WEBHOOK_SECRET not set');
      return { statusCode: 500, body: 'Server misconfiguration' };
    }

    const response = await fetch(`${CLOUD_URL}/webhooks/beta-signup?secret=${encodeURIComponent(secret)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name || email.split('@')[0], email }),
    });

    const text = await response.text();
    if (!response.ok) {
      console.error(`[submission-created] Railway webhook error ${response.status}: ${text}`);
      return { statusCode: 502, body: 'Upstream error' };
    }

    console.log(`[submission-created] User created: ${email}`);
    return { statusCode: 200, body: 'OK' };
  } catch (err) {
    console.error('[submission-created] Unhandled error:', err.message);
    return { statusCode: 500, body: 'Internal error' };
  }
};
