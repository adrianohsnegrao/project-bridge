import { randomUUID } from "node:crypto";
import type { DatabaseConnection } from "./database.js";
import type { ApprovalRequest, Blocker, ClientContext, Project, Task } from "./types.js";

function parseApproval(row: Record<string, unknown>): ApprovalRequest {
  return {
    id: String(row.id),
    tool_name: String(row.tool_name),
    operation: String(row.operation),
    project_id: String(row.project_id),
    arguments: JSON.parse(String(row.arguments_json)),
    idempotency_key: String(row.idempotency_key),
    justification: String(row.justification),
    requested_by: String(row.requested_by),
    status: row.status as ApprovalRequest["status"],
    created_at: String(row.created_at),
    decided_at: row.decided_at ? String(row.decided_at) : null,
    decision_note: row.decision_note ? String(row.decision_note) : null,
    result: row.result_json ? JSON.parse(String(row.result_json)) : null,
  };
}

export class ProjectRepository {
  constructor(private readonly db: DatabaseConnection) {}

  overview() {
    const projectCounts = this.db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN status = 'at_risk' THEN 1 ELSE 0 END) AS at_risk
      FROM projects
    `).get() as { total: number; at_risk: number };
    const pending = this.db.prepare("SELECT COUNT(*) AS count FROM approval_requests WHERE status = 'pending'").get() as { count: number };
    const blockers = this.db.prepare("SELECT COUNT(*) AS count FROM blockers WHERE status = 'open'").get() as { count: number };
    const recentAudit = this.db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as { count: number };
    return {
      projects: projectCounts.total,
      projects_at_risk: projectCounts.at_risk ?? 0,
      pending_approvals: pending.count,
      open_blockers: blockers.count,
      audited_operations: recentAudit.count,
      mcp_endpoint: "http://127.0.0.1:8010/mcp",
    };
  }

  listProjects(): Project[] {
    return this.db.prepare("SELECT * FROM projects ORDER BY updated_at DESC").all() as Project[];
  }

  getProject(projectId: string) {
    const project = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as Project | undefined;
    if (!project) return null;
    return {
      ...project,
      decisions: this.db.prepare("SELECT * FROM decisions WHERE project_id = ? ORDER BY decided_at DESC, id").all(projectId),
      tasks: this.db.prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY CASE status WHEN 'blocked' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'todo' THEN 2 ELSE 3 END, due_date").all(projectId),
      blockers: this.db.prepare("SELECT * FROM blockers WHERE project_id = ? ORDER BY opened_at DESC").all(projectId),
      documents: this.db.prepare("SELECT * FROM documents WHERE project_id = ? ORDER BY updated_at DESC").all(projectId),
    };
  }

  createProject(input: Omit<Project, "id" | "updated_at">): Project {
    const now = new Date().toISOString();
    const baseId = input.name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 42) || "projeto";
    let id = baseId;
    let suffix = 2;
    while (this.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(id)) {
      id = `${baseId}-${suffix++}`;
    }

    const project: Project = { id, ...input, updated_at: now };
    const create = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO projects (id, name, summary, objective, status, owner, progress, target_date, updated_at)
        VALUES (@id, @name, @summary, @objective, @status, @owner, @progress, @target_date, @updated_at)
      `).run(project);
      this.insertAudit({
        requestId: randomUUID(),
        clientName: "interface-humana",
        action: "create_project",
        targetType: "project",
        targetId: id,
        status: "success",
        durationMs: 0,
        details: { source: "web", changed_fields: Object.keys(input) },
      });
    });
    create();
    return project;
  }

  updateProject(projectId: string, input: Partial<Omit<Project, "id" | "updated_at">>): Project {
    const current = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as Project | undefined;
    if (!current) throw new DomainError("PROJECT_NOT_FOUND", "Projeto não encontrado.");
    const updated: Project = { ...current, ...input, updated_at: new Date().toISOString() };
    const update = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE projects
        SET name = @name, summary = @summary, objective = @objective, status = @status,
            owner = @owner, progress = @progress, target_date = @target_date, updated_at = @updated_at
        WHERE id = @id
      `).run(updated);
      this.insertAudit({
        requestId: randomUUID(),
        clientName: "interface-humana",
        action: "update_project",
        targetType: "project",
        targetId: projectId,
        status: "success",
        durationMs: 0,
        details: { source: "web", changed_fields: Object.keys(input) },
      });
    });
    update();
    return updated;
  }

  listBlockers(projectId: string) {
    return this.db.prepare("SELECT * FROM blockers WHERE project_id = ? AND status = 'open' ORDER BY opened_at DESC").all(projectId);
  }

  getTask(projectId: string, taskId: string): Task | null {
    return (this.db.prepare("SELECT * FROM tasks WHERE id = ? AND project_id = ?").get(taskId, projectId) as Task | undefined) ?? null;
  }

  getBlocker(projectId: string, blockerId: string): Blocker | null {
    return (this.db.prepare("SELECT * FROM blockers WHERE id = ? AND project_id = ?").get(blockerId, projectId) as Blocker | undefined) ?? null;
  }

  listApprovals(): ApprovalRequest[] {
    return (this.db.prepare("SELECT * FROM approval_requests ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC").all() as Record<string, unknown>[]).map(parseApproval);
  }

  getApproval(id: string): ApprovalRequest | null {
    const row = this.db.prepare("SELECT * FROM approval_requests WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? parseApproval(row) : null;
  }

  proposeTask(input: {
    projectId: string;
    title: string;
    priority: "low" | "medium" | "high";
    dueDate?: string;
    assignee?: string;
    justification: string;
    idempotencyKey: string;
  }, client: ClientContext): { approval: ApprovalRequest; reused: boolean } {
    if (!this.getProject(input.projectId)) throw new DomainError("PROJECT_NOT_FOUND", "Projeto não encontrado.");
    return this.createApproval({
      toolName: "propose_task",
      operation: "create_task",
      projectId: input.projectId,
      arguments: {
        title: input.title,
        priority: input.priority,
        due_date: input.dueDate ?? null,
        assignee: input.assignee ?? null,
      },
      idempotencyKey: input.idempotencyKey,
      justification: input.justification,
      scope: "tasks:propose",
    }, client);
  }

  proposeTaskUpdate(input: {
    projectId: string;
    taskId: string;
    status?: Task["status"];
    priority?: Task["priority"];
    dueDate?: string | null;
    assignee?: string | null;
    justification: string;
    idempotencyKey: string;
  }, client: ClientContext): { approval: ApprovalRequest; reused: boolean } {
    const task = this.getTask(input.projectId, input.taskId);
    if (!task) throw new DomainError("TASK_NOT_FOUND", "Tarefa não encontrada neste projeto.");
    return this.createApproval({
      toolName: "propose_task_update",
      operation: "update_task",
      projectId: input.projectId,
      arguments: {
        task_id: input.taskId,
        title: task.title,
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.dueDate !== undefined ? { due_date: input.dueDate } : {}),
        ...(input.assignee !== undefined ? { assignee: input.assignee } : {}),
      },
      idempotencyKey: input.idempotencyKey,
      justification: input.justification,
      scope: "tasks:update:propose",
    }, client);
  }

  proposeBlockerResolution(input: {
    projectId: string;
    blockerId: string;
    resolutionNote: string;
    justification: string;
    idempotencyKey: string;
  }, client: ClientContext): { approval: ApprovalRequest; reused: boolean } {
    const blocker = this.getBlocker(input.projectId, input.blockerId);
    if (!blocker) throw new DomainError("BLOCKER_NOT_FOUND", "Impedimento não encontrado neste projeto.");
    if (blocker.status === "resolved") throw new DomainError("BLOCKER_ALREADY_RESOLVED", "O impedimento já foi resolvido.");
    return this.createApproval({
      toolName: "propose_blocker_resolution",
      operation: "resolve_blocker",
      projectId: input.projectId,
      arguments: {
        blocker_id: input.blockerId,
        title: blocker.title,
        resolution_note: input.resolutionNote,
      },
      idempotencyKey: input.idempotencyKey,
      justification: input.justification,
      scope: "blockers:resolve:propose",
    }, client);
  }

  decideApproval(id: string, decision: "approved" | "rejected", note: string): ApprovalRequest {
    const current = this.getApproval(id);
    if (!current) throw new DomainError("APPROVAL_NOT_FOUND", "Solicitação de aprovação não encontrada.");
    if (current.status !== "pending") return current;

    const now = new Date().toISOString();
    const result = this.db.transaction(() => {
      let operationResult: Record<string, unknown> = { decision };
      if (decision === "approved" && current.operation === "create_task") {
        const args = current.arguments as { title: string; priority: Task["priority"]; due_date?: string | null; assignee?: string | null };
        const task: Task = {
          id: `task-from-${current.id}`,
          project_id: current.project_id,
          title: args.title,
          status: "todo",
          priority: args.priority,
          due_date: args.due_date ?? null,
          assignee: args.assignee ?? null,
          source: "mcp",
          created_at: now,
        };
        this.db.prepare(`
          INSERT OR IGNORE INTO tasks
          (id, project_id, title, status, priority, due_date, assignee, source, created_at)
          VALUES (@id, @project_id, @title, @status, @priority, @due_date, @assignee, @source, @created_at)
        `).run(task);
        operationResult = { decision, task };
      } else if (decision === "approved" && current.operation === "update_task") {
        const args = current.arguments as {
          task_id: string;
          status?: Task["status"];
          priority?: Task["priority"];
          due_date?: string | null;
          assignee?: string | null;
        };
        const task = this.getTask(current.project_id, args.task_id);
        if (!task) throw new DomainError("TASK_NOT_FOUND", "Tarefa não encontrada neste projeto.");
        const updatedTask: Task = {
          ...task,
          ...(args.status !== undefined ? { status: args.status } : {}),
          ...(args.priority !== undefined ? { priority: args.priority } : {}),
          ...(args.due_date !== undefined ? { due_date: args.due_date } : {}),
          ...(args.assignee !== undefined ? { assignee: args.assignee } : {}),
        };
        this.db.prepare(`
          UPDATE tasks
          SET status = @status, priority = @priority, due_date = @due_date, assignee = @assignee
          WHERE id = @id AND project_id = @project_id
        `).run(updatedTask);
        operationResult = { decision, task: updatedTask };
      } else if (decision === "approved" && current.operation === "resolve_blocker") {
        const args = current.arguments as { blocker_id: string; resolution_note: string };
        const blocker = this.getBlocker(current.project_id, args.blocker_id);
        if (!blocker) throw new DomainError("BLOCKER_NOT_FOUND", "Impedimento não encontrado neste projeto.");
        this.db.prepare(`
          UPDATE blockers
          SET status = 'resolved', resolved_at = ?, resolution_note = ?
          WHERE id = ? AND project_id = ?
        `).run(now, args.resolution_note, args.blocker_id, current.project_id);
        operationResult = { decision, blocker: this.getBlocker(current.project_id, args.blocker_id) };
      }

      if (decision === "approved") {
        this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now, current.project_id);
      }

      this.db.prepare(`
        UPDATE approval_requests
        SET status = ?, decided_at = ?, decision_note = ?, result_json = ?
        WHERE id = ?
      `).run(decision, now, note, JSON.stringify(operationResult), id);

      this.insertAudit({
        requestId: id,
        clientName: "revisor-humano",
        action: "decide_approval",
        targetType: "approval",
        targetId: id,
        status: decision,
        durationMs: 0,
        details: { note, original_client: current.requested_by },
      });
    });
    result();
    return this.getApproval(id)!;
  }

  private createApproval(input: {
    toolName: string;
    operation: string;
    projectId: string;
    arguments: Record<string, unknown>;
    idempotencyKey: string;
    justification: string;
    scope: string;
  }, client: ClientContext): { approval: ApprovalRequest; reused: boolean } {
    const existing = this.db.prepare("SELECT * FROM approval_requests WHERE idempotency_key = ?").get(input.idempotencyKey) as Record<string, unknown> | undefined;
    if (existing) return { approval: parseApproval(existing), reused: true };

    const started = performance.now();
    const id = `approval-${randomUUID()}`;
    const now = new Date().toISOString();
    const create = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO approval_requests
        (id, tool_name, operation, project_id, arguments_json, idempotency_key, justification, requested_by, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(
        id,
        input.toolName,
        input.operation,
        input.projectId,
        JSON.stringify(input.arguments),
        input.idempotencyKey,
        input.justification,
        client.clientName,
        now,
      );

      this.insertAudit({
        requestId: id,
        clientName: client.clientName,
        action: input.toolName,
        targetType: "approval",
        targetId: id,
        status: "pending_approval",
        durationMs: performance.now() - started,
        details: { transport: client.transport, scope: input.scope, idempotency_key: input.idempotencyKey },
      });
    });
    create();
    return { approval: this.getApproval(id)!, reused: false };
  }

  listAudit(limit = 30) {
    return (this.db.prepare("SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?").all(limit) as Record<string, unknown>[]).map((row) => ({
      ...row,
      details: JSON.parse(String(row.details_json)),
      details_json: undefined,
    }));
  }

  recordRead(client: ClientContext, action: string, targetType: string, targetId: string | null, durationMs: number): void {
    this.insertAudit({
      requestId: randomUUID(),
      clientName: client.clientName,
      action,
      targetType,
      targetId,
      status: "success",
      durationMs,
      details: { transport: client.transport, scope: "projects:read" },
    });
  }

  private insertAudit(input: {
    requestId: string;
    clientName: string;
    action: string;
    targetType: string;
    targetId: string | null;
    status: string;
    durationMs: number;
    details: Record<string, unknown>;
  }): void {
    this.db.prepare(`
      INSERT INTO audit_events
      (id, request_id, client_name, action, target_type, target_id, status, duration_ms, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `audit-${randomUUID()}`,
      input.requestId,
      input.clientName,
      input.action,
      input.targetType,
      input.targetId,
      input.status,
      Number(input.durationMs.toFixed(2)),
      JSON.stringify(input.details),
      new Date().toISOString(),
    );
  }
}

export class DomainError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}
