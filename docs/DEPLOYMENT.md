# Linux Deployment

Install Node.js 24 LTS and Nginx. Build and verify on a development machine or in CI:

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run build
```

Do not run dependency installation, Vite builds, Playwright installation, or the full test suite on a small production host. Upload the generated `build/` directory together with `server/`, `scripts/scheduler.ts`, `src/lib/server/`, `package.json`, `package-lock.json`, and `tsconfig.json`. Never upload `node_modules` from Windows or macOS; reuse or install Linux production dependencies separately.

On the server, install the service files and start the web and core scheduler processes:

```bash
sudo useradd --system --home /var/lib/vtb-monitor --shell /usr/sbin/nologin vtb-monitor
sudo install -d -o vtb-monitor -g vtb-monitor /var/lib/vtb-monitor
sudo install -m 0644 deploy/vtb-monitor.service /etc/systemd/system/vtb-monitor.service
sudo install -m 0644 deploy/vtb-monitor-scheduler.service /etc/systemd/system/vtb-monitor-scheduler.service
```

Create `/etc/vtb-monitor.env` from `.env.example`. Generate the encryption key with `openssl rand -base64 32`. Set a one-time `ADMIN_INITIAL_PASSWORD`; after the first login, remove that variable or rotate the password with `npm run admin:reset-password -- 'new-long-password'`.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now vtb-monitor vtb-monitor-scheduler
sudo systemctl status vtb-monitor
```

Keep `vtb-monitor-worker.service` disabled initially. Enable it only after checking queue depth, memory, and disk I/O; it processes comments, media, Pi, and maintenance jobs.

Install `deploy/nginx.conf` after changing the host name, then configure TLS. Do not proxy or firewall-expose port 4312.

## Backup and restore

`npm run backup` uses SQLite's online backup API and prints the new file under `$DATA_DIR/backups`. Schedule it from a systemd timer and copy backups off-host together with the media directory. The encrypted database is useless without the same `APP_ENCRYPTION_KEY`; back up that key separately.

To restore, stop the service, verify the chosen backup with `sqlite3 backup.sqlite 'PRAGMA integrity_check;'`, move the current database aside, copy the backup to `$DATA_DIR/vtb-monitor.sqlite`, set ownership to `vtb-monitor`, and restart. Keep the moved database until the restored site is verified.

Run `npm run doctor` after deployment or restore. It verifies the encryption key, writable data directory and SQLite integrity.
