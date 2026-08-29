export type ProjectStatus = "active" | "at_risk" | "completed";
export type TaskStatus = "todo" | "in_progress" | "blocked" | "done";
export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface Project {
  id: string;
  name: string;
  summary: string;
  objective: string;
  status: ProjectStatus;
  owner: string;
  progress: number;
  target_date: string;
  updated_at: string;
}

export interface Task {
  id: string;
  project_id: string;
  title: string;
  status: TaskStatus;
  priority: "low" | "medium" | "high";
  due_date: string | null;
  assignee: string | null;
  source: "sample" | "user" | "mcp";
  created_at: string;
}

export interface ApprovalRequest {
  id: string;
  tool_name: string;
  operation: string;
  project_id: string;
  arguments: Record<string, unknown>;
  idempotency_key: string;
  justification: string;
  requested_by: string;
  status: ApprovalStatus;
  created_at: string;
  decided_at: string | null;
  decision_note: string | null;
  result: Record<string, unknown> | null;
}

export interface ClientContext {
  clientName: string;
  scopes: Set<string>;
  transport: "http" | "stdio" | "test";
}
