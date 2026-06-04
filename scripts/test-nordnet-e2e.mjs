// Ende-til-ende test:
// Parse fixture 1 → mat transaksjoner inn i calculate_aksjegevinst → verifiser numerisk.
//
// Krever at dist/ er bygget.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseNordnetCsv } from "../dist/lib/csv-parsers/nordnet.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

// ── Hjelpere for MCP-call mot dist/server.js ────────────────────────────
function nyServer() {
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

  return {
    send(req) {
      return new Promise((resolve) => {
        pending = { id: req.id, resolve };
        proc.stdin.write(JSON.stringify(req) + "\n");
      });
    },
    notify(req) {
      proc.stdin.write(JSON.stringify(req) + "\n");
    },
    close() {
      proc.kill();
    },
  };
}

const server = nyServer();
await server.send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "nordnet-e2e", version: "0.0.1" },
  },
});
server.notify({ jsonrpc: "2.0", method: "notifications/initialized" });

// ── Del 1: Fixture 1 → calculate_aksjegevinst ──────────────────────────
console.log("=== Del 1: Fixture 1 → calculate_aksjegevinst ===");

const fixture1 = parseNordnetCsv(
  readFileSync(
    join(repoRoot, "test-fixtures", "nordnet", "fixture-1-ren-nok.csv"),
    "utf-8"
  )
);

const r1 = await server.send({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: {
    name: "calculate_aksjegevinst",
    arguments: {
      transaksjoner: fixture1.transaksjoner,
      rapporteringsaar: 2025,
    },
  },
});

const text = r1.result?.content?.[0]?.text;
if (!text) {
  console.error("Ingen tekst i kalkulator-respons:", JSON.stringify(r1));
  server.close();
  process.exit(1);
}

console.log(text);
console.log();

// Forventet: gevinst 5942, oppjustert 10220, skatt 2248
// Norsk locale grupperer med U+202F (narrow no-break space) — bruk \s for å matche alle whitespace-varianter
const harGevinst = /gevinst 5\s942/.test(text);
const harOppjustert = /Oppjustert.*10\s220/.test(text);
const harSkatt = /Implisert skatt.*2\s248/.test(text);
console.log("Gevinst 5 942 funnet:", harGevinst ? "✅" : "❌");
console.log("Oppjustert 10 220 funnet:", harOppjustert ? "✅" : "❌");
console.log("Skatt 2 248 funnet:", harSkatt ? "✅" : "❌");

if (!harGevinst || !harOppjustert || !harSkatt) {
  console.error("Numerisk verifikasjon feilet");
  server.close();
  process.exit(1);
}

server.close();
process.exit(0);
