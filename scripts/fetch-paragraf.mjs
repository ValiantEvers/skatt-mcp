// Quick MCP-call: fetch a single paragraph via lookup_paragraf and print title.
// Usage: node scripts/fetch-paragraf.mjs <refID>

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const refID = process.argv[2];
if (!refID) {
  console.error("usage: node scripts/fetch-paragraf.mjs <refID>");
  process.exit(1);
}

const proc = spawn("node", [join(repoRoot, "dist", "server.js")], {
  stdio: ["pipe", "pipe", "pipe"],
});

let buf = "";
let pending = null;

proc.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf-8");
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (pending && msg.id === pending.id) {
      pending.resolve(msg);
      pending = null;
    }
  }
});

proc.stderr.on("data", (chunk) => process.stderr.write(chunk));

function send(req) {
  return new Promise((resolve) => {
    pending = { id: req.id, resolve };
    proc.stdin.write(JSON.stringify(req) + "\n");
  });
}

function notify(req) {
  proc.stdin.write(JSON.stringify(req) + "\n");
}

await send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "fetch-paragraf", version: "0.0.1" },
  },
});

notify({ jsonrpc: "2.0", method: "notifications/initialized" });

const r = await send({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: "lookup_paragraf", arguments: { refID } },
});

const text = r.result?.content?.[0]?.text;
const isError = r.result?.isError;
if (isError) {
  console.error("ERROR:", text);
  proc.kill();
  process.exit(1);
}
// Print only the first line (title) and second (lovnavn)
const lines = (text ?? "").split("\n");
console.log("TITTEL:", lines[0]);
console.log("LOVNAVN:", lines[1]);
console.log("HENTET (slice 30):", text?.slice(0, 30));
proc.kill();
process.exit(0);
