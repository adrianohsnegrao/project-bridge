import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createDatabase } from "./database.js";
import { buildMcpServer, resolveStdioClientContext } from "./mcp.js";
import { ProjectRepository } from "./repository.js";

const db = createDatabase();
const repository = new ProjectRepository(db);
const client = resolveStdioClientContext();

const handle = serveStdio(() => buildMcpServer(repository, client), {
  onerror: (error) => console.error("[Project Bridge MCP]", error.message),
});

process.on("SIGINT", async () => {
  await handle.close();
  db.close();
});
