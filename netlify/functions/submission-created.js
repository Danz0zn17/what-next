// Netlify form submission handler.
// Fires automatically when any Netlify form on this site is submitted.
// Forwards beta-signup submissions to the Railway webhook which creates the user,
// generates an API key, and sends the welcome email via Resend.
//
// Netlify only triggers this for verified (non-spam) submissions and blocks
// direct HTTP calls to event functions, but the body is still validated here:
// anything that is not a well-formed form event is refused before it can reach
// the signup webhook.

const CLOUD_URL = 'https://what-next-production.up.railway.app';
const MAX_EMAIL_LEN = 254;
const MAX_NAME_LEN = 80;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export const handler = async (event) => {
  try {
    let body;
    try {
      body = JSON.parse(event?.body ?? '');
    } catch {
      return { statusCode: 400, body: 'Invalid body' };
    }
    const payload = isObject(body) ? body.payload : null;
    if (!isObject(payload) || !isObject(payload.data) || typeof payload.form_name !== 'string') {
      return { statusCode: 400, body: 'Missing payload' };
    }

    const formName = payload.form_name;
    if (!formName.includes('beta') && !formName.includes('signup')) {
      // Ignore unrelated form submissions (contact, etc.)
      return { statusCode: 200, body: 'Ignored' };
    }

    // Honeypot (netlify-honeypot="bot-field"): a filled field is a bot.
    const honeypot = payload.data['bot-field'];
    if (honeypot != null && honeypot !== '') {
      return { statusCode: 200, body: 'Ignored' };
    }

    const { name, email } = payload.data;
    if (typeof email !== 'string' || !email.trim()) {
      return { statusCode: 400, body: 'Missing email' };
    }
    const cleanEmail = email.trim();
    if (cleanEmail.length > MAX_EMAIL_LEN || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) {
      return { statusCode: 400, body: 'Invalid email' };
    }
    if (name != null && typeof name !== 'string') {
      return { statusCode: 400, body: 'Invalid name' };
    }
    const cleanName = (name ?? '').trim().slice(0, MAX_NAME_LEN) || cleanEmail.split('@')[0];

    const secret = process.env.WEBHOOK_SECRET;
    if (!secret) {
      console.error('[submission-created] WEBHOOK_SECRET not set');
      return { statusCode: 500, body: 'Server misconfiguration' };
    }

    // Secret travels in a header, not the query string, so it stays out of proxy and access logs.
    const response = await fetch(`${CLOUD_URL}/webhooks/beta-signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': secret },
      body: JSON.stringify({ name: cleanName, email: cleanEmail }),
      signal: AbortSignal.timeout(15_000),
    });

    const text = await response.text();
    if (!response.ok) {
      console.error(`[submission-created] Railway webhook error ${response.status}: ${text}`);
      return { statusCode: 502, body: 'Upstream error' };
    }

    console.log(`[submission-created] User created: ${cleanEmail}`);
    return { statusCode: 200, body: 'OK' };
  } catch (err) {
    console.error('[submission-created] Unhandled error:', err.message);
    return { statusCode: 500, body: 'Internal error' };
  }
};
