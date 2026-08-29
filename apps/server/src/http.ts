import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8010);
const host = "127.0.0.1";
const runtime = createApp();
const httpServer = runtime.app.listen(port, host, () => {
  console.log(`Project Bridge API: http://${host}:${port}`);
  console.log(`Project Bridge MCP: http://${host}:${port}/mcp`);
});

async function shutdown(): Promise<void> {
  httpServer.close();
  await runtime.close();
  runtime.db.close();
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
