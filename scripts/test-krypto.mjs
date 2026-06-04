// Acceptance test for calculate_kryptogevinst.
// Runs three cases: enkel, FIFO-delsalg, tap. Writes outputs to scripts/krypto-{case}.txt.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

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
    clientInfo: { name: "test-krypto", version: "0.0.1" },
  },
});

notify({ jsonrpc: "2.0", method: "notifications/initialized" });

const cases = {
  enkel: {
    transaksjoner: [
      { valuta: "BTC", type: "kjøp", dato: "2025-01-15", antall: 1, pris_per_enhet: 400000, gebyr: 100 },
      { valuta: "BTC", type: "salg", dato: "2025-09-15", antall: 1, pris_per_enhet: 500000, gebyr: 100 },
    ],
    rapporteringsaar: 2025,
  },
  fifo_delsalg: {
    transaksjoner: [
      { valuta: "BTC", type: "kjøp", dato: "2025-01-15", antall: 1.0, pris_per_enhet: 400000, gebyr: 100 },
      { valuta: "BTC", type: "kjøp", dato: "2025-03-20", antall: 0.5, pris_per_enhet: 500000, gebyr: 100 },
      { valuta: "BTC", type: "kjøp", dato: "2025-06-10", antall: 0.3, pris_per_enhet: 600000, gebyr: 100 },
      { valuta: "BTC", type: "salg", dato: "2025-09-15", antall: 1.5, pris_per_enhet: 700000, gebyr: 100 },
    ],
    rapporteringsaar: 2025,
  },
  tap: {
    transaksjoner: [
      { valuta: "BTC", type: "kjøp", dato: "2025-01-15", antall: 1, pris_per_enhet: 500000, gebyr: 100 },
      { valuta: "BTC", type: "salg", dato: "2025-09-15", antall: 1, pris_per_enhet: 400000, gebyr: 100 },
    ],
    rapporteringsaar: 2025,
  },
};

let id = 2;
for (const [navn, args] of Object.entries(cases)) {
  const r = await send({
    jsonrpc: "2.0",
    id: id++,
    method: "tools/call",
    params: { name: "calculate_kryptogevinst", arguments: args },
  });

  const text = r.result?.content?.[0]?.text;
  const isError = r.result?.isError;
  if (!text) {
    console.error(`Case ${navn} — no text in response:`, JSON.stringify(r));
    proc.kill();
    process.exit(1);
  }

  writeFileSync(join(__dirname, `krypto-${navn}.txt`), text + "\n");
  console.log(`--- ${navn}${isError ? " [ERROR]" : ""} ---`);
  console.log(text);
  console.log();
}

proc.kill();
process.exit(0);
