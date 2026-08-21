import { randomUUID } from 'node:crypto';
import { closeDb, getDb } from '../src/lib/server/db';
import { hashPassword } from '../src/lib/server/security';

const password = process.argv[2];
if (!password) throw new Error('Usage: npm run admin:reset-password -- <new-password>');
const db = getDb();
const timestamp = new Date().toISOString();
const encoded = await hashPassword(password);
const existing = db.prepare("SELECT id FROM admins WHERE username='admin'").get() as { id?: string } | undefined;
if (existing?.id) {
  db.prepare("UPDATE admins SET password_hash=?,force_password_change=0,updated_at=? WHERE username='admin'")
    .run(encoded, timestamp);
  db.prepare('DELETE FROM admin_sessions WHERE admin_id=?').run(existing.id);
} else {
  db.prepare(`INSERT INTO admins(id,username,password_hash,force_password_change,created_at,updated_at)
    VALUES (?, 'admin', ?, 0, ?, ?)`).run(randomUUID(), encoded, timestamp, timestamp);
}
closeDb();
console.log('Admin password updated and existing sessions revoked.');
