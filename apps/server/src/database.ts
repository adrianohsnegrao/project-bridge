import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { passwordHash } from "./web-auth.js";

const defaultDatabasePath = fileURLToPath(
  new URL("../../../.local/project-bridge.db", import.meta.url),
);

export type DatabaseConnection = Database.Database;

export function createDatabase(path = process.env.PROJECT_BRIDGE_DB ?? defaultDatabasePath): DatabaseConnection {
  if (path !== ":memory:") {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }

  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  seed(db);
  return db;
}

function migrate(db: DatabaseConnection): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      summary TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL,
      owner TEXT NOT NULL,
      progress INTEGER NOT NULL,
      target_date TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL,
      context TEXT NOT NULL,
      decision TEXT NOT NULL,
      status TEXT NOT NULL,
      decided_at TEXT
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      due_date TEXT,
      assignee TEXT,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS blockers (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL,
      impact TEXT NOT NULL,
      owner TEXT,
      status TEXT NOT NULL,
      opened_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approval_requests (
      id TEXT PRIMARY KEY,
      tool_name TEXT NOT NULL,
      operation TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id),
      arguments_json TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      justification TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      decided_at TEXT,
      decision_note TEXT,
      result_json TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      request_id TEXT,
      client_name TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      status TEXT NOT NULL,
      duration_ms REAL NOT NULL,
      details_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS web_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_web_sessions_expires ON web_sessions(expires_at);
  `);

  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const blockerColumns = new Set(
    (db.prepare("PRAGMA table_info(blockers)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!blockerColumns.has("resolved_at")) {
    db.exec("ALTER TABLE blockers ADD COLUMN resolved_at TEXT");
  }
  if (!blockerColumns.has("resolution_note")) {
    db.exec("ALTER TABLE blockers ADD COLUMN resolution_note TEXT");
  }

  const applied = new Set((db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map((row) => row.version));
  if (!applied.has(1)) {
    db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'baseline', ?)").run(new Date().toISOString());
  }
  if (!applied.has(2)) {
    const applyV2 = db.transaction(() => {
      const projectColumns = new Set((db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>).map((column) => column.name));
      if (!projectColumns.has("version")) db.exec("ALTER TABLE projects ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
      db.exec(`
        CREATE TABLE IF NOT EXISTS outbox_events (
          id TEXT PRIMARY KEY,
          event_type TEXT NOT NULL,
          aggregate_id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          processed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox_events(processed_at, created_at);
        CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);
        CREATE INDEX IF NOT EXISTS idx_blockers_project_status ON blockers(project_id, status);
        CREATE INDEX IF NOT EXISTS idx_approvals_status_created ON approval_requests(status, created_at);
        CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at DESC);
      `);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (2, 'optimistic-locking-and-outbox', ?)").run(new Date().toISOString());
    });
    applyV2();
  }
}

function seed(db: DatabaseConnection): void {
  const userCount = db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
  if (userCount.count === 0) {
    const insertUser = db.prepare("INSERT INTO users (id, name, email, password_hash, role, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)");
    const now = new Date().toISOString();
    insertUser.run("user-admin", "Ana Administradora", "admin@projectbridge.local", passwordHash("admin12345"), "admin", now);
    insertUser.run("user-reviewer", "Rui Revisor", "revisor@projectbridge.local", passwordHash("revisor12345"), "reviewer", now);
    insertUser.run("user-viewer", "Lia Leitora", "leitor@projectbridge.local", passwordHash("leitor12345"), "viewer", now);
  }
  const count = db.prepare("SELECT COUNT(*) AS count FROM projects").get() as { count: number };
  if (count.count > 0) return;

  const insert = db.transaction(() => {
    db.prepare(`
      INSERT INTO projects (id, name, summary, objective, status, owner, progress, target_date, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "atlas",
      "Projeto Atlas",
      "Lançamento de uma nova área de atendimento digital para clientes.",
      "Reduzir o tempo médio de atendimento em 30% sem comprometer a qualidade percebida.",
      "at_risk",
      "Marina Costa",
      62,
      "2026-09-30",
      "2026-08-28T14:30:00.000Z",
    );

    const decisionStatement = db.prepare(`
      INSERT INTO decisions (id, project_id, title, context, decision, status, decided_at)
      VALUES (?, 'atlas', ?, ?, ?, ?, ?)
    `);
    decisionStatement.run("dec-1", "Hospedagem da primeira versão", "A equipe avaliou velocidade de entrega e custo operacional.", "Usar infraestrutura gerenciada durante o MVP e reavaliar após três meses.", "approved", "2026-08-12");
    decisionStatement.run("dec-2", "Fornecedor de autenticação", "A análise de segurança depende do retorno jurídico sobre tratamento de dados.", "Decisão aguardando parecer de privacidade.", "pending", null);
    decisionStatement.run("dec-3", "Métricas do piloto", "Precisávamos evitar uma métrica puramente de volume.", "Medir tempo, resolução no primeiro contato e satisfação do cliente.", "approved", "2026-08-18");

    const taskStatement = db.prepare(`
      INSERT INTO tasks (id, project_id, title, status, priority, due_date, assignee, source, created_at)
      VALUES (?, 'atlas', ?, ?, ?, ?, ?, 'sample', ?)
    `);
    taskStatement.run("task-1", "Validar fluxo com equipe de atendimento", "done", "high", "2026-08-15", "Carla Mendes", "2026-08-04T10:00:00.000Z");
    taskStatement.run("task-2", "Concluir parecer de privacidade", "blocked", "high", "2026-08-25", "Rafael Lima", "2026-08-09T13:10:00.000Z");
    taskStatement.run("task-3", "Preparar roteiro do piloto", "in_progress", "medium", "2026-09-03", "Bianca Alves", "2026-08-17T09:20:00.000Z");
    taskStatement.run("task-4", "Definir painel de métricas", "todo", "medium", "2026-09-08", null, "2026-08-19T16:00:00.000Z");

    const blockerStatement = db.prepare(`
      INSERT INTO blockers (id, project_id, title, impact, owner, status, opened_at)
      VALUES (?, 'atlas', ?, ?, ?, 'open', ?)
    `);
    blockerStatement.run("block-1", "Parecer de privacidade pendente", "Impede a contratação do fornecedor de autenticação.", "Rafael Lima", "2026-08-20");
    blockerStatement.run("block-2", "Ambiente de homologação instável", "Pode atrasar o início do piloto em até quatro dias.", "Diego Rocha", "2026-08-24");

    const documentStatement = db.prepare(`
      INSERT INTO documents (id, project_id, title, kind, summary, updated_at)
      VALUES (?, 'atlas', ?, ?, ?, ?)
    `);
    documentStatement.run("doc-1", "Plano do Projeto Atlas", "planejamento", "Objetivo, escopo, responsáveis e cronograma do lançamento.", "2026-08-21");
    documentStatement.run("doc-2", "Registro de decisões", "decisões", "Resumo das decisões aprovadas e dos itens ainda pendentes.", "2026-08-27");

    db.prepare(`
      INSERT INTO approval_requests
      (id, tool_name, operation, project_id, arguments_json, idempotency_key, justification, requested_by, status, created_at)
      VALUES (?, 'propose_task', 'create_task', 'atlas', ?, ?, ?, ?, 'pending', ?)
    `).run(
      "approval-demo",
      JSON.stringify({ title: "Revisar checklist do piloto", priority: "high", due_date: "2026-09-02" }),
      "atlas-demo-review-checklist",
      "Os dois bloqueios podem afetar o início do piloto e precisam de acompanhamento conjunto.",
      "assistente-planejamento",
      "2026-08-28T15:20:00.000Z",
    );

    const auditStatement = db.prepare(`
      INSERT INTO audit_events
      (id, request_id, client_name, action, target_type, target_id, status, duration_ms, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    auditStatement.run("audit-1", "req-demo-1", "assistente-planejamento", "get_project_context", "project", "atlas", "success", 18.4, JSON.stringify({ transport: "mcp", scope: "projects:read" }), "2026-08-28T15:18:00.000Z");
    auditStatement.run("audit-2", "approval-demo", "assistente-planejamento", "propose_task", "approval", "approval-demo", "pending_approval", 7.1, JSON.stringify({ transport: "mcp", scope: "tasks:propose" }), "2026-08-28T15:20:00.000Z");
  });

  insert();
}
