CREATE TABLE schema_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL
);
INSERT INTO schema_meta (id, schema_version) VALUES (1, 1);

CREATE TABLE people (id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE account_labels (id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE account_refs (id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE chat_triage (id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE contacts (id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE chat_contact_links (id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE facts (id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE pins (id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE templates (id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE follow_ups (id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE internal_notes (id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE deals (id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE ai_drafts (id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE members (id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE account_grants (id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE assignments (id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE handoffs (id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE webhook_endpoints (id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE webhook_deliveries (id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE stages (id TEXT PRIMARY KEY, body TEXT NOT NULL);

CREATE TABLE cases (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  follow_up_at INTEGER,
  body TEXT NOT NULL
);

CREATE TABLE case_chats (
  case_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (case_id, account_id, chat_id)
);
CREATE INDEX idx_case_chats_chat ON case_chats (account_id, chat_id);

CREATE TABLE case_participants (
  case_id TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (case_id, telegram_user_id)
);

CREATE TABLE case_messages (
  case_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (case_id, account_id, chat_id, message_id)
);
CREATE INDEX idx_case_messages_lookup ON case_messages (account_id, chat_id, message_id);

CREATE TABLE case_notes (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE TABLE case_files (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE TABLE case_events (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  body TEXT NOT NULL
);
