/**
 * What Next Cloud — API key authentication middleware
 *
 * Reads X-API-Key header, hashes it, looks up the users table.
 * On success: injects req.userId, req.rawApiKey into the request.
 * On failure: 401.
 */
import { getUserByKeyHash } from './db.js';
import { deriveKey, hashApiKey } from './crypto.js';

export async function requireApiKey(req, res, next) {
  const rawKey = req.headers['x-api-key'];
  if (!rawKey) {
    return res.status(401).json({ error: 'X-API-Key header required' });
  }

  try {
    const hash = hashApiKey(rawKey);
    const user = await getUserByKeyHash(hash);
    if (!user) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    req.userId = user.id;
    req.rawApiKey = rawKey;
    req.encKey = deriveKey(rawKey, user.id);
    next();
  } catch (err) {
    console.error('Auth error:', err);
    res.status(500).json({ error: 'Auth check failed' });
  }
}

export function requireAdminSecret(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    return res.status(503).json({ error: 'Admin endpoint not configured' });
  }
  if (req.headers['x-admin-secret'] !== secret) {
    return res.status(401).json({ error: 'Invalid admin secret' });
  }
  next();
}
