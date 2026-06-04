#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerInntektsskattVerktøy } from "./tools/inntekt.js";
import { registerFormuesskattVerktøy } from "./tools/formue.js";
import { registerAksjeVerktøy } from "./tools/aksjer.js";
import { registerAskVerktøy } from "./tools/ask.js";
import { registerFondVerktøy } from "./tools/fond.js";
import { registerBoligVerktøy } from "./tools/bolig.js";
import { registerKryptoVerktøy } from "./tools/krypto.js";
import { registerImportNordnetVerktøy } from "./tools/import_nordnet.js";
import { registerSkatteoppgjoerVerktøy } from "./tools/skatteoppgjor.js";
import { registerLovdataVerktøy } from "./tools/lovdata.js";

process.on("uncaughtException", (err) => {
  process.stderr.write(`[skatt-mcp] Uncaught exception: ${err.message}\n`);
});

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`[skatt-mcp] Unhandled rejection: ${reason}\n`);
});

const server = new McpServer({
  name: "skatt-mcp",
  version: "0.0.1",
});

registerInntektsskattVerktøy(server);
registerFormuesskattVerktøy(server);
registerAksjeVerktøy(server);
registerAskVerktøy(server);
registerFondVerktøy(server);
registerBoligVerktøy(server);
registerKryptoVerktøy(server);
registerImportNordnetVerktøy(server);
registerSkatteoppgjoerVerktøy(server);
registerLovdataVerktøy(server);

const transport = new StdioServerTransport();
await server.connect(transport);
