/**
 * What Next Cloud — Per-user AES-256-GCM encryption
 *
 * Key derivation: PBKDF2(rawApiKey + userId, ENCRYPTION_SECRET, 100_000 iters, sha256) → 32 bytes
 * Wire format: base64(iv [12 bytes] + authTag [16 bytes] + ciphertext)
 *
 * ENCRYPTION_SECRET must be set in env — a random 32+ char string, never rotated.
 */
import { createHash, pbkdf2Sync, randomBytes, createCipheriv, createDecipheriv } from 'crypto';

const ITERATIONS = 100_000;
const KEYLEN = 32;
const DIGEST = 'sha256';

function getSecret() {
  const s = process.env.ENCRYPTION_SECRET;
  if (!s) throw new Error('ENCRYPTION_SECRET env var not set');
  return s;
}

/**
 * Derive a per-user AES key from the raw API key and user id.
 * Result is cached in a Map for the process lifetime (keys don't change).
 */
const keyCache = new Map();

export function deriveKey(rawApiKey, userId) {
  const cacheKey = `${rawApiKey}:${userId}`;
  if (keyCache.has(cacheKey)) return keyCache.get(cacheKey);

  const salt = Buffer.from(getSecret() + String(userId), 'utf8');
  const material = Buffer.from(rawApiKey, 'utf8');
  const key = pbkdf2Sync(material, salt, ITERATIONS, KEYLEN, DIGEST);

  keyCache.set(cacheKey, key);
  return key;
}

/**
 * Encrypt plaintext → base64 blob.
 * Returns null if text is null/undefined (passes through).
 */
export function encrypt(text, key) {
  if (text == null) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

/**
 * Decrypt base64 blob → plaintext string.
 * Returns null if blob is null/undefined.
 */
export function decrypt(blob, key) {
  if (blob == null) return null;
  const buf = Buffer.from(blob, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/**
 * Encrypt a set of fields in an object.
 * Returns a new object with those fields encrypted; other fields untouched.
 */
export function encryptFields(obj, fields, key) {
  const out = { ...obj };
  for (const f of fields) {
    if (f in out) out[f] = encrypt(out[f], key);
  }
  return out;
}

/**
 * Decrypt a set of fields in an object. Symmetric of encryptFields.
 */
export function decryptFields(obj, fields, key) {
  const out = { ...obj };
  for (const f of fields) {
    if (f in out) out[f] = decrypt(out[f], key);
  }
  return out;
}

/**
 * Hash a raw API key for storage / lookup.
 */
export function hashApiKey(rawKey) {
  return createHash('sha256').update(rawKey).digest('hex');
}

export const SESSION_FIELDS = ['summary', 'what_was_built', 'decisions', 'stack', 'next_steps'];
export const FACT_FIELDS = ['content'];
