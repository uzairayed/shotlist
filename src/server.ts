import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ensureProject, getShotlistDir } from "./project.js";
import { registerPlanTools } from "./plan.js";
import { registerTakeTools } from "./takes.js";
import { registerShotlistTools } from "./shotlist.js";
import { registerRenderTools } from "./render.js";
import { registerCaptureTools } from "./capture.js";

export function createServer(): McpServer {
  ensureProject(getShotlistDir());
  const server = new McpServer({
    name: "shotlist",
    version: "1.0.0",
  });
  return server;
}

export function registerAllTools(server: McpServer): void {
  registerPlanTools(server);
  registerTakeTools(server);
  registerShotlistTools(server);
  registerRenderTools(server);
  registerCaptureTools(server);
}

export async function startServer(): Promise<void> {
  const server = createServer();
  registerAllTools(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
