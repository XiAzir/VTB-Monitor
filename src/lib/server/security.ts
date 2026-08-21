import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { getEncryptionKey } from './config';

const scryptAsync = promisify(scrypt);

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 10) throw new Error('密码至少需要 10 个字符');
  const salt = randomBytes(16);
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt:${salt.toString('base64')}:${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, saltText, hashText] = encoded.split(':');
  if (algorithm !== 'scrypt' || !saltText || !hashText) return false;
  const expected = Buffer.from(hashText, 'base64');
  const actual = (await scryptAsync(password, Buffer.from(saltText, 'base64'), expected.length)) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function encryptSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptSecret(encoded: string): string {
  const [version, ivText, tagText, encryptedText] = encoded.split(':');
  if (version !== 'v1' || !ivText || !tagText || !encryptedText) throw new Error('Unsupported encrypted value');
  const decipher = createDecipheriv('aes-256-gcm', getEncryptionKey(), Buffer.from(ivText, 'base64'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64')), decipher.final()]).toString('utf8');
}

export function createOpaqueToken(prefix = 'vtbm'): { token: string; hash: string; prefix: string } {
  const value = randomBytes(32).toString('base64url');
  const token = `${prefix}_${value}`;
  return { token, hash: hashToken(token), prefix: token.slice(0, 12) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function contentHash(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}
