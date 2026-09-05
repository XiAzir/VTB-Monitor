import nodemailer from 'nodemailer';
import { getDb } from './db';
import { getSecret, getSetting } from './store';

type Row = Record<string, unknown>;

interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  username?: string;
  from: string;
  to: string;
}

export async function sendAlertEmail(alertId: string): Promise<void> {
  const alert = getDb().prepare('SELECT * FROM alerts WHERE id=?').get(alertId) as Row | undefined;
  if (!alert) return;
  const smtp = getSetting<SmtpSettings | null>('smtp', null);
  if (!smtp?.host || !smtp.to || !smtp.from) throw new Error('SMTP 尚未配置');
  const password = getSecret('smtp_password');
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: Number(smtp.port || 587),
    secure: Boolean(smtp.secure),
    auth: smtp.username ? { user: smtp.username, pass: password ?? '' } : undefined,
    connectionTimeout: 15_000,
    socketTimeout: 20_000
  });
  await transport.sendMail({
    from: smtp.from,
    to: smtp.to,
    subject: `[VTB Monitor] ${String(alert.title)}`,
    text: `${String(alert.message)}\n\n严重级别：${String(alert.severity)}\n首次发生：${String(alert.first_seen_at)}\n最近发生：${String(alert.last_seen_at)}`
  });
}
