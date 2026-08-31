import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createDatabase, type DatabaseConnection } from "./database.js";
import { buildMcpServer } from "./mcp.js";
import { ProjectRepository } from "./repository.js";

const databases: DatabaseConnection[] = [];

function testDatabase(): DatabaseConnection {
  const db = createDatabase(":memory:");
  databases.push(db);
  return db;
}

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

describe("Project Bridge API", () => {
  it("inicia com o Projeto Atlas e indicadores coerentes", async () => {
    const runtime = createApp(testDatabase());
    const overview = await request(runtime.app).get("/api/overview").expect(200);
    const project = await request(runtime.app).get("/api/projects/atlas").expect(200);

    expect(overview.body).toMatchObject({
      projects: 1,
      projects_at_risk: 1,
      pending_approvals: 1,
      open_blockers: 2,
    });
    expect(project.body.tasks).toHaveLength(4);
    expect(project.body.decisions).toHaveLength(3);
    await runtime.close();
  });

  it("só cria a tarefa depois da aprovação humana e não duplica a decisão", async () => {
    const runtime = createApp(testDatabase());

    await request(runtime.app)
      .post("/api/approvals/approval-demo/decision")
      .send({ decision: "approved", note: "A tarefa é necessária para reduzir o risco do piloto." })
      .expect(200);

    const afterFirstDecision = await request(runtime.app).get("/api/projects/atlas").expect(200);
    expect(afterFirstDecision.body.tasks).toHaveLength(5);
    expect(afterFirstDecision.body.tasks).toContainEqual(expect.objectContaining({
      id: "task-from-approval-demo",
      source: "mcp",
    }));

    await request(runtime.app)
      .post("/api/approvals/approval-demo/decision")
      .send({ decision: "approved", note: "Uma segunda chamada não deve duplicar a tarefa." })
      .expect(200);

    const afterSecondDecision = await request(runtime.app).get("/api/projects/atlas").expect(200);
    expect(afterSecondDecision.body.tasks).toHaveLength(5);
    await runtime.close();
  });

  it("publica uma mudança de Resource somente quando a aprovação altera o projeto", async () => {
    const runtime = createApp(testDatabase());
    const events: unknown[] = [];
    const unsubscribe = runtime.mcpHandler.bus.subscribe((event) => events.push(event));

    await request(runtime.app)
      .post("/api/approvals/approval-demo/decision")
      .send({ decision: "approved", note: "A mudança deve invalidar o contexto consumido pelos clientes MCP." })
      .expect(200);

    await request(runtime.app)
      .post("/api/approvals/approval-demo/decision")
      .send({ decision: "approved", note: "Repetir a decisão não deve publicar um segundo evento." })
      .expect(200);

    expect(events).toEqual([{
      kind: "resource_updated",
      uri: "project-bridge://projects/atlas",
    }]);

    unsubscribe();
    await runtime.close();
  });
});

describe("MCP contracts", () => {
  async function connect(scopes: string[]) {
    const repository = new ProjectRepository(testDatabase());
    const server = buildMcpServer(repository, {
      clientName: "contract-test-client",
      scopes: new Set(scopes),
      transport: "test",
    });
    const client = new Client({ name: "project-bridge-tests", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, server, repository };
  }

  it("expõe Resources, Tools, Prompt e saída estruturada", async () => {
    const { client, server } = await connect(["projects:read", "approvals:read", "tasks:propose"]);

    const tools = await client.listTools();
    const resources = await client.listResources();
    const prompts = await client.listPrompts();
    const result = await client.callTool({ name: "get_project_context", arguments: { project_id: "atlas" } });

    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "list_projects",
      "get_project_context",
      "list_project_blockers",
      "propose_task",
      "get_approval_status",
    ]));
    expect(resources.resources.map((resource) => resource.uri)).toContain("project-bridge://projects");
    expect(prompts.prompts.map((prompt) => prompt.name)).toContain("project-status-review");
    expect(result.structuredContent).toMatchObject({ ok: true, data: { project: { id: "atlas" } } });

    await client.close();
    await server.close();
  });

  it("reutiliza uma solicitação quando a chave idempotente se repete", async () => {
    const { client, server, repository } = await connect(["projects:read", "approvals:read", "tasks:propose"]);
    const args = {
      project_id: "atlas",
      title: "Revisar riscos do piloto",
      priority: "high",
      justification: "Os impedimentos abertos podem comprometer a data alvo.",
      idempotency_key: "contract-test-atlas-risk-review",
    };

    const first = await client.callTool({ name: "propose_task", arguments: args });
    const second = await client.callTool({ name: "propose_task", arguments: args });

    expect(first.structuredContent).toMatchObject({ ok: true, data: { reused: false } });
    expect(second.structuredContent).toMatchObject({ ok: true, data: { reused: true } });
    expect(repository.listApprovals().filter((approval) => approval.idempotency_key === args.idempotency_key)).toHaveLength(1);

    await client.close();
    await server.close();
  });

  it("nega ferramenta mutável quando o cliente possui somente leitura", async () => {
    const { client, server } = await connect(["projects:read", "approvals:read"]);
    const result = await client.callTool({
      name: "propose_task",
      arguments: {
        project_id: "atlas",
        title: "Criar tarefa sem permissão",
        priority: "medium",
        justification: "Esta solicitação deve ser bloqueada pelo contrato de escopos.",
        idempotency_key: "contract-test-scope-denied",
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "SCOPE_REQUIRED" },
    });

    await client.close();
    await server.close();
  });

  it("aceita uma conexão real por Streamable HTTP", async () => {
    const runtime = createApp(testDatabase());
    const httpServer = runtime.app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => httpServer.once("listening", resolve));
    const address = httpServer.address() as AddressInfo;
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
      requestInit: {
        headers: {
          "x-project-bridge-client": "http-contract-test",
          "x-project-bridge-scopes": "projects:read,approvals:read",
        },
      },
    });
    const client = new Client({ name: "http-contract-test", version: "0.1.0" });

    await client.connect(transport);
    const result = await client.callTool({ name: "list_projects", arguments: {} });
    expect(result.structuredContent).toMatchObject({ ok: true, data: { projects: [{ id: "atlas" }] } });

    await client.close();
    await runtime.close();
    await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
  });

  it("entrega a atualização do Resource por uma assinatura MCP real", async () => {
    const runtime = createApp(testDatabase());
    const httpServer = runtime.app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => httpServer.once("listening", resolve));
    const address = httpServer.address() as AddressInfo;
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
    const client = new Client(
      { name: "resource-subscription-test", version: "0.1.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    const resourceUri = "project-bridge://projects/atlas";
    const updated = new Promise<string>((resolve) => {
      client.setNotificationHandler("notifications/resources/updated", (notification) => {
        resolve(notification.params.uri);
      });
    });

    await client.connect(transport);
    const subscription = await client.listen({ resourceSubscriptions: [resourceUri] });

    await request(runtime.app)
      .post("/api/approvals/approval-demo/decision")
      .send({ decision: "approved", note: "A assinatura deve receber a mudança deste Resource." })
      .expect(200);

    await expect(updated).resolves.toBe(resourceUri);

    await subscription.close();
    await client.close();
    await runtime.close();
    await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
  });
});
