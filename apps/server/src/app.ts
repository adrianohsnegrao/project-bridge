import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { Request, Response, NextFunction } from "express";
import * as z from "zod/v4";
import { createDatabase, type DatabaseConnection } from "./database.js";
import { createMcpFactory } from "./mcp.js";
import { DomainError, ProjectRepository } from "./repository.js";

const DecisionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  note: z.string().min(3).max(500),
});

export function createApp(database?: DatabaseConnection) {
  const db = database ?? createDatabase();
  const repository = new ProjectRepository(db);
  const app = createMcpExpressApp({ host: "127.0.0.1" });
  const mcpHandler = createMcpHandler(createMcpFactory(repository), {
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
  app.get("/api/projects/:projectId", (request, response) => {
    const project = repository.getProject(request.params.projectId);
    if (!project) return response.status(404).json({ code: "PROJECT_NOT_FOUND", message: "Projeto não encontrado." });
    return response.json(project);
  });
  app.get("/api/approvals", (_request, response) => response.json(repository.listApprovals()));
  app.post("/api/approvals/:approvalId/decision", (request, response, next) => {
    try {
      const input = DecisionSchema.parse(request.body);
      response.json(repository.decideApproval(request.params.approvalId, input.decision, input.note));
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/audit", (_request, response) => response.json(repository.listAudit()));
  app.get("/api/mcp/info", (_request, response) => response.json({
    name: "project-bridge",
    version: "0.1.0",
    transport: "Streamable HTTP",
    endpoint: "http://127.0.0.1:8010/mcp",
    default_scopes: ["projects:read", "approvals:read"],
    mutation_scope: "tasks:propose",
    resources: ["project-bridge://projects", "project-bridge://projects/{projectId}"],
    tools: ["list_projects", "get_project_context", "list_project_blockers", "propose_task", "get_approval_status"],
    prompts: ["project-status-review"],
  }));

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

  return { app, db, repository, close: () => mcpHandler.close() };
}
