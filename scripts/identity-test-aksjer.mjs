// Identity test for aksjer FIFO refactoring.
// Spawns dist/server.js, runs MCP initialize handshake, calls calculate_aksjegevinst
// for both gevinst-case and tap-case, writes outputs to scripts/<tag>-{gevinst,tap}.txt.
//
// Usage: node scripts/identity-test-aksjer.mjs <tag>
//   tag = "before" before refactoring, "after" after refactoring.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const tag = process.argv[2];
if (!tag) {
  console.error("usage: node scripts/identity-test-aksjer.mjs <tag>");
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
      console.error("non-json line from server:", line);
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

const baseTransaksjoner = [
  { ticker: "EQNR", type: "kjøp", dato: "2025-01-15", antall: 100, pris_per_aksje: 280, kurtasje: 99 },
  { ticker: "EQNR", type: "kjøp", dato: "2025-03-20", antall: 50,  pris_per_aksje: 310, kurtasje: 99 },
  { ticker: "EQNR", type: "kjøp", dato: "2025-06-10", antall: 75,  pris_per_aksje: 295, kurtasje: 99 },
];

const gevinstCase = {
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: {
    name: "calculate_aksjegevinst",
    arguments: {
      transaksjoner: [
        ...baseTransaksjoner,
        { ticker: "EQNR", type: "salg", dato: "2025-09-15", antall: 175, pris_per_aksje: 340, kurtasje: 99 },
      ],
      rapporteringsaar: 2025,
    },
  },
};

const tapCase = {
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: {
    name: "calculate_aksjegevinst",
    arguments: {
      transaksjoner: [
        ...baseTransaksjoner,
        { ticker: "EQNR", type: "salg", dato: "2025-09-15", antall: 175, pris_per_aksje: 250, kurtasje: 99 },
      ],
      rapporteringsaar: 2025,
    },
  },
};

await send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "identity-test", version: "0.0.1" },
  },
});

notify({ jsonrpc: "2.0", method: "notifications/initialized" });

const r1 = await send(gevinstCase);
const r2 = await send(tapCase);

const text1 = r1.result?.content?.[0]?.text;
const text2 = r2.result?.content?.[0]?.text;

if (!text1 || !text2) {
  console.error("missing text in response");
  console.error("r1:", JSON.stringify(r1));
  console.error("r2:", JSON.stringify(r2));
  proc.kill();
  process.exit(1);
}

writeFileSync(join(__dirname, `${tag}-gevinst.txt`), text1 + "\n");
writeFileSync(join(__dirname, `${tag}-tap.txt`), text2 + "\n");

console.log(`Wrote scripts/${tag}-gevinst.txt and scripts/${tag}-tap.txt`);

proc.kill();
process.exit(0);
