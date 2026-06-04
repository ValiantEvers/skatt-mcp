// Test for orkestratoren beregn_skatteoppgjoer_nordnet.
// Bygger en kombinert aksje+fond Nordnet-TSV in-code (garanterte tabs),
// skriver den til test-fixtures/, og kjører den gjennom den bygde MCP-serveren.
//
// Forventet (rapporteringsår 2025):
//   Aksje (Equinor NO0010096985): kjøp 100@280 + 50@310, salg 100@340, kurtasje 29
//     → gevinst 5 942, oppjustert ×1,72 = 10 220, skatt 22 % = 2 248
//   Fond (Nordea Asian Stars Fund A NOK FI0008813282, aksjefond):
//     kjøp 100@1000 (2025-02), salg 100@1200 (2025-06), ingen gebyr
//     → gevinst 20 000, aksjedel 100 %, ingen skjerming (kjøpt i året),
//       oppjustert 34 400, skatt 7 568
//   SAMLET SKATT = 2 248 + 7 568 = 9 816
//
// Krever at dist/ er bygget.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

// ── Bygg kombinert TSV ──────────────────────────────────────────────────
const HEADER = [
  "Id", "Bokføringsdag", "Handelsdag", "Oppgjørsdag", "Portefølje",
  "Transaksjonstype", "Verdipapir", "ISIN", "Antall", "Kurs", "Rente",
  "Totale Avgifter", "Valuta", "Beløp", "Valuta", "Kjøpsverdi", "Valuta",
  "Resultat", "Valuta", "Totalt antall", "Saldo", "Vekslingskurs",
  "Transaksjonstekst", "Makuleringsdato", "Sluttseddelnummer",
  "Verifikationsnummer", "Kurtasje", "Valuta", "Valutakurs", "Innledende rente",
];

// Hver rad: 30 felt, tab-separert. Tomme felt = "".
const RADER = [
  // Equinor — aksje
  ["1001","2025-01-15","2025-01-15","2025-01-17","999","KJØPT","Equinor","NO0010096985","100","280","","29","NOK","-28029","NOK","28000","NOK","0","NOK","100","0","1","Kjøp Equinor","","A001","A002","29","NOK","1","0"],
  ["1002","2025-03-20","2025-03-20","2025-03-22","999","KJØPT","Equinor","NO0010096985","50","310","","29","NOK","-15529","NOK","15500","NOK","0","NOK","150","0","1","Kjøp Equinor","","A003","A004","29","NOK","1","0"],
  ["1003","2025-09-15","2025-09-15","2025-09-17","999","SALG","Equinor","NO0010096985","100","340","","29","NOK","33971","NOK","","NOK","5942","NOK","50","0","1","Salg Equinor","","A005","A006","29","NOK","1","0"],
  // Nordea Asian Stars Fund A NOK — aksjefond (kjøpt og solgt i 2025)
  ["2001","2025-02-01","2025-02-01","2025-02-03","999","KJØPT","Nordea Asian Stars Fund A NOK","FI0008813282","100","1000","","0","NOK","-100000","NOK","100000","NOK","0","NOK","100","0","1","Kjøp fond","","B001","B002","0","NOK","1","0"],
  ["2002","2025-06-01","2025-06-01","2025-06-03","999","SALG","Nordea Asian Stars Fund A NOK","FI0008813282","100","1200","","0","NOK","120000","NOK","","NOK","20000","NOK","0","0","1","Salg fond","","B003","B004","0","NOK","1","0"],
  // Et utbytte (skal IKKE inngå i gevinstberegning, men gi advarsel)
  ["3001","2025-05-02","2025-05-02","2025-05-02","999","UTBYTTE","Equinor","NO0010096985","100","","","0","NOK","1200","NOK","","NOK","","NOK","150","0","1","Utbytte Equinor","","C001","C002","0","NOK","1","0"],
];

const tsv = [HEADER, ...RADER].map((r) => r.join("\t")).join("\n") + "\n";

const fixturePath = join(
  repoRoot, "test-fixtures", "nordnet", "fixture-7-aksje-og-fond.csv"
);
writeFileSync(fixturePath, tsv, "utf-8");

// ── MCP-helper ──────────────────────────────────────────────────────────
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
      try { msg = JSON.parse(line); } catch { continue; }
      if (pending && msg.id === pending.id) { pending.resolve(msg); pending = null; }
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
    notify(req) { proc.stdin.write(JSON.stringify(req) + "\n"); },
    close() { proc.kill(); },
  };
}

const server = nyServer();
await server.send({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: {
    protocolVersion: "2025-03-26", capabilities: {},
    clientInfo: { name: "skatteoppgjoer-test", version: "0.0.1" },
  },
});
server.notify({ jsonrpc: "2.0", method: "notifications/initialized" });

// ── Kjør orkestratoren med csv_tekst ─────────────────────────────────────
const r = await server.send({
  jsonrpc: "2.0", id: 2, method: "tools/call",
  params: {
    name: "beregn_skatteoppgjoer_nordnet",
    arguments: { csv_tekst: tsv, rapporteringsaar: 2025 },
  },
});

const text = r.result?.content?.[0]?.text;
if (!text) {
  console.error("Ingen tekst i respons:", JSON.stringify(r));
  server.close();
  process.exit(1);
}
console.log(text);
console.log("\n── Verifikasjon ──");

// \s matcher U+202F (norsk tusenskille)
const sjekker = [
  ["Aksje gevinst 5 942", /gevinst 5\s?942/],
  ["Aksje skatt 2 248", /Skatt aksjer \(22 %\):\s*2\s?248/],
  ["Fond gevinst 20 000", /gevinst 20\s?000/],
  ["Fond skatt 7 568", /Skatt fond totalt:\s*7\s?568/],
  ["SAMLET SKATT 9 816", /SAMLET SKATT:\s*9\s?816/],
  ["Utbytte-advarsel", /utbytte-rader funnet/i],
  ["Ingen ukjente ISIN", /^(?!.*mangler\/ukjent).*/s],
];

let alleOk = true;
for (const [navn, re] of sjekker) {
  const ok = re.test(text);
  if (!ok) alleOk = false;
  console.log(`  ${ok ? "✅" : "❌"} ${navn}`);
}

// Ekstra: csv_filsti-varianten gir samme samlede skatt
const r2 = await server.send({
  jsonrpc: "2.0", id: 3, method: "tools/call",
  params: {
    name: "beregn_skatteoppgjoer_nordnet",
    arguments: { csv_filsti: fixturePath, rapporteringsaar: 2025 },
  },
});
const text2 = r2.result?.content?.[0]?.text ?? "";
const filstiOk = /SAMLET SKATT:\s*9\s?816/.test(text2);
console.log(`  ${filstiOk ? "✅" : "❌"} csv_filsti gir samme samlede skatt`);
if (!filstiOk) alleOk = false;

server.close();
process.exit(alleOk ? 0 : 1);
