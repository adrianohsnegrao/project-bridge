import type { Approval, AuditEvent, McpInfo, Overview, Project, ProjectInput, ProjectSummary } from "./types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: "O serviço local não respondeu como esperado." }));
    throw new Error(error.message ?? "Não foi possível concluir a operação.");
  }
  return response.json() as Promise<T>;
}

export const api = {
  overview: () => request<Overview>("/overview"),
  projects: () => request<ProjectSummary[]>("/projects"),
  project: (id: string) => request<Project>(`/projects/${id}`),
  createProject: (input: ProjectInput) => request<ProjectSummary>("/projects", {
    method: "POST",
    body: JSON.stringify(input),
  }),
  updateProject: (id: string, input: ProjectInput) => request<ProjectSummary>(`/projects/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  }),
  approvals: () => request<Approval[]>("/approvals"),
  audit: () => request<AuditEvent[]>("/audit"),
  mcpInfo: () => request<McpInfo>("/mcp/info"),
  decideApproval: (id: string, decision: "approved" | "rejected", note: string) =>
    request<Approval>(`/approvals/${id}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision, note }),
    }),
};
