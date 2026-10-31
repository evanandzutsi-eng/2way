-- 2WaY initial schema
-- Every statement here runs inside one transaction (see server/db/migrate.js).

-- ---------------------------------------------------------------------------
-- Members
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id               BIGSERIAL PRIMARY KEY,
  username         TEXT        NOT NULL,
  password_hash    TEXT,                       -- NULL once an account is deleted
  role             TEXT        NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  status           TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  avatar_seed      TEXT        NOT NULL,
  status_message   TEXT        NOT NULL DEFAULT '' CHECK (char_length(status_message) <= 80),
  -- Cached total of xp_events.amount; written only inside the same transaction
  -- as the xp_events insert so the two can never drift (see services/xp.js).
  xp               INTEGER     NOT NULL DEFAULT 0 CHECK (xp >= 0),
  failed_logins    SMALLINT    NOT NULL DEFAULT 0,
  locked_until     TIMESTAMPTZ,
  last_seen_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,
  CONSTRAINT username_format CHECK (username ~ '^[A-Za-z0-9_]{3,20}$' OR status = 'deleted')
);
CREATE UNIQUE INDEX users_username_lower_key ON users (lower(username));

CREATE TABLE user_preferences (
  user_id           BIGINT  PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  theme             TEXT    NOT NULL DEFAULT 'dark' CHECK (theme IN ('dark', 'light')),
  show_presence     BOOLEAN NOT NULL DEFAULT true,
  read_receipts     BOOLEAN NOT NULL DEFAULT true,
  show_in_activity  BOOLEAN NOT NULL DEFAULT true,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Opaque random token in an HttpOnly cookie; only its SHA-256 is stored.
CREATE TABLE sessions (
  token_hash    BYTEA       PRIMARY KEY,
  user_id       BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  user_agent    TEXT        NOT NULL DEFAULT '' CHECK (char_length(user_agent) <= 200)
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- Single-use, expiring, revocable, bound to an intended username.
CREATE TABLE invites (
  id                 BIGSERIAL PRIMARY KEY,
  code_hash          BYTEA       NOT NULL UNIQUE,
  intended_username  TEXT        NOT NULL CHECK (intended_username ~ '^[A-Za-z0-9_]{3,20}$'),
  note               TEXT        NOT NULL DEFAULT '' CHECK (char_length(note) <= 120),
  created_by         BIGINT      REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  revoked_at         TIMESTAMPTZ,
  used_at            TIMESTAMPTZ,
  used_by            BIGINT      REFERENCES users(id) ON DELETE SET NULL,
  CHECK (NOT (used_at IS NOT NULL AND revoked_at IS NOT NULL))
);
-- At most one open invite per intended username.
CREATE UNIQUE INDEX invites_open_username_key ON invites (lower(intended_username))
  WHERE used_at IS NULL AND revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Rooms
-- ---------------------------------------------------------------------------
CREATE TABLE rooms (
  id            BIGSERIAL PRIMARY KEY,
  slug          TEXT        NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,32}$'),
  name          TEXT        NOT NULL CHECK (char_length(name) BETWEEN 2 AND 32),
  description   TEXT        NOT NULL DEFAULT '' CHECK (char_length(description) <= 120),
  color         TEXT        NOT NULL DEFAULT 'violet' CHECK (color IN ('violet','indigo','green','amber','cyan','rose')),
  icon          TEXT        NOT NULL DEFAULT 'chat',
  is_restricted BOOLEAN     NOT NULL DEFAULT false,
  sort_order    INTEGER     NOT NULL DEFAULT 100,
  archived_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only consulted for restricted rooms; open rooms admit every active member.
CREATE TABLE room_memberships (
  room_id    BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX room_memberships_user_idx ON room_memberships (user_id);

CREATE TABLE messages (
  id          BIGSERIAL PRIMARY KEY,
  room_id     BIGINT      NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT        NOT NULL CHECK (char_length(body) <= 2000),
  client_id   UUID        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  deleted_by  BIGINT      REFERENCES users(id) ON DELETE SET NULL,
  CHECK (deleted_at IS NOT NULL OR char_length(body) >= 1),
  UNIQUE (user_id, client_id)            -- idempotent retries
);
CREATE INDEX messages_room_history_idx ON messages (room_id, id DESC);
CREATE INDEX messages_created_idx ON messages (created_at);

CREATE TABLE message_reactions (
  message_id BIGINT      NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT        NOT NULL CHECK (emoji IN ('fire','laugh','heart','goal','clap','skull')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX message_reactions_user_idx ON message_reactions (user_id);

-- ---------------------------------------------------------------------------
-- Direct messages (strictly one-to-one)
-- ---------------------------------------------------------------------------
CREATE TABLE dm_conversations (
  id          BIGSERIAL PRIMARY KEY,
  -- Ordered pair used only to guarantee one conversation per pair of members.
  user_low    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_high   BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_at TIMESTAMPTZ,
  CHECK (user_low < user_high),
  UNIQUE (user_low, user_high)
);

-- Per-participant state; also the table every access check joins against.
CREATE TABLE dm_participants (
  conversation_id      BIGINT NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,
  user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_message_id BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX dm_participants_user_idx ON dm_participants (user_id);

CREATE TABLE dm_messages (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT      NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,
  sender_id       BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body            TEXT        NOT NULL CHECK (char_length(body) <= 2000),
  client_id       UUID        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  CHECK (deleted_at IS NOT NULL OR char_length(body) >= 1),
  UNIQUE (sender_id, client_id)
);
CREATE INDEX dm_messages_history_idx ON dm_messages (conversation_id, id DESC);
CREATE INDEX dm_messages_created_idx ON dm_messages (created_at);

-- ---------------------------------------------------------------------------
-- XP, ranks and achievements
-- ---------------------------------------------------------------------------
CREATE TABLE xp_events (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount     INTEGER     NOT NULL CHECK (amount BETWEEN -1000 AND 1000 AND amount <> 0),
  reason     TEXT        NOT NULL CHECK (char_length(reason) BETWEEN 2 AND 64),
  -- Idempotency key: the same rule can never pay out twice for the same thing.
  ref_key    TEXT,
  granted_by BIGINT      REFERENCES users(id) ON DELETE SET NULL,
  note       TEXT        NOT NULL DEFAULT '' CHECK (char_length(note) <= 120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX xp_events_ref_key ON xp_events (user_id, ref_key) WHERE ref_key IS NOT NULL;
CREATE INDEX xp_events_user_time_idx ON xp_events (user_id, created_at DESC);

CREATE TABLE achievements (
  code        TEXT    PRIMARY KEY CHECK (code ~ '^[a-z_]{2,32}$'),
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL,
  icon        TEXT    NOT NULL DEFAULT 'star',
  xp_reward   INTEGER NOT NULL DEFAULT 0 CHECK (xp_reward BETWEEN 0 AND 500),
  sort_order  INTEGER NOT NULL DEFAULT 100
);

CREATE TABLE member_achievements (
  user_id          BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_code TEXT        NOT NULL REFERENCES achievements(code) ON DELETE CASCADE,
  earned_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, achievement_code)
);

-- Distinct active days per member (drives the streak achievement without
-- scanning message history).
CREATE TABLE member_active_days (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day     DATE   NOT NULL,
  PRIMARY KEY (user_id, day)
);

-- ---------------------------------------------------------------------------
-- Activity feed (never contains message bodies)
-- ---------------------------------------------------------------------------
CREATE TABLE activity (
  id         BIGSERIAL PRIMARY KEY,
  kind       TEXT        NOT NULL CHECK (kind IN ('member_joined','rank_up','achievement','room_created')),
  user_id    BIGINT      REFERENCES users(id) ON DELETE CASCADE,
  room_id    BIGINT      REFERENCES rooms(id) ON DELETE CASCADE,
  data       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX activity_recent_idx ON activity (id DESC);

-- ---------------------------------------------------------------------------
-- Administration
-- ---------------------------------------------------------------------------
CREATE TABLE audit_events (
  id          BIGSERIAL PRIMARY KEY,
  actor_id    BIGINT      REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT        NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  details     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_recent_idx ON audit_events (id DESC);
CREATE INDEX audit_events_actor_idx ON audit_events (actor_id, id DESC);

CREATE TABLE app_settings (
  key        TEXT  PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL
);
