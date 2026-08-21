export const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE admins (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        force_password_change INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE admin_sessions (
        token_hash TEXT PRIMARY KEY,
        admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE INDEX idx_admin_sessions_expiry ON admin_sessions(expires_at);

      CREATE TABLE streamers (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        bili_uid TEXT NOT NULL UNIQUE,
        room_id TEXT NOT NULL UNIQUE,
        dynamic_url TEXT NOT NULL,
        live_url TEXT NOT NULL,
        avatar_url TEXT,
        timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
        enabled INTEGER NOT NULL DEFAULT 1,
        live_poll_seconds INTEGER NOT NULL DEFAULT 30,
        dynamic_poll_seconds INTEGER NOT NULL DEFAULT 300,
        last_dynamic_sync_at TEXT,
        last_comment_sync_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE live_state (
        streamer_id TEXT PRIMARY KEY REFERENCES streamers(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'unknown',
        title TEXT,
        checked_at TEXT,
        changed_at TEXT
      );

      CREATE TABLE live_sessions (
        id TEXT PRIMARY KEY,
        streamer_id TEXT NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
        title TEXT,
        observed_start_at TEXT NOT NULL,
        observed_end_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_live_sessions_streamer_start ON live_sessions(streamer_id, observed_start_at DESC);

      CREATE TABLE dynamics (
        id TEXT PRIMARY KEY,
        streamer_id TEXT NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        text TEXT NOT NULL DEFAULT '',
        source_url TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'visible',
        published_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        comment_oid TEXT,
        comment_type TEXT,
        comment_count INTEGER NOT NULL DEFAULT 0,
        like_count INTEGER NOT NULL DEFAULT 0,
        raw_excerpt TEXT
      );
      CREATE INDEX idx_dynamics_streamer_published ON dynamics(streamer_id, published_at DESC, id DESC);

      CREATE TABLE dynamic_revisions (
        id TEXT PRIMARY KEY,
        dynamic_id TEXT NOT NULL REFERENCES dynamics(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE comments (
        id TEXT PRIMARY KEY,
        dynamic_id TEXT NOT NULL REFERENCES dynamics(id) ON DELETE CASCADE,
        root_id TEXT,
        parent_id TEXT,
        author_uid TEXT NOT NULL,
        author_name TEXT NOT NULL,
        avatar_url TEXT,
        message TEXT NOT NULL,
        like_count INTEGER NOT NULL DEFAULT 0,
        reply_count INTEGER NOT NULL DEFAULT 0,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        is_streamer INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'visible',
        content_hash TEXT NOT NULL,
        published_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE INDEX idx_comments_dynamic_root_time ON comments(dynamic_id, root_id, published_at DESC, id DESC);
      CREATE INDEX idx_comments_dynamic_signal ON comments(dynamic_id, is_streamer, is_pinned);

      CREATE TABLE comment_revisions (
        id TEXT PRIMARY KEY,
        comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
        message TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE media_assets (
        id TEXT PRIMARY KEY,
        sha256 TEXT UNIQUE,
        source_url TEXT NOT NULL,
        local_path TEXT,
        mime_type TEXT,
        byte_size INTEGER,
        width INTEGER,
        height INTEGER,
        state TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_media_source_url ON media_assets(source_url);

      CREATE TABLE dynamic_media (
        dynamic_id TEXT NOT NULL REFERENCES dynamics(id) ON DELETE CASCADE,
        media_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        PRIMARY KEY(dynamic_id, media_id)
      );

      CREATE TABLE comment_media (
        comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
        media_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        PRIMARY KEY(comment_id, media_id)
      );

      CREATE TABLE schedule_rules (
        id TEXT PRIMARY KEY,
        streamer_id TEXT NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
        weekday INTEGER NOT NULL CHECK(weekday BETWEEN 1 AND 7),
        local_time TEXT NOT NULL,
        title TEXT,
        source TEXT NOT NULL,
        source_ref TEXT,
        confidence INTEGER NOT NULL CHECK(confidence BETWEEN 0 AND 100),
        effective_from TEXT,
        effective_to TEXT,
        locked INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_schedule_rules_streamer ON schedule_rules(streamer_id, active, weekday);

      CREATE TABLE schedule_exceptions (
        id TEXT PRIMARY KEY,
        streamer_id TEXT NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
        occurrence_date TEXT NOT NULL,
        start_at TEXT,
        status TEXT NOT NULL DEFAULT 'scheduled',
        title TEXT,
        source TEXT NOT NULL,
        source_ref TEXT,
        confidence INTEGER NOT NULL CHECK(confidence BETWEEN 0 AND 100),
        locked INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(streamer_id, occurrence_date, source_ref)
      );

      CREATE TABLE forecasts (
        id TEXT PRIMARY KEY,
        streamer_id TEXT NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
        predicted_start_at TEXT NOT NULL,
        confidence INTEGER NOT NULL CHECK(confidence BETWEEN 0 AND 100),
        source TEXT NOT NULL,
        reason TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        stale INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_forecasts_active ON forecasts(streamer_id, active, created_at DESC);

      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        entity_id TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending',
        priority INTEGER NOT NULL DEFAULT 100,
        due_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 8,
        lease_owner TEXT,
        lease_until TEXT,
        last_error TEXT,
        dedupe_key TEXT UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_jobs_ready ON jobs(status, due_at, priority);

      CREATE TABLE comment_sync_state (
        dynamic_id TEXT PRIMARY KEY REFERENCES dynamics(id) ON DELETE CASCADE,
        offset TEXT,
        is_complete INTEGER NOT NULL DEFAULT 0,
        last_full_sync_at TEXT,
        next_sync_at TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE secrets (
        key TEXT PRIMARY KEY,
        encrypted_value TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'untested',
        last_tested_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE api_tokens (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_prefix TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        scopes_json TEXT NOT NULL,
        expires_at TEXT,
        last_used_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE alerts (
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        occurrences INTEGER NOT NULL DEFAULT 1,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        acknowledged_at TEXT,
        resolved_at TEXT
      );
      CREATE UNIQUE INDEX idx_alerts_open_fingerprint ON alerts(fingerprint) WHERE status = 'open';

      CREATE TABLE audit_log (
        id TEXT PRIMARY KEY,
        actor_type TEXT NOT NULL,
        actor_id TEXT,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        before_json TEXT,
        after_json TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_audit_created ON audit_log(created_at DESC);

      CREATE TABLE ai_usage (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        purpose TEXT NOT NULL,
        streamer_id TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cost REAL,
        success INTEGER NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE pi_event_cursors (
        streamer_id TEXT PRIMARY KEY REFERENCES streamers(id) ON DELETE CASCADE,
        last_dynamic_at TEXT,
        last_comment_at TEXT,
        last_live_change_at TEXT,
        summary_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      );
    `
  },
  {
    version: 2,
    sql: `
      CREATE TABLE pi_conversations (
        id TEXT PRIMARY KEY,
        streamer_id TEXT REFERENCES streamers(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        summary_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(streamer_id, kind)
      );

      CREATE TABLE pi_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES pi_conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_pi_messages_conversation ON pi_messages(conversation_id, created_at);

      CREATE TABLE pi_tool_runs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES pi_conversations(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        result_json TEXT,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
    `
  },
  {
    version: 3,
    sql: `
      CREATE TABLE idempotency_keys (
        key TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        response_status INTEGER NOT NULL,
        response_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_idempotency_expiry ON idempotency_keys(expires_at);
    `
  },
  {
    version: 4,
    sql: `
      ALTER TABLE streamers ADD COLUMN dynamic_history_initialized_at TEXT;
      UPDATE jobs SET priority=20 WHERE type='download_media' AND status IN ('pending','retry');
    `
  },
  {
    version: 5,
    sql: `
      ALTER TABLE streamers ADD COLUMN last_dynamic_full_sync_at TEXT;
    `
  }
] as const;
