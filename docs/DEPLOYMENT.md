# Linux Deployment

Install Node.js 24 LTS and Nginx. Build on the server or copy the repository, then run:

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run build
sudo useradd --system --home /var/lib/vtb-monitor --shell /usr/sbin/nologin vtb-monitor
sudo install -d -o vtb-monitor -g vtb-monitor /var/lib/vtb-monitor
sudo install -m 0644 deploy/vtb-monitor.service /etc/systemd/system/vtb-monitor.service
```

Create `/etc/vtb-monitor.env` from `.env.example`. Generate the encryption key with `openssl rand -base64 32`. Set a one-time `ADMIN_INITIAL_PASSWORD`; after the first login, remove that variable or rotate the password with `npm run admin:reset-password -- 'new-long-password'`.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now vtb-monitor
sudo systemctl status vtb-monitor
```

Install `deploy/nginx.conf` after changing the host name, then configure TLS. Do not proxy or firewall-expose port 4312.

## Backup and restore

`npm run backup` uses SQLite's online backup API and prints the new file under `$DATA_DIR/backups`. Schedule it from a systemd timer and copy backups off-host together with the media directory. The encrypted database is useless without the same `APP_ENCRYPTION_KEY`; back up that key separately.

To restore, stop the service, verify the chosen backup with `sqlite3 backup.sqlite 'PRAGMA integrity_check;'`, move the current database aside, copy the backup to `$DATA_DIR/vtb-monitor.sqlite`, set ownership to `vtb-monitor`, and restart. Keep the moved database until the restored site is verified.

Run `npm run doctor` after deployment or restore. It verifies the encryption key, writable data directory and SQLite integrity.
