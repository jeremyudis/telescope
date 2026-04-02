-- Telemetry inventory per repo
CREATE TABLE IF NOT EXISTS telemetry_inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  file_path TEXT NOT NULL,
  segment_type TEXT NOT NULL,
  language TEXT NOT NULL,
  content TEXT NOT NULL,
  context TEXT,
  indexed_at TEXT NOT NULL,
  UNIQUE(owner, repo, file_path, segment_type, content)
);
CREATE INDEX IF NOT EXISTS idx_inventory_repo ON telemetry_inventory(owner, repo);
CREATE INDEX IF NOT EXISTS idx_inventory_type ON telemetry_inventory(owner, repo, segment_type);

-- Recommendation history with feedback
CREATE TABLE IF NOT EXISTS recommendation_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  file_path TEXT NOT NULL,
  acted_on BOOLEAN,
  feedback TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_repo ON recommendation_history(owner, repo);
CREATE INDEX IF NOT EXISTS idx_history_feedback ON recommendation_history(owner, repo, category, acted_on);

-- Repo profile metadata
CREATE TABLE IF NOT EXISTS repo_profiles (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  last_indexed_at TEXT,
  last_indexed_sha TEXT,
  default_branch TEXT,
  primary_language TEXT,
  telemetry_stack TEXT,
  framework TEXT,
  total_reviews INTEGER DEFAULT 0,
  PRIMARY KEY (owner, repo)
);
