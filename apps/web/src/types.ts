export type Page = "overview" | "projects" | "approvals" | "activity";

export interface Overview {
  projects: number;
  projects_at_risk: number;
  pending_approvals: number;
  open_blockers: number;
  audited_operations: number;
  mcp_endpoint: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  summary: string;
  objective: string;
  status: "active" | "at_risk" | "completed";
  owner: string;
  progress: number;
  target_date: string;
  updated_at: string;
}

export type ProjectInput = Omit<ProjectSummary, "id" | "updated_at">;

export interface Project extends ProjectSummary {
  decisions: Array<{
    id: string;
    title: string;
    context: string;
    decision: string;
    status: "approved" | "pending";
    decided_at: string | null;
  }>;
  tasks: Array<{
    id: string;
    title: string;
    status: "todo" | "in_progress" | "blocked" | "done";
    priority: "low" | "medium" | "high";
    due_date: string | null;
    assignee: string | null;
    source: "sample" | "user" | "mcp";
  }>;
  blockers: Array<{
    id: string;
    title: string;
    impact: string;
    owner: string | null;
    status: string;
    opened_at: string;
    resolved_at: string | null;
    resolution_note: string | null;
  }>;
  documents: Array<{
    id: string;
    title: string;
    kind: string;
    summary: string;
    updated_at: string;
  }>;
}

export interface Approval {
  id: string;
  tool_name: string;
  operation: string;
  project_id: string;
  arguments: {
    title?: string;
    task_id?: string;
    blocker_id?: string;
    status?: string;
    priority?: string;
    due_date?: string | null;
    assignee?: string | null;
    resolution_note?: string;
  };
  idempotency_key: string;
  justification: string;
  requested_by: string;
  status: "pending" | "approved" | "rejected";
  created_at: string;
  decided_at: string | null;
  decision_note: string | null;
  result: Record<string, unknown> | null;
}

export interface AuditEvent {
  id: string;
  request_id: string;
  client_name: string;
  action: string;
  target_type: string;
  target_id: string | null;
  status: string;
  duration_ms: number;
  details: Record<string, unknown>;
  created_at: string;
}

export interface McpInfo {
  name: string;
  version: string;
  transport: string;
  endpoint: string;
  default_scopes: string[];
  mutation_scope: string;
  mutation_scopes: string[];
  notifications: string[];
  resources: string[];
  tools: string[];
  prompts: string[];
}
