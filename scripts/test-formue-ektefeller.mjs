// Regresjonstest: ektefeller skal ha DOBLE beløpsgrenser i formuesskatten — også
// innslagspunktet for statlig trinn 2, ikke bare bunnfradraget.
//
// Stortingets skattevedtak for inntektsåret 2025 § 2-1
// (https://lovdata.no/dokument/STV/forskrift/2024-12-13-3203/%C2%A72-3):
//   enslig      bunnfradrag 1 760 000 — 0,475 % opp til 20 700 000, 0,575 % over
//   ektefeller  bunnfradrag 3 520 000 — 0,475 % opp til 41 400 000, 0,575 % over
// (ektefeller som får skatten fastsatt under ett for felles formue, jf. sktl. § 2-10)
//
// Før fiksen brukte formue.ts trinn 2-innslaget (20,7 MNOK) rått for ektefeller, slik at
// felles formue mellom 20,7 og 41,4 MNOK feilaktig fikk 0,575 %-satsen på toppen.
// Samme bugg og samme fiks som skatt-optimizer formue.py (83873ba, 2026-07-12).
//
// Gylne tall er håndregnet fra 2025-satsene. Bankinnskudd har verdsetting 1,00 og det er
// ingen gjeld, så skattemessig verdi == markedsverdi og tallene er rene.

import { spawn } from "node:child_process";
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
    clientInfo: { name: "test-formue-ektefeller", version: "0.0.1" },
  },
});

notify({ jsonrpc: "2.0", method: "notifications/initialized" });

const kr = (n) => Math.round(n).toLocaleString("nb-NO");

const saker = [
  {
    navn: "ektefeller 30 MNOK — under det doblede innslaget, ingen trinn 2",
    bank: 30_000_000,
    ektefeller: true,
    // kommunal (30,0 − 3,52) MNOK × 0,525 %; trinn 1 løper helt opp til nettoformuen
    forventet: { kommunal: 139_020, trinn1: 125_780, trinn2: 0, total: 264_800 },
    innslag: 41_400_000,
    // Med buggen: trinn 1 stoppet på 20,7 MNOK og 9,3 MNOK fikk 0,575 % → 274 100 (+9 300).
    forbudt: ["274 100"],
  },
  {
    navn: "ektefeller 50 MNOK — trinn 1 opp til 41,4 MNOK, trinn 2 kun på de siste 8,6",
    bank: 50_000_000,
    ektefeller: true,
    forventet: { kommunal: 244_020, trinn1: 179_930, trinn2: 49_450, total: 473_400 },
    innslag: 41_400_000,
    // Med buggen: 494 100 (+20 700).
    forbudt: ["494 100"],
  },
  {
    navn: "enslig 30 MNOK — innslaget står på 20,7 MNOK, uendret av fiksen",
    bank: 30_000_000,
    ektefeller: false,
    forventet: { kommunal: 148_260, trinn1: 89_965, trinn2: 53_475, total: 291_700 },
    innslag: 20_700_000,
    forbudt: [],
  },
  {
    navn: "ektefeller 10 MNOK — godt under begge innslag, uendret av fiksen",
    bank: 10_000_000,
    ektefeller: true,
    forventet: { kommunal: 34_020, trinn1: 30_780, trinn2: 0, total: 64_800 },
    innslag: 41_400_000,
    forbudt: [],
  },
];

let id = 2;
let allesGreit = true;

for (const sak of saker) {
  const r = await send({
    jsonrpc: "2.0",
    id: id++,
    method: "tools/call",
    params: {
      name: "calculate_formuesskatt",
      arguments: {
        formuesposter: [{ type: "bankinnskudd", markedsverdi: sak.bank }],
        total_gjeld: 0,
        ektefeller: sak.ektefeller,
        aar: 2025,
      },
    },
  });

  const text = r.result?.content?.[0]?.text;
  if (!text) {
    console.error(`❌ ${sak.navn} — ingen tekst i svaret:`, JSON.stringify(r));
    allesGreit = false;
    continue;
  }

  const feil = [];
  const krev = (etikett, verdi) => {
    if (!text.includes(kr(verdi))) feil.push(`  ${etikett}: fant ikke ${kr(verdi)}`);
  };

  krev("kommunal", sak.forventet.kommunal);
  krev("statlig trinn 1", sak.forventet.trinn1);
  krev("total formuesskatt", sak.forventet.total);
  krev("innslag statlig trinn 2", sak.innslag);

  if (sak.forventet.trinn2 === 0) {
    if (/Statlig trinn 2/.test(text)) feil.push("  trinn 2 vises selv om den skal være 0");
  } else {
    krev("statlig trinn 2", sak.forventet.trinn2);
  }

  for (const b of sak.forbudt) {
    if (text.includes(b)) feil.push(`  buggens tall ${b} står fortsatt i output`);
  }

  if (feil.length > 0) {
    console.error(`❌ ${sak.navn}`);
    for (const f of feil) console.error(f);
    console.error("--- full output ---");
    console.error(text);
    allesGreit = false;
  } else {
    console.log(`✅ ${sak.navn}`);
  }
}

proc.kill();

if (!allesGreit) {
  console.error("\nFormue-ektefelletesten FEILET.");
  process.exit(1);
}
console.log("\nAlle 4 formue-ektefelletester grønne.");
process.exit(0);
