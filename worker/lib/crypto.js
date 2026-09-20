// Same AES-256-GCM scheme the Next.js app uses to store Slack/Gmail tokens (lib/crypto.js there),
// so the worker can use the tokens the owner already connected.
import crypto from 'node:crypto';

const key = () => crypto.createHash('sha256').update(process.env.TOKEN_ENCRYPTION_KEY).digest();

export function decrypt(blob) {
  if (!blob) return null;
  const buf = Buffer.from(blob, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}
