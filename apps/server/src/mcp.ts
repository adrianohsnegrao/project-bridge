import {
  McpServer,
  ResourceTemplate,
  type McpRequestContext,
  type McpServerFactory,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { ProjectRepository } from "./repository.js";
import { DomainError } from "./repository.js";
import type { ClientContext } from "./types.js";
import { HttpAuthenticator } from "./auth.js";

const ErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

const ToolEnvelopeSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: ErrorSchema.optional(),
});

type ToolEnvelope = z.infer<typeof ToolEnvelopeSchema>;

function toolResult(envelope: ToolEnvelope, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
    structuredContent: envelope,
    isError,
  };
}

function requireScope(context: ClientContext, scope: string): void {
  if (!context.scopes.has(scope)) {
    throw new DomainError(
      "SCOPE_REQUIRED",
      `O cliente '${context.clientName}' não possui o escopo obrigatório '${scope}'.`,
    );
  }
}

function handleToolError(error: unknown) {
  const domainError = error instanceof DomainError
    ? error
    : new DomainError("INTERNAL_ERROR", "Não foi possível concluir a operação.");
  return toolResult({ ok: false, error: { code: domainError.code, message: domainError.message } }, true);
}

export function resolveHttpClientContext(context: McpRequestContext, authenticator: HttpAuthenticator): ClientContext {
  return authenticator.authenticate(context.requestInfo?.headers.get("authorization") ?? undefined);
}

export function resolveStdioClientContext(): ClientContext {
  const scopes = (process.env.PROJECT_BRIDGE_SCOPES ?? "projects:read,approvals:read")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  return {
    clientName: process.env.PROJECT_BRIDGE_CLIENT_NAME ?? "cliente-stdio-local",
    scopes: new Set(scopes),
    transport: "stdio",
  };
}

export function buildMcpServer(repository: ProjectRepository, client: ClientContext): McpServer {
  const server = new McpServer(
    { name: "project-bridge", version: "0.9.0" },
    {
      instructions:
        "Consulte o contexto dos projetos antes de propor ações. Ferramentas de proposta nunca executam a mutação diretamente: elas criam uma solicitação para revisão humana.",
      capabilities: {
        resources: { subscribe: true, listChanged: true },
      },
    },
  );

  server.registerResource(
    "project-catalog",
    "project-bridge://projects",
    {
      title: "Catálogo de projetos",
      description: "Lista resumida dos projetos disponíveis na Central de Projetos.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(repository.listProjects(), null, 2) }],
    }),
  );

  const projectTemplate = new ResourceTemplate("project-bridge://projects/{projectId}", {
    list: async () => ({
      resources: repository.listProjects().map((project) => ({
        uri: `project-bridge://projects/${project.id}`,
        name: project.name,
        description: project.summary,
        mimeType: "application/json",
      })),
    }),
    complete: {
      projectId: (value) => repository.listProjects().map((project) => project.id).filter((id) => id.startsWith(value)),
    },
  });

  server.registerResource(
    "project-context",
    projectTemplate,
    {
      title: "Contexto completo do projeto",
      description: "Objetivo, decisões, tarefas, impedimentos e documentos do projeto.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const project = repository.getProject(String(variables.projectId));
      if (!project) throw new DomainError("PROJECT_NOT_FOUND", "Projeto não encontrado.");
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(project, null, 2) }],
      };
    },
  );

  server.registerTool(
    "list_projects",
    {
      title: "Listar projetos",
      description: "Lista os projetos disponíveis com estado, responsável, progresso e data alvo.",
      inputSchema: z.object({}),
      outputSchema: ToolEnvelopeSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        requireScope(client, "projects:read");
        const started = performance.now();
        const projects = repository.listProjects();
        repository.recordRead(client, "list_projects", "project_collection", null, performance.now() - started);
        return toolResult({ ok: true, data: { projects } });
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  server.registerTool(
    "get_project_context",
    {
      title: "Consultar contexto do projeto",
      description: "Retorna contexto estruturado do projeto: objetivo, decisões, tarefas, impedimentos e documentos.",
      inputSchema: z.object({ project_id: z.string().min(1).describe("Identificador do projeto") }),
      outputSchema: ToolEnvelopeSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project_id }) => {
      try {
        requireScope(client, "projects:read");
        const started = performance.now();
        const project = repository.getProject(project_id);
        if (!project) throw new DomainError("PROJECT_NOT_FOUND", "Projeto não encontrado.");
        repository.recordRead(client, "get_project_context", "project", project_id, performance.now() - started);
        return toolResult({ ok: true, data: { project } });
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  server.registerTool(
    "list_project_blockers",
    {
      title: "Listar impedimentos",
      description: "Lista somente os impedimentos abertos de um projeto.",
      inputSchema: z.object({ project_id: z.string().min(1) }),
      outputSchema: ToolEnvelopeSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project_id }) => {
      try {
        requireScope(client, "projects:read");
        const started = performance.now();
        if (!repository.getProject(project_id)) throw new DomainError("PROJECT_NOT_FOUND", "Projeto não encontrado.");
        const blockers = repository.listBlockers(project_id);
        repository.recordRead(client, "list_project_blockers", "project", project_id, performance.now() - started);
        return toolResult({ ok: true, data: { project_id, blockers } });
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  server.registerTool(
    "propose_task",
    {
      title: "Propor criação de tarefa",
      description: "Cria uma solicitação pendente de aprovação humana. Nunca cria a tarefa diretamente.",
      inputSchema: z.object({
        project_id: z.string().min(1),
        title: z.string().min(5).max(120),
        priority: z.enum(["low", "medium", "high"]),
        due_date: z.iso.date().optional(),
        assignee: z.string().min(2).max(80).optional(),
        justification: z.string().min(15).max(500),
        idempotency_key: z.string().min(8).max(120),
      }),
      outputSchema: ToolEnvelopeSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        requireScope(client, "tasks:propose");
        const result = repository.proposeTask({
          projectId: args.project_id,
          title: args.title,
          priority: args.priority,
          dueDate: args.due_date,
          assignee: args.assignee,
          justification: args.justification,
          idempotencyKey: args.idempotency_key,
        }, client);
        return toolResult({
          ok: true,
          data: {
            approval: result.approval,
            reused: result.reused,
            message: result.reused
              ? "A mesma chave idempotente já havia criado esta solicitação."
              : "Solicitação criada. A tarefa só existirá após aprovação humana.",
          },
        });
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  server.registerTool(
    "get_approval_status",
    {
      title: "Consultar aprovação",
      description: "Consulta o estado e o resultado de uma solicitação de aprovação.",
      inputSchema: z.object({ approval_id: z.string().min(1) }),
      outputSchema: ToolEnvelopeSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ approval_id }) => {
      try {
        requireScope(client, "approvals:read");
        const approval = repository.getApproval(approval_id);
        if (!approval) throw new DomainError("APPROVAL_NOT_FOUND", "Solicitação de aprovação não encontrada.");
        return toolResult({ ok: true, data: { approval } });
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  server.registerTool(
    "propose_task_update",
    {
      title: "Propor atualização de tarefa",
      description: "Cria uma solicitação para alterar uma tarefa existente. A tarefa permanece igual até a aprovação humana.",
      inputSchema: z.object({
        project_id: z.string().min(1),
        task_id: z.string().min(1),
        status: z.enum(["todo", "in_progress", "blocked", "done"]).optional(),
        priority: z.enum(["low", "medium", "high"]).optional(),
        due_date: z.iso.date().nullable().optional(),
        assignee: z.string().min(2).max(80).nullable().optional(),
        justification: z.string().min(15).max(500),
        idempotency_key: z.string().min(8).max(120),
      }).refine(
        (value) => value.status !== undefined || value.priority !== undefined || value.due_date !== undefined || value.assignee !== undefined,
        { message: "Informe ao menos uma alteração para a tarefa." },
      ),
      outputSchema: ToolEnvelopeSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        requireScope(client, "tasks:update:propose");
        const result = repository.proposeTaskUpdate({
          projectId: args.project_id,
          taskId: args.task_id,
          status: args.status,
          priority: args.priority,
          dueDate: args.due_date,
          assignee: args.assignee,
          justification: args.justification,
          idempotencyKey: args.idempotency_key,
        }, client);
        return toolResult({
          ok: true,
          data: {
            approval: result.approval,
            reused: result.reused,
            message: result.reused
              ? "Esta chave idempotente já representa a mesma solicitação."
              : "Atualização proposta. A tarefa permanece inalterada até a aprovação humana.",
          },
        });
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  server.registerTool(
    "propose_blocker_resolution",
    {
      title: "Propor resolução de impedimento",
      description: "Cria uma solicitação para resolver um impedimento e registrar como ele foi solucionado.",
      inputSchema: z.object({
        project_id: z.string().min(1),
        blocker_id: z.string().min(1),
        resolution_note: z.string().min(15).max(500),
        justification: z.string().min(15).max(500),
        idempotency_key: z.string().min(8).max(120),
      }),
      outputSchema: ToolEnvelopeSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        requireScope(client, "blockers:resolve:propose");
        const result = repository.proposeBlockerResolution({
          projectId: args.project_id,
          blockerId: args.blocker_id,
          resolutionNote: args.resolution_note,
          justification: args.justification,
          idempotencyKey: args.idempotency_key,
        }, client);
        return toolResult({
          ok: true,
          data: {
            approval: result.approval,
            reused: result.reused,
            message: result.reused
              ? "Esta chave idempotente já representa a mesma solicitação."
              : "Resolução proposta. O impedimento continua aberto até a aprovação humana.",
          },
        });
      } catch (error) {
        return handleToolError(error);
      }
    },
  );

  server.registerPrompt(
    "project-status-review",
    {
      title: "Revisão de status do projeto",
      description: "Orienta uma análise baseada apenas no contexto estruturado do projeto.",
      argsSchema: z.object({
        project_id: z.string().min(1),
        focus: z.enum(["executive", "risks", "delivery"]).default("executive"),
      }),
    },
    ({ project_id, focus }) => ({
      description: "Revisão controlada do status do projeto",
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            `Consulte primeiro o resource project-bridge://projects/${project_id}.`,
            `Produza uma revisão com foco em '${focus}'.`,
            "Diferencie fatos, riscos e recomendações.",
            "Não afirme que uma ação foi executada. Use somente Tools de proposta e informe que haverá aprovação humana.",
          ].join("\n"),
        },
      }],
    }),
  );

  return server;
}

export function createMcpFactory(repository: ProjectRepository, authenticator: HttpAuthenticator): McpServerFactory {
  return (context) => buildMcpServer(repository, resolveHttpClientContext(context, authenticator));
}
