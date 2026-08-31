import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { Request, Response, NextFunction } from "express";
import * as z from "zod/v4";
import { createDatabase, type DatabaseConnection } from "./database.js";
import { createMcpFactory } from "./mcp.js";
import { DomainError, ProjectRepository } from "./repository.js";
import { AuthenticationError, HttpAuthenticator } from "./auth.js";

const DecisionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  note: z.string().min(3).max(500),
});

const ProjectFieldsSchema = z.object({
  name: z.string().trim().min(3).max(100),
  summary: z.string().trim().min(10).max(280),
  objective: z.string().trim().min(10).max(600),
  status: z.enum(["active", "at_risk", "completed"]),
  owner: z.string().trim().min(2).max(100),
  progress: z.number().int().min(0).max(100),
  target_date: z.iso.date(),
});

const ProjectUpdateSchema = ProjectFieldsSchema.partial().refine(
  (input) => Object.keys(input).length > 0,
  { message: "Informe ao menos um campo para atualizar." },
);

export function createApp(database?: DatabaseConnection, authenticator = new HttpAuthenticator()) {
  const db = database ?? createDatabase();
  const repository = new ProjectRepository(db);
  const app = createMcpExpressApp({ host: "127.0.0.1" });
  const mcpHandler = createMcpHandler(createMcpFactory(repository, authenticator), {
    onerror: (error) => console.error("[MCP]", error.message),
  });
  const nodeMcpHandler = toNodeHandler(mcpHandler, {
    onerror: (error) => console.error("[MCP adapter]", error.message),
  });

  app.get("/api/health", (_request, response) => {
    response.json({ status: "ok", service: "project-bridge", mcp_sdk: "2.0.0" });
  });

  app.get("/api/overview", (_request, response) => response.json(repository.overview()));
  app.get("/api/projects", (_request, response) => response.json(repository.listProjects()));
  app.post("/api/projects", (request, response, next) => {
    try {
      const project = repository.createProject(ProjectFieldsSchema.parse(request.body));
      mcpHandler.notify.resourceUpdated("project-bridge://projects");
      mcpHandler.notify.resourceUpdated(`project-bridge://projects/${project.id}`);
      response.status(201).json(project);
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/projects/:projectId", (request, response) => {
    const project = repository.getProject(request.params.projectId);
    if (!project) return response.status(404).json({ code: "PROJECT_NOT_FOUND", message: "Projeto não encontrado." });
    return response.json(project);
  });
  app.patch("/api/projects/:projectId", (request, response, next) => {
    try {
      const project = repository.updateProject(request.params.projectId, ProjectUpdateSchema.parse(request.body));
      mcpHandler.notify.resourceUpdated("project-bridge://projects");
      mcpHandler.notify.resourceUpdated(`project-bridge://projects/${project.id}`);
      response.json(project);
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/approvals", (_request, response) => response.json(repository.listApprovals()));
  app.post("/api/approvals/:approvalId/decision", (request, response, next) => {
    try {
      const input = DecisionSchema.parse(request.body);
      const current = repository.getApproval(request.params.approvalId);
      const approval = repository.decideApproval(request.params.approvalId, input.decision, input.note);

      if (current?.status === "pending" && input.decision === "approved") {
        mcpHandler.notify.resourceUpdated(`project-bridge://projects/${approval.project_id}`);
      }

      response.json(approval);
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/audit", (_request, response) => response.json(repository.listAudit()));
  app.get("/api/mcp/info", (_request, response) => response.json({
    name: "project-bridge",
    version: "0.6.0",
    transport: "Streamable HTTP",
    http_authentication: "Bearer token",
    authenticated_clients: authenticator.configuredClients,
    endpoint: "http://127.0.0.1:8010/mcp",
    default_scopes: ["projects:read", "approvals:read"],
    mutation_scope: "tasks:propose",
    mutation_scopes: ["tasks:propose", "tasks:update:propose", "blockers:resolve:propose"],
    resources: ["project-bridge://projects", "project-bridge://projects/{projectId}"],
    notifications: ["notifications/resources/updated"],
    tools: [
      "list_projects",
      "get_project_context",
      "list_project_blockers",
      "propose_task",
      "propose_task_update",
      "propose_blocker_resolution",
      "get_approval_status",
    ],
    prompts: ["project-status-review"],
  }));

  app.all("/mcp", (request, response, next) => {
    try {
      authenticator.authenticate(request.get("authorization"));
      next();
    } catch (error) {
      if (error instanceof AuthenticationError) {
        response.set("WWW-Authenticate", 'Bearer realm="project-bridge"');
        return response.status(401).json({ code: error.code, message: error.message });
      }
      return next(error);
    }
  });
  app.all("/mcp", (request, response) => {
    void nodeMcpHandler(request, response, request.body);
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) {
      return response.status(400).json({ code: "INVALID_INPUT", message: "Revise os campos enviados.", issues: error.issues });
    }
    if (error instanceof DomainError) {
      return response.status(404).json({ code: error.code, message: error.message });
    }
    console.error(error);
    return response.status(500).json({ code: "INTERNAL_ERROR", message: "Não foi possível concluir a operação." });
  });

  return { app, db, repository, mcpHandler, close: () => mcpHandler.close() };
}
