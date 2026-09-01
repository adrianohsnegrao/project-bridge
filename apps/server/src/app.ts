import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { Request, Response, NextFunction } from "express";
import * as z from "zod/v4";
import { createDatabase, type DatabaseConnection } from "./database.js";
import { createMcpFactory } from "./mcp.js";
import { DomainError, ProjectRepository } from "./repository.js";
import { AuthenticationError, HttpAuthenticator } from "./auth.js";
import { sessionToken, WebAuth, type Permission, type WebUser } from "./web-auth.js";

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

const ProjectUpdateSchema = ProjectFieldsSchema.partial().extend({ expected_version: z.number().int().positive() }).refine(
  (input) => Object.keys(input).some((key) => key !== "expected_version"),
  { message: "Informe ao menos um campo para atualizar." },
);
const LoginSchema = z.object({ email: z.email(), password: z.string().min(8).max(200) });

export function createApp(
  database?: DatabaseConnection,
  authenticator = new HttpAuthenticator(),
  options: { requireWebAuth?: boolean } = {},
) {
  const db = database ?? createDatabase();
  const repository = new ProjectRepository(db);
  const webAuth = new WebAuth(db);
  const app = createMcpExpressApp({ host: "127.0.0.1" });
  const mcpHandler = createMcpHandler(createMcpFactory(repository, authenticator), {
    onerror: (error) => console.error("[MCP]", error.message),
  });
  const nodeMcpHandler = toNodeHandler(mcpHandler, {
    onerror: (error) => console.error("[MCP adapter]", error.message),
  });
  const flushOutbox = () => repository.drainOutbox((uri) => mcpHandler.notify.resourceUpdated(uri));
  const outboxTimer = process.env.NODE_ENV === "test" ? undefined : setInterval(flushOutbox, 1000);
  outboxTimer?.unref();
  flushOutbox();

  app.get("/api/health", (_request, response) => {
    response.json({ status: "ok", service: "project-bridge", mcp_sdk: "2.0.0" });
  });

  app.post("/api/auth/login", (request, response, next) => {
    try {
      const input = LoginSchema.parse(request.body);
      const result = webAuth.login(input.email, input.password);
      if (!result) return response.status(401).json({ code: "INVALID_CREDENTIALS", message: "E-mail ou senha inválidos." });
      response.set("Set-Cookie", `pb_session=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
      return response.json(result.user);
    } catch (error) { return next(error); }
  });
  app.post("/api/auth/logout", (request, response) => {
    webAuth.logout(sessionToken(request.get("cookie")));
    response.set("Set-Cookie", "pb_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
    response.status(204).end();
  });

  const requireUser = (request: Request, response: Response, next: NextFunction) => {
    if (options.requireWebAuth === false || (options.requireWebAuth === undefined && process.env.NODE_ENV === "test")) {
      response.locals.user = { id: "test-user", name: "Interface humana", email: "interface-humana", role: "admin", permissions: ["projects:read", "projects:write", "approvals:decide", "audit:read"] } satisfies WebUser;
      return next();
    }
    const user = webAuth.authenticate(sessionToken(request.get("cookie")));
    if (!user) return response.status(401).json({ code: "AUTH_REQUIRED", message: "Entre para acessar a Central de Projetos." });
    response.locals.user = user;
    return next();
  };
  const requirePermission = (permission: Permission) => (_request: Request, response: Response, next: NextFunction) => {
    const user = response.locals.user as WebUser;
    if (!webAuth.has(user, permission)) return response.status(403).json({ code: "PERMISSION_DENIED", message: "Seu perfil não permite esta operação." });
    return next();
  };
  app.get("/api/auth/me", requireUser, (_request, response) => response.json(response.locals.user));
  app.use("/api", requireUser);

  app.get("/api/overview", (_request, response) => response.json(repository.overview()));
  app.get("/api/projects", (_request, response) => response.json(repository.listProjects()));
  app.post("/api/projects", requirePermission("projects:write"), (request, response, next) => {
    try {
      const project = repository.createProject(ProjectFieldsSchema.parse(request.body), (response.locals.user as WebUser).email);
      flushOutbox();
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
  app.patch("/api/projects/:projectId", requirePermission("projects:write"), (request, response, next) => {
    try {
      const projectId = String(request.params.projectId);
      const { expected_version, ...changes } = ProjectUpdateSchema.parse(request.body);
      const project = repository.updateProject(projectId, changes, expected_version, (response.locals.user as WebUser).email);
      flushOutbox();
      response.json(project);
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/approvals", (_request, response) => response.json(repository.listApprovals()));
  app.post("/api/approvals/:approvalId/decision", requirePermission("approvals:decide"), (request, response, next) => {
    try {
      const input = DecisionSchema.parse(request.body);
      const approvalId = String(request.params.approvalId);
      const current = repository.getApproval(approvalId);
      const approval = repository.decideApproval(approvalId, input.decision, input.note, (response.locals.user as WebUser).email);

      if (current?.status === "pending" && input.decision === "approved") flushOutbox();

      response.json(approval);
    } catch (error) {
      next(error);
    }
  });
  app.get("/api/audit", requirePermission("audit:read"), (_request, response) => response.json(repository.listAudit()));
  app.get("/api/mcp/info", requirePermission("audit:read"), (_request, response) => response.json({
    name: "project-bridge",
    version: "0.8.0",
    transport: "Streamable HTTP",
    http_authentication: "Bearer token",
    authenticated_clients: authenticator.configuredClients,
    persistence: { engine: "SQLite", journal_mode: "WAL", optimistic_locking: true, transactional_outbox: true },
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
      return response.status(error.status).json({ code: error.code, message: error.message });
    }
    console.error(error);
    return response.status(500).json({ code: "INTERNAL_ERROR", message: "Não foi possível concluir a operação." });
  });

  return { app, db, repository, mcpHandler, close: async () => { if (outboxTimer) clearInterval(outboxTimer); await mcpHandler.close(); } };
}
