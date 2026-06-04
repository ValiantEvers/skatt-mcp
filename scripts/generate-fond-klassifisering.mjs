// Genererer utkast-klassifisering av verdipapirer fra to Nordnet-eksporter:
// (a) uten ticker — "Verdipapir" er fullt fondsnavn / aksjenavn
// (b) med ticker — "Verdipapir" er ticker-symbol (eller forkortet form)
//
// Begge filer kobles per ISIN. Klassifisering følger spec'en strikt:
//
//   Regel 1 — Rentefond (på fullt_navn):
//     Bond, High Yield, Likviditet, Høyrente, Corporate
//   Regel 2 — Aksjefond (på fullt_navn):
//     Indeks, Index, Fund, Fond, ETF, UCITS, Invest, Renewable
//   Regel 3 — Aksje (på tick_navn):
//     /^[A-Z0-9./]+(\s[A-Z])?$/
//   Regel 4 — Ukjent (resterende)
//
// INGEN suffix-baserte fallbacks. Ticker-regex må matche tick_navn.
//
// Leveranse: src/data/fond-klassifisering.draft.json + stdout-sammendrag.
//
// Forutsetter at dist/ er bygget.
//
// Bruk:
//   node scripts/generate-fond-klassifisering.mjs \
//     --uten-ticker "<sti-til-fil-uten-ticker>" \
//     --med-ticker  "<sti-til-fil-med-ticker>"

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseNordnetCsv } from "../dist/lib/csv-parsers/nordnet.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const utSti = join(repoRoot, "src", "data", "fond-klassifisering.draft.json");

// ── CLI-parsing ───────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { utenTicker: null, medTicker: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--uten-ticker") {
      out.utenTicker = argv[++i];
    } else if (argv[i] === "--med-ticker") {
      out.medTicker = argv[++i];
    }
  }
  if (!out.utenTicker || !out.medTicker) {
    console.error(
      "usage: node scripts/generate-fond-klassifisering.mjs " +
        "--uten-ticker <path> --med-ticker <path>"
    );
    process.exit(1);
  }
  return out;
}

// ── Dekoding (mirror av src/tools/import_nordnet.ts) ──────────────────────
function dekodNordnetBuffer(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString("utf16le");
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const le = Buffer.alloc(buf.length - 2);
    for (let i = 2; i + 1 < buf.length; i += 2) {
      le[i - 2] = buf[i + 1];
      le[i - 1] = buf[i];
    }
    return le.toString("utf16le");
  }
  return buf.toString("utf-8");
}

// ── ISIN/navn-ekstraksjon (parser eksponerer ikke ISIN) ───────────────────
// I FORVENTET_HEADER (nordnet.ts): Verdipapir=6, ISIN=7 (0-indeksert).
const KOL_VERDIPAPIR = 6;
const KOL_ISIN = 7;

function strippBom(s) {
  if (s.charCodeAt(0) === 0xfeff) return s.slice(1);
  return s;
}

function ekstraherIsinNavn(innhold) {
  // Returnerer Map<isin, Set<navn>> — sett pga at samme ISIN kan ha flere
  // navn-varianter ved rebranding (rapporteres som edge case).
  const ut = new Map();
  const linjer = strippBom(innhold).split(/\r?\n/);
  for (let i = 1; i < linjer.length; i++) {
    const linje = linjer[i];
    if (!linje) continue;
    const celler = linje.split("\t");
    const navn = (celler[KOL_VERDIPAPIR] ?? "").trim();
    const isin = (celler[KOL_ISIN] ?? "").trim();
    if (!navn || !isin) continue;
    if (!ut.has(isin)) ut.set(isin, new Set());
    ut.get(isin).add(navn);
  }
  return ut;
}

// ── Klassifisering — strikt spec, ingen suffix-fallbacks ──────────────────
const RENTEFOND_REGLER = [
  { regel: "rentefond:Bond", mønster: /\bbond\b/i },
  { regel: "rentefond:High Yield", mønster: /\bhigh\s+yield\b/i },
  { regel: "rentefond:Likviditet", mønster: /\blikviditet\b/i },
  { regel: "rentefond:Høyrente", mønster: /\bhøyrente\b/i },
  { regel: "rentefond:Corporate", mønster: /\bcorporate\b/i },
];

const AKSJEFOND_REGLER = [
  { regel: "aksjefond:Indeks", mønster: /\bindeks\b/i },
  { regel: "aksjefond:Index", mønster: /\bindex\b/i },
  { regel: "aksjefond:Fund", mønster: /\bfund\b/i },
  { regel: "aksjefond:Fond", mønster: /\bfond\b/i },
  { regel: "aksjefond:ETF", mønster: /\betf\b/i },
  { regel: "aksjefond:UCITS", mønster: /\bucits\b/i },
  { regel: "aksjefond:Invest", mønster: /\binvest\b/i },
  { regel: "aksjefond:Renewable", mønster: /\brenewable\b/i },
];

// Regel 3 — ticker-regex på tick_navn (ikke fullt_navn).
const TICKER_REGEX = /^[A-Z0-9./]+(\s[A-Z])?$/;

function klassifiser(fullt_navn, tick_navn) {
  // 1. Rentefond på fullt_navn
  for (const r of RENTEFOND_REGLER) {
    if (r.mønster.test(fullt_navn)) return { type: "rentefond", regel: r.regel };
  }
  // 2. Aksjefond på fullt_navn
  for (const r of AKSJEFOND_REGLER) {
    if (r.mønster.test(fullt_navn)) return { type: "aksjefond", regel: r.regel };
  }
  // 3. Aksje på tick_navn
  if (tick_navn && TICKER_REGEX.test(tick_navn)) {
    return { type: "aksje", regel: "aksje:ticker-regex" };
  }
  // 4. Ukjent
  return { type: "ukjent", regel: "ingen-match" };
}

// ── Hovedflyt ─────────────────────────────────────────────────────────────
async function main() {
  const { utenTicker, medTicker } = parseArgs(process.argv.slice(2));
  console.log(`Uten-ticker CSV: ${utenTicker}`);
  console.log(`Med-ticker CSV:  ${medTicker}`);

  async function lesOgEkstraher(sti, etikett) {
    let buf;
    try {
      buf = await readFile(sti);
    } catch (e) {
      console.error(`Kunne ikke lese ${etikett} (${sti}): ${e.message}`);
      process.exit(1);
    }
    const innhold = dekodNordnetBuffer(buf);
    // Kall parseren for å validere CSV-strukturen (kaster ved feil format).
    const parsed = parseNordnetCsv(innhold);
    const isinMap = ekstraherIsinNavn(innhold);
    console.log(
      `  ${etikett}: ${parsed.oppsummering.antall_unike_verdipapirer} unike verdipapirer ` +
        `(parser), ${isinMap.size} unike ISIN-er (raw pass).`
    );
    return { parsed, isinMap };
  }

  console.log("\nLeser filer:");
  const fil1 = await lesOgEkstraher(utenTicker, "uten-ticker");
  const fil2 = await lesOgEkstraher(medTicker, "med-ticker");

  // ── Koble per ISIN ──────────────────────────────────────────────────────
  const alleIsin = new Set([...fil1.isinMap.keys(), ...fil2.isinMap.keys()]);

  const kunIFil1 = [];
  const kunIFil2 = [];
  const isinMedFlereNavnFil1 = [];
  const isinMedFlereNavnFil2 = [];

  const utkast = {};
  const ukjentEntries = [];

  for (const isin of [...alleIsin].sort()) {
    const navnSet1 = fil1.isinMap.get(isin);
    const navnSet2 = fil2.isinMap.get(isin);

    if (!navnSet1) {
      kunIFil2.push({ isin, navn: [...navnSet2].join(" / ") });
      continue;
    }
    if (!navnSet2) {
      kunIFil1.push({ isin, navn: [...navnSet1].join(" / ") });
    }

    const fullt_navn = navnSet1 ? [...navnSet1][0] : "";
    const tick_navn = navnSet2 ? [...navnSet2][0] : "";

    if (navnSet1 && navnSet1.size > 1) {
      isinMedFlereNavnFil1.push({ isin, navn: [...navnSet1] });
    }
    if (navnSet2 && navnSet2.size > 1) {
      isinMedFlereNavnFil2.push({ isin, navn: [...navnSet2] });
    }

    const klass = klassifiser(fullt_navn, tick_navn);
    utkast[isin] = {
      navn: fullt_navn,
      tick_navn,
      type: klass.type,
      regel: klass.regel,
    };
    if (klass.type === "ukjent") {
      ukjentEntries.push({ isin, fullt_navn, tick_navn });
    }
  }

  // ── Skriv draft-JSON ────────────────────────────────────────────────────
  const sorterteNøkler = Object.keys(utkast).sort();
  const sortertUt = {};
  for (const k of sorterteNøkler) sortertUt[k] = utkast[k];
  await writeFile(utSti, JSON.stringify(sortertUt, null, 2) + "\n", "utf-8");
  console.log(`\nSkrev ${sorterteNøkler.length} entries til ${utSti}`);

  // ── Stdout-sammendrag ───────────────────────────────────────────────────
  const perType = {};
  for (const isin of sorterteNøkler) {
    const t = utkast[isin].type;
    perType[t] = (perType[t] ?? 0) + 1;
  }
  console.log("\nKlassifisering per type:");
  for (const [t, n] of Object.entries(perType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t.padEnd(12)} ${n}`);
  }

  // Sanity-check mot forventede tall
  const forventet = { aksje: 43, aksjefond: 27, rentefond: 5, ukjent: 0 };
  console.log("\nSanity-check mot forventede tall (~43 aksje, ~27 aksjefond, 5 rentefond, 0 ukjent):");
  const avvik = [];
  for (const [t, f] of Object.entries(forventet)) {
    const faktisk = perType[t] ?? 0;
    const diff = faktisk - f;
    const flagg =
      t === "ukjent"
        ? faktisk === 0
          ? "✅"
          : "❌"
        : Math.abs(diff) <= 3
        ? "✅"
        : "⚠ ";
    console.log(
      `  ${flagg} ${t.padEnd(12)} faktisk ${faktisk}, forventet ~${f}, diff ${diff >= 0 ? "+" : ""}${diff}`
    );
    if (
      (t === "ukjent" && faktisk > 0) ||
      (t !== "ukjent" && Math.abs(diff) > 3)
    ) {
      avvik.push(`${t}: forventet ~${f}, fikk ${faktisk}`);
    }
  }

  if (ukjentEntries.length > 0) {
    console.log(`\nUkjent-tilfeller (${ukjentEntries.length}):`);
    for (const u of ukjentEntries) {
      console.log(
        `  ${u.isin}  fullt="${u.fullt_navn}"  tick="${u.tick_navn}"`
      );
    }
  }

  if (kunIFil1.length > 0) {
    console.log(`\nKun i uten-ticker-fil (${kunIFil1.length}):`);
    for (const x of kunIFil1) console.log(`  ${x.isin}  "${x.navn}"`);
  }
  if (kunIFil2.length > 0) {
    console.log(`\nKun i med-ticker-fil (${kunIFil2.length}):`);
    for (const x of kunIFil2) console.log(`  ${x.isin}  "${x.navn}"`);
  }
  if (isinMedFlereNavnFil1.length > 0) {
    console.log(
      `\nEdge case — ISIN med flere navn i uten-ticker-fil (${isinMedFlereNavnFil1.length}):`
    );
    for (const x of isinMedFlereNavnFil1) {
      console.log(`  ${x.isin}  ${x.navn.map((n) => `"${n}"`).join(", ")}`);
    }
  }
  if (isinMedFlereNavnFil2.length > 0) {
    console.log(
      `\nEdge case — ISIN med flere navn i med-ticker-fil (${isinMedFlereNavnFil2.length}):`
    );
    for (const x of isinMedFlereNavnFil2) {
      console.log(`  ${x.isin}  ${x.navn.map((n) => `"${n}"`).join(", ")}`);
    }
  }

  if (avvik.length > 0) {
    console.log(`\n⚠  AVVIK MOT FORVENTET — vurder ekte bug:`);
    for (const a of avvik) console.log(`  ${a}`);
  }

  console.log("\nFerdig.");
}

main().catch((e) => {
  console.error("Uventet feil:", e);
  process.exit(1);
});
