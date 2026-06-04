// Verifiserer alle 6 Nordnet-fixturene mot parseNordnetCsv-output.
// Kjør: node scripts/test-nordnet-parser.mjs
//
// Asserter på struktur, ikke på eksakte tall (de er dokumentert i fixture-builder).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parseNordnetCsv,
  NordnetCsvFeil,
} from "../dist/lib/csv-parsers/nordnet.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, "..", "test-fixtures", "nordnet");

let antallFeil = 0;
function assert(navn, betingelse, melding) {
  if (!betingelse) {
    console.error(`  ❌ ${navn}: ${melding}`);
    antallFeil++;
  } else {
    console.log(`  ✅ ${navn}`);
  }
}

function les(filnavn) {
  return readFileSync(join(fixtureDir, filnavn), "utf-8");
}

console.log("=== Fixture 1: Ren NOK (Equinor) ===");
{
  const r = parseNordnetCsv(les("fixture-1-ren-nok.csv"));
  assert("3 transaksjoner", r.transaksjoner.length === 3, `fant ${r.transaksjoner.length}`);
  assert("0 hoppet over", r.hoppet_over.length === 0, `fant ${r.hoppet_over.length}`);
  assert("2 kjøp + 1 salg", r.oppsummering.antall_kjøp === 2 && r.oppsummering.antall_salg === 1, "");
  assert("ticker = Equinor", r.transaksjoner.every((t) => t.ticker === "Equinor"), "");
  const lot1 = r.transaksjoner[0];
  assert("Lot1 pris = 280", lot1.pris_per_aksje === 280, `fant ${lot1.pris_per_aksje}`);
  assert("Lot1 kurtasje = 29", lot1.kurtasje === 29, `fant ${lot1.kurtasje}`);
  const salg = r.transaksjoner[2];
  assert("Salg pris = 340", salg.pris_per_aksje === 340, `fant ${salg.pris_per_aksje}`);
  assert("klassifisering aksje", r.klassifisering_hint["Equinor"] === "aksje", "");
  assert("valutaer = [NOK]", r.oppsummering.valutaer_native.length === 1 && r.oppsummering.valutaer_native[0] === "NOK", "");
  assert("periode 2025-01-15 → 2025-09-15", r.oppsummering.periode.fra === "2025-01-15" && r.oppsummering.periode.til === "2025-09-15", "");
}

console.log("\n=== Fixture 2: Utenlandsk valuta (USD) ===");
{
  const r = parseNordnetCsv(les("fixture-2-utenlandsk-usd.csv"));
  assert("2 transaksjoner", r.transaksjoner.length === 2, "");
  assert("0 hoppet over", r.hoppet_over.length === 0, "");
  const kjøp = r.transaksjoner[0];
  assert("KJØPT pris/aksje (NOK) = 2230", kjøp.pris_per_aksje === 2230, `fant ${kjøp.pris_per_aksje}`);
  const salg = r.transaksjoner[1];
  assert("SALG pris/aksje (NOK) = 2484", salg.pris_per_aksje === 2484, `fant ${salg.pris_per_aksje}`);
  assert("klassifisering aksje", r.klassifisering_hint["Apple Inc"] === "aksje", "");
  assert("valutaer inkluderer USD", r.oppsummering.valutaer_native.includes("USD"), "");
}

console.log("\n=== Fixture 3: Skip-bare typer ===");
{
  const r = parseNordnetCsv(les("fixture-3-skip-typer.csv"));
  assert("1 transaksjon", r.transaksjoner.length === 1, `fant ${r.transaksjoner.length}`);
  assert("4 hoppet over", r.hoppet_over.length === 4, `fant ${r.hoppet_over.length}`);
  const typer = new Set(r.hoppet_over.map((h) => h.transaksjonstype));
  assert("UTBYTTE hoppet over", typer.has("UTBYTTE"), "");
  assert("INNSKUDD hoppet over", typer.has("INNSKUDD"), "");
  assert("PLATTFORMAVGIFT hoppet over", typer.has("PLATTFORMAVGIFT"), "");
  assert("KUPONGSKATT hoppet over", typer.has("KUPONGSKATT"), "");
}

console.log("\n=== Fixture 4: Corporate actions ===");
{
  const r = parseNordnetCsv(les("fixture-4-corporate-actions.csv"));
  assert("1 transaksjon", r.transaksjoner.length === 1, `fant ${r.transaksjoner.length}`);
  assert("3 hoppet over", r.hoppet_over.length === 3, "");
  const splitt = r.hoppet_over.find((h) => h.transaksjonstype === "SPLITT UTTAK VP");
  assert(
    "SPLITT-grunn forklarer manuell oppfølging",
    splitt && /justeres i samsvar med splitt-forholdet/.test(splitt.grunn),
    splitt ? `grunn: ${splitt.grunn}` : "ingen splitt"
  );
  const bytte = r.hoppet_over.find((h) => h.transaksjonstype === "BYTTE INNLEGG VP");
  assert(
    "BYTTE-grunn forklarer manuell oppfølging",
    bytte && /manuelt justeres til ny ISIN\/andelsklasse/.test(bytte.grunn),
    bytte ? `grunn: ${bytte.grunn}` : "ingen bytte"
  );
  const drip = r.hoppet_over.find((h) => h.transaksjonstype === "REINVESTERT UTBYTTE");
  assert("REINVESTERT-grunn nevner manuell oppfølging", drip && /Manuell oppfølging/.test(drip.grunn), "");
}

console.log("\n=== Fixture 5: INNLEGG OVERFØRING ===");
{
  const r = parseNordnetCsv(les("fixture-5-overforing.csv"));
  assert("2 transaksjoner", r.transaksjoner.length === 2, `fant ${r.transaksjoner.length}`);
  assert("0 hoppet over", r.hoppet_over.length === 0, "");
  // Overføringen → syntetisk kjøp med kostbase = Kjøpsverdi/antall = 250
  const overføring = r.transaksjoner.find((t) => t.dato === "2024-11-28");
  assert("Overføring som kjøp", overføring && overføring.type === "kjøp", "");
  assert("Overføring pris/aksje = 250", overføring && overføring.pris_per_aksje === 250, `fant ${overføring?.pris_per_aksje}`);
  assert("Overføring kurtasje = 0", overføring && overføring.kurtasje === 0, "");
}

console.log("\n=== Fixture 6a: Malformert header ===");
{
  let kastet = false;
  try {
    parseNordnetCsv(les("fixture-6a-malformert-header.csv"));
  } catch (e) {
    kastet = true;
    assert("kaster NordnetCsvFeil", e instanceof NordnetCsvFeil, `fikk ${e?.constructor?.name}`);
    assert("feilmelding nevner header", /header|kolonne/i.test(e.message), `melding: ${e.message}`);
  }
  assert("eksception kastet", kastet, "ingen feil ble kastet");
}

console.log("\n=== Fixture 6b: Trunkert rad ===");
{
  let kastet = false;
  try {
    parseNordnetCsv(les("fixture-6b-trunkert-rad.csv"));
  } catch (e) {
    kastet = true;
    assert("kaster NordnetCsvFeil", e instanceof NordnetCsvFeil, `fikk ${e?.constructor?.name}`);
    assert("feilmelding nevner felt", /felt|kolonn/i.test(e.message), `melding: ${e.message}`);
    assert("feilmelding inkluderer linjenummer", /linje\s*3/.test(e.message), `melding: ${e.message}`);
  }
  assert("eksception kastet", kastet, "ingen feil ble kastet");
}

console.log("\n=== Resultat ===");
if (antallFeil > 0) {
  console.error(`${antallFeil} assertion(s) feilet`);
  process.exit(1);
}
console.log("Alle fixturer passerer.");
