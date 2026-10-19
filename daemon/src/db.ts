import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { ensureDir } from './util.ts';

export const DATA_DIR = process.env.OFFICE_DATA_DIR
  ? path.resolve(process.env.OFFICE_DATA_DIR)
  : path.resolve(process.cwd(), 'data');

ensureDir(DATA_DIR);
ensureDir(path.join(DATA_DIR, 'blobs'));

const db = new DatabaseSync(path.join(DATA_DIR, 'office.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT, ts TEXT NOT NULL, actor TEXT NOT NULL, type TEXT NOT NULL,
  entity_id TEXT, payload TEXT NOT NULL DEFAULT '{}', prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, adapter_id TEXT NOT NULL,
  adapter_version TEXT, adapter_hash TEXT, tier INTEGER, enabled INTEGER DEFAULT 1,
  capabilities TEXT DEFAULT '{}', config TEXT DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, label TEXT, secret_ref TEXT, plan TEXT,
  billing TEXT DEFAULT 'payg', monthly_budget_usd REAL, enabled INTEGER DEFAULT 1, config TEXT DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, name TEXT NOT NULL, context_tokens INTEGER DEFAULT 128000,
  max_output_tokens INTEGER DEFAULT 8192, price_in REAL DEFAULT 0, price_out REAL DEFAULT 0,
  strength_tier TEXT DEFAULT 'standard', supports TEXT DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, version INTEGER DEFAULT 1, responsibilities TEXT DEFAULT '[]',
  allowed_actions TEXT DEFAULT '[]', default_instructions TEXT DEFAULT '', default_skills TEXT DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, avatar TEXT DEFAULT '', account_id TEXT, model_id TEXT,
  settings TEXT DEFAULT '{}', instructions TEXT DEFAULT '', skill_version_ids TEXT DEFAULT '[]',
  caps TEXT DEFAULT '{}', observability TEXT DEFAULT 'actions', status TEXT DEFAULT 'idle'
);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, purpose TEXT DEFAULT '', repo_ids TEXT DEFAULT '[]',
  allowed_provider_ids TEXT DEFAULT '[]', policy_id TEXT, memory_scope TEXT DEFAULT 'isolated', settings TEXT DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, workspace_id TEXT NOT NULL, role_id TEXT NOT NULL,
  team TEXT, permissions_override TEXT, context_scope TEXT DEFAULT 'task', active_since TEXT,
  max_concurrent_tasks INTEGER DEFAULT 1, active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY, workspace_id TEXT, path TEXT NOT NULL, remote_url TEXT, default_branch TEXT DEFAULT 'main',
  integration_branch TEXT DEFAULT 'integration', build_cmd TEXT DEFAULT '', test_cmd TEXT DEFAULT '', check_profile_id TEXT
);
CREATE TABLE IF NOT EXISTS checks (
  id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, command TEXT DEFAULT '',
  parser TEXT DEFAULT 'exit0', pass_rule TEXT DEFAULT 'exit0', timeout_sec INTEGER DEFAULT 300,
  affected_paths TEXT DEFAULT '[]', protected INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS policies (id TEXT PRIMARY KEY, scope TEXT DEFAULT '{}', rules TEXT DEFAULT '[]');
CREATE TABLE IF NOT EXISTS dod (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, version INTEGER DEFAULT 1, items TEXT DEFAULT '[]', status TEXT DEFAULT 'draft'
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, repo_id TEXT, goal TEXT NOT NULL, status TEXT DEFAULT 'draft',
  dod_id TEXT, budget TEXT DEFAULT '{}', limits TEXT DEFAULT '{}', current_cycle INTEGER DEFAULT 0,
  plan_version INTEGER DEFAULT 0, started_at TEXT, checkpoint_id TEXT, stop_reason TEXT,
  progress_score REAL DEFAULT 0, spent_usd REAL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cycles (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, n INTEGER NOT NULL, phase TEXT DEFAULT 'plan', started_at TEXT,
  ended_at TEXT, progress_score REAL DEFAULT 0, spend_usd REAL DEFAULT 0, summary TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, parent_id TEXT, title TEXT NOT NULL, description TEXT DEFAULT '',
  type TEXT DEFAULT 'feature', status TEXT DEFAULT 'backlog', priority INTEGER DEFAULT 1, deadline TEXT,
  depends_on TEXT DEFAULT '[]', acceptance_criteria TEXT DEFAULT '[]', deliverables TEXT DEFAULT '[]',
  owner_agent_id TEXT, reviewer_agent_id TEXT, planned_by TEXT, branch TEXT, worktree TEXT,
  difficulty INTEGER DEFAULT 2, attempts INTEGER DEFAULT 0, budget_usd REAL DEFAULT 5, spent_usd REAL DEFAULT 0,
  dod_item_ids TEXT DEFAULT '[]', affected_paths TEXT DEFAULT '[]', meta TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_tasks_run ON tasks(run_id, status);
CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY, task_id TEXT, run_id TEXT NOT NULL, kind TEXT NOT NULL, agent_id TEXT,
  account_id TEXT, model_id TEXT, prompt_version_id TEXT, idempotency_key TEXT, status TEXT DEFAULT 'queued',
  started_at TEXT, heartbeat_at TEXT, finished_at TEXT, result TEXT, adapter_ref TEXT,
  error_signature TEXT, attempt INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_wi_run ON work_items(run_id, status);
CREATE TABLE IF NOT EXISTS prompt_versions (
  id TEXT PRIMARY KEY, work_item_id TEXT, template_id TEXT, version INTEGER DEFAULT 1,
  rendered_text TEXT DEFAULT '', context_pack_hash TEXT, edited_by_user INTEGER DEFAULT 0, created_at TEXT
);
CREATE TABLE IF NOT EXISTS check_runs (
  id TEXT PRIMARY KEY, check_id TEXT NOT NULL, work_item_id TEXT, task_id TEXT, run_id TEXT,
  commit_sha TEXT, ref TEXT DEFAULT '', status TEXT NOT NULL, duration_ms INTEGER DEFAULT 0,
  evidence_refs TEXT DEFAULT '[]', summary TEXT DEFAULT '', failures TEXT DEFAULT '[]', created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cr_task ON check_runs(task_id);
CREATE TABLE IF NOT EXISTS error_reports (
  id TEXT PRIMARY KEY, seq_no INTEGER, run_id TEXT, cycle_n INTEGER, task_id TEXT, work_item_id TEXT,
  severity TEXT, status TEXT DEFAULT 'open', failing_check TEXT DEFAULT '{}', title TEXT DEFAULT '',
  evidence TEXT DEFAULT '{}', reproduction TEXT DEFAULT '{}', affected_files TEXT DEFAULT '[]',
  suspected_cause TEXT DEFAULT '{}', signature TEXT DEFAULT '', related_errors TEXT DEFAULT '[]',
  suggested_fix TEXT DEFAULT '{}', assignment TEXT DEFAULT '{}', history TEXT DEFAULT '[]',
  escalation TEXT, resolution TEXT, created_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_err_sig ON error_reports(signature, status);
CREATE TABLE IF NOT EXISTS error_kb (
  id TEXT PRIMARY KEY, workspace_id TEXT, signature TEXT, error_text TEXT, root_cause TEXT,
  fix_summary TEXT, diff_excerpt TEXT, files TEXT DEFAULT '[]', tags TEXT DEFAULT '[]',
  times_seen INTEGER DEFAULT 1, created_at TEXT
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, work_item_id TEXT, task_id TEXT, run_id TEXT, action TEXT NOT NULL,
  payload TEXT DEFAULT '{}', requested_by TEXT, status TEXT DEFAULT 'pending', reason TEXT,
  decided_at TEXT, expires_at TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY, account_id TEXT, model_id TEXT, work_item_id TEXT, ts TEXT,
  input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0,
  requests INTEGER DEFAULT 1, cost_usd REAL DEFAULT 0, cost_source TEXT DEFAULT 'estimate'
);
CREATE TABLE IF NOT EXISTS quota_windows (
  id TEXT PRIMARY KEY, account_id TEXT, model_id TEXT, metric TEXT, kind TEXT, period TEXT,
  lim REAL, used REAL, remaining REAL, resets_at TEXT, source TEXT DEFAULT 'estimate',
  confidence TEXT DEFAULT 'unknown', observed_at TEXT
);
CREATE TABLE IF NOT EXISTS circuits (
  account_id TEXT NOT NULL, model_id TEXT NOT NULL DEFAULT '', state TEXT DEFAULT 'closed',
  opened_at TEXT, reason TEXT, next_probe_at TEXT, fails INTEGER DEFAULT 0,
  PRIMARY KEY (account_id, model_id)
);
CREATE TABLE IF NOT EXISTS timers (
  id TEXT PRIMARY KEY, run_id TEXT, fire_at TEXT NOT NULL, type TEXT NOT NULL, payload TEXT DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, seq INTEGER, snapshot TEXT DEFAULT '{}', created_at TEXT
);
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT DEFAULT '', owner_origin TEXT DEFAULT 'local',
  source_url TEXT, latest_version_id TEXT, enabled INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS skill_versions (
  id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, semver TEXT, content_hash TEXT, manifest TEXT DEFAULT '{}',
  review_status TEXT DEFAULT 'unreviewed', reviewed_at TEXT, review_notes TEXT, created_at TEXT, files TEXT DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS skill_attachments (
  id TEXT PRIMARY KEY, skill_version_id TEXT NOT NULL, target TEXT DEFAULT '{}', pinned INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS repo_checkpoints (
  id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, kind TEXT NOT NULL, parent_id TEXT,
  run_id TEXT, task_id TEXT, work_item_id TEXT, agent_id TEXT, label TEXT DEFAULT '', prompt TEXT DEFAULT '',
  before_tree TEXT NOT NULL, after_tree TEXT, files TEXT DEFAULT '[]', status TEXT NOT NULL,
  commit_sha TEXT, created_at TEXT NOT NULL, completed_at TEXT, changed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_repo_checkpoints ON repo_checkpoints(repo_id, created_at);
CREATE TABLE IF NOT EXISTS checkpoint_ops (
  id TEXT PRIMARY KEY, checkpoint_id TEXT NOT NULL, op TEXT NOT NULL, actor TEXT DEFAULT 'owner',
  ok INTEGER NOT NULL, detail TEXT DEFAULT '', files TEXT DEFAULT '[]', at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY, run_id TEXT, task_id TEXT, from_agent TEXT, to_agent TEXT, kind TEXT,
  summary TEXT DEFAULT '', artifacts TEXT DEFAULT '{}', created_at TEXT
);
CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY, run_id TEXT, task_id TEXT, work_item_id TEXT, from_agent TEXT NOT NULL,
  to_agent TEXT, to_role TEXT, kind TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT, read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_msg_run ON agent_messages(run_id, created_at);
CREATE TABLE IF NOT EXISTS message_deliveries (
  message_id TEXT NOT NULL, agent_id TEXT NOT NULL, delivered_at TEXT NOT NULL,
  PRIMARY KEY (message_id, agent_id)
);
CREATE TABLE IF NOT EXISTS provider_tombstones (id TEXT PRIMARY KEY, removed_at TEXT);
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
  description TEXT DEFAULT '', builtin INTEGER DEFAULT 0,
  latest_version_id TEXT, created_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_workflows_ws ON workflows(workspace_id);
CREATE TABLE IF NOT EXISTS workflow_versions (
  id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, n INTEGER NOT NULL,
  graph TEXT NOT NULL, note TEXT DEFAULT '', created_by TEXT DEFAULT 'owner', created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_wfver ON workflow_versions(workflow_id, n);
CREATE TABLE IF NOT EXISTS request_queue (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, text TEXT NOT NULL, source TEXT DEFAULT 'app',
  status TEXT DEFAULT 'queued', run_id TEXT, created_at TEXT, started_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_queue_ws ON request_queue(workspace_id, status);
`);

// Columns added after the first release — added in place, data kept.
function addColumn(table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}
addColumn('skill_versions', 'content', `TEXT`);          // SKILL.md text the agents receive
addColumn('skill_versions', 'source_dir', `TEXT`);       // where it was imported from
addColumn('skills', 'category', `TEXT DEFAULT 'role'`);   // 'general' (reusable) | 'role' (role-specific)
addColumn('skills', 'updated_at', `TEXT`);
addColumn('prompt_versions', 'dropped', `TEXT DEFAULT '[]'`);      // sections cut to fit the context budget
addColumn('prompt_versions', 'budget_chars', `INTEGER`);           // the budget the prompt was fitted to
addColumn('work_items', 'cache_key', `TEXT`);                      // (kind, prompt sha, pack hash, model) — result cache
db.exec(`CREATE INDEX IF NOT EXISTS idx_wi_cache ON work_items(cache_key, status)`);
addColumn('error_kb', 'repo_id', `TEXT`);                          // per-repo lessons (spec 6.5)
addColumn('runs', 'summary_md', `TEXT`);                           // model-free end-of-run summary (spec 6.6)
addColumn('runs', 'workflow_version_id', `TEXT`);                  // the graph version a run follows
addColumn('work_items', 'workflow_node_id', `TEXT`);               // graph node that produced this item
addColumn('work_items', 'workflow_edge_id', `TEXT`);               // …and the edge that led to it

// Stage 7 indexes: the hot predicates that had only run_id indexes before
db.exec(`CREATE INDEX IF NOT EXISTS idx_wi_task ON work_items(task_id, status)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_msg_run_read ON agent_messages(run_id, read_at)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_events_run_ts ON events(run_id, ts)`);

export default db;

type Row = Record<string, unknown>;

export function q(sql: string, ...params: unknown[]): Row[] {
  return db.prepare(sql).all(...(params as never[])) as Row[];
}
export function q1(sql: string, ...params: unknown[]): Row | undefined {
  return db.prepare(sql).get(...(params as never[])) as Row | undefined;
}
export function run(sql: string, ...params: unknown[]): void {
  db.prepare(sql).run(...(params as never[]));
}
export function tx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
