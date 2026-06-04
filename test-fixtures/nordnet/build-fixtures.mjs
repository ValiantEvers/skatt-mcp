// Bygger de seks Nordnet test-fixturene fra strukturerte rad-objekter.
// Skriver UTF-8 .csv-filer (uten BOM) — parseren stripper BOM internt og
// håndterer UTF-8 like greit som UTF-16 etter dekoding.
//
// Kjør: node test-fixtures/nordnet/build-fixtures.mjs

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const HEADER = [
  "Id", "Bokføringsdag", "Handelsdag", "Oppgjørsdag", "Portefølje",
  "Transaksjonstype", "Verdipapir", "ISIN", "Antall", "Kurs",
  "Rente", "Totale Avgifter", "Valuta", "Beløp", "Valuta",
  "Kjøpsverdi", "Valuta", "Resultat", "Valuta", "Totalt antall",
  "Saldo", "Vekslingskurs", "Transaksjonstekst", "Makuleringsdato", "Sluttseddelnummer",
  "Verifikationsnummer", "Kurtasje", "Valuta", "Valutakurs", "Innledende rente",
];

// Mapper indeks i HEADER til navn — for tydelig rad-konstruksjon
const KOL = Object.fromEntries(HEADER.map((_, i) => [
  ["id","bokf","handel","oppgj","portef","type","verdipapir","isin",
   "antall","kurs","rente","totAvg","valAvg","beløp","valBeløp",
   "kjøpsv","valKjøpsv","resultat","valRes","totalt",
   "saldo","veksl","tekst","mak","sluttsed","verifik",
   "kurtasje","valKurt","valkurs","innledRente"][i], i
]));

function bygg(rad) {
  const arr = new Array(HEADER.length).fill("");
  for (const [navn, idx] of Object.entries(KOL)) {
    if (rad[navn] !== undefined) arr[idx] = String(rad[navn]);
  }
  return arr.join("\t");
}

function fil(navn, rader) {
  const linjer = [HEADER.join("\t"), ...rader.map(bygg)];
  const innhold = linjer.join("\r\n") + "\r\n";
  writeFileSync(join(__dirname, navn), innhold, "utf-8");
  console.log(`Skrev ${navn} (${rader.length} datarader)`);
}

// Felt-formatering: norsk komma som desimal
const k = (n) => String(n).replace(".", ",");

// ============================================================
// Fixture 1: Ren NOK — 2 KJØPT + 1 SALG av Equinor
// Forventet etter parsing: 3 transaksjoner, 0 hoppet over
// Forventet kostbase ved FIFO:
//   Lot1: 100 @ 280, kurtasje 29 → kostpris/aksje = 280,29
//   Lot2: 50 @ 310, kurtasje 29 → kostpris/aksje = 310,58
//   Salg 100: konsumerer hele lot1, kostbase = 28029
//   salgssumNetto = 100*340 - 29 = 33971
//   gevinst = 33971 - 28029 = 5942
// ============================================================
fil("fixture-1-ren-nok.csv", [
  { id: 1001, bokf: "2025-01-15", handel: "2025-01-15", oppgj: "2025-01-17",
    portef: 999, type: "KJØPT", verdipapir: "Equinor", isin: "NO0010096985",
    antall: 100, kurs: 280, totAvg: 29, valAvg: "NOK", beløp: -28029, valBeløp: "NOK",
    kjøpsv: 28000, valKjøpsv: "NOK", resultat: 0, valRes: "NOK",
    totalt: 100, saldo: 0, veksl: 1, tekst: "Kjøp Equinor",
    sluttsed: "A001", verifik: "A002", kurtasje: 29, valKurt: "NOK", valkurs: 1, innledRente: 0 },
  { id: 1002, bokf: "2025-03-20", handel: "2025-03-20", oppgj: "2025-03-22",
    portef: 999, type: "KJØPT", verdipapir: "Equinor", isin: "NO0010096985",
    antall: 50, kurs: 310, totAvg: 29, valAvg: "NOK", beløp: -15529, valBeløp: "NOK",
    kjøpsv: 15500, valKjøpsv: "NOK", resultat: 0, valRes: "NOK",
    totalt: 150, saldo: 0, veksl: 1, tekst: "Kjøp Equinor",
    sluttsed: "A003", verifik: "A004", kurtasje: 29, valKurt: "NOK", valkurs: 1, innledRente: 0 },
  { id: 1003, bokf: "2025-09-15", handel: "2025-09-15", oppgj: "2025-09-17",
    portef: 999, type: "SALG", verdipapir: "Equinor", isin: "NO0010096985",
    antall: 100, kurs: 340, totAvg: 29, valAvg: "NOK", beløp: 33971, valBeløp: "NOK",
    kjøpsv: "", valKjøpsv: "NOK", resultat: 5942, valRes: "NOK",
    totalt: 50, saldo: 0, veksl: 1, tekst: "Salg Equinor",
    sluttsed: "A005", verifik: "A006", kurtasje: 29, valKurt: "NOK", valkurs: 1, innledRente: 0 },
]);

// ============================================================
// Fixture 2: Utenlandsk valuta (USD)
// Verifiserer at NOK-pris derives korrekt fra Beløp (Nordnets egen FX-konvertering)
// KJØPT 10 aksjer @ $200, vekslingskurs ~11.15, kurtasje 29 NOK
//   Beløp = -22329 NOK ⇒ pris/aksje (NOK) = (22329-29)/10 = 2230
// SALG 10 aksjer @ $220, vekslingskurs ~11.27, kurtasje 29 NOK
//   Beløp = 24811 NOK ⇒ pris/aksje (NOK) = (24811+29)/10 = 2484
// ============================================================
fil("fixture-2-utenlandsk-usd.csv", [
  { id: 2001, bokf: "2025-02-10", handel: "2025-02-10", oppgj: "2025-02-12",
    portef: 999, type: "KJØPT", verdipapir: "Apple Inc", isin: "US0378331005",
    antall: 10, kurs: 200, totAvg: 29, valAvg: "NOK", beløp: -22329, valBeløp: "NOK",
    kjøpsv: 2000, valKjøpsv: "USD", resultat: 0, valRes: "USD",
    totalt: 10, saldo: 0, veksl: k(11.15), tekst: "Kjøp Apple",
    sluttsed: "B001", verifik: "B002", kurtasje: 29, valKurt: "NOK", valkurs: 1, innledRente: 0 },
  { id: 2002, bokf: "2025-08-15", handel: "2025-08-15", oppgj: "2025-08-17",
    portef: 999, type: "SALG", verdipapir: "Apple Inc", isin: "US0378331005",
    antall: 10, kurs: 220, totAvg: 29, valAvg: "NOK", beløp: 24811, valBeløp: "NOK",
    kjøpsv: "", valKjøpsv: "USD", resultat: 400, valRes: "USD",
    totalt: 0, saldo: 0, veksl: k(11.29), tekst: "Salg Apple",
    sluttsed: "B003", verifik: "B004", kurtasje: 29, valKurt: "NOK", valkurs: 1, innledRente: 0 },
]);

// ============================================================
// Fixture 3: Skip-bare rad-typer
// 1 KJØPT (skal med) + UTBYTTE + INNSKUDD + PLATTFORMAVGIFT + KUPONGSKATT (alle skip)
// Forventet: 1 transaksjon, 4 hoppet over
// ============================================================
fil("fixture-3-skip-typer.csv", [
  { id: 3001, bokf: "2025-01-15", handel: "2025-01-15", oppgj: "2025-01-17",
    portef: 999, type: "KJØPT", verdipapir: "Equinor", isin: "NO0010096985",
    antall: 100, kurs: 280, totAvg: 29, valAvg: "NOK", beløp: -28029, valBeløp: "NOK",
    kjøpsv: 28000, valKjøpsv: "NOK", resultat: 0, valRes: "NOK",
    totalt: 100, saldo: 0, veksl: 1, tekst: "Kjøp Equinor",
    sluttsed: "C001", verifik: "C002", kurtasje: 29, valKurt: "NOK", valkurs: 1, innledRente: 0 },
  { id: 3002, bokf: "2025-04-10", handel: "2025-04-10", oppgj: "2025-04-12",
    portef: 999, type: "UTBYTTE", verdipapir: "Equinor", isin: "NO0010096985",
    antall: 100, kurs: 8, beløp: 800, valBeløp: "NOK",
    totalt: 100, saldo: 5800, veksl: 1, tekst: "UTBYTTE EQNR 8 NOK/AKSJE",
    sluttsed: "C003", verifik: "C004" },
  { id: 3003, bokf: "2025-05-01", handel: "2025-05-01", oppgj: "2025-05-03",
    portef: 999, type: "INNSKUDD",
    beløp: 100000, valBeløp: "NOK",
    totalt: 0, saldo: 100000, veksl: 1, tekst: "Bankinnskudd",
    sluttsed: "C005", verifik: "C006" },
  { id: 3004, bokf: "2025-06-01", handel: "2025-06-01", oppgj: "2025-06-03",
    portef: 999, type: "PLATTFORMAVGIFT",
    beløp: -15, valBeløp: "NOK",
    totalt: 0, saldo: 99985, veksl: 1, tekst: "Plattformavgift",
    sluttsed: "C007", verifik: "C008" },
  { id: 3005, bokf: "2025-07-15", handel: "2025-07-15", oppgj: "2025-07-17",
    portef: 999, type: "KUPONGSKATT",
    beløp: -100, valBeløp: "NOK",
    totalt: 0, saldo: 99885, veksl: 1, tekst: "Kildeskatt utland",
    sluttsed: "C009", verifik: "C010" },
]);

// ============================================================
// Fixture 4: Corporate actions
// 1 KJØPT (med) + BYTTE INNLEGG VP + SPLITT UTTAK VP + REINVESTERT UTBYTTE (alle skip med
// klar grunn-tekst som forklarer hva brukeren må gjøre manuelt)
// Forventet: 1 transaksjon, 3 hoppet over
// ============================================================
fil("fixture-4-corporate-actions.csv", [
  { id: 4001, bokf: "2025-01-15", handel: "2025-01-15", oppgj: "2025-01-17",
    portef: 999, type: "KJØPT", verdipapir: "Kongsberg Automotive", isin: "NO0003035305",
    antall: 1000, kurs: 5, totAvg: 29, valAvg: "NOK", beløp: -5029, valBeløp: "NOK",
    kjøpsv: 5000, valKjøpsv: "NOK", resultat: 0, valRes: "NOK",
    totalt: 1000, saldo: 0, veksl: 1, tekst: "Kjøp KOA",
    sluttsed: "D001", verifik: "D002", kurtasje: 29, valKurt: "NOK", valkurs: 1, innledRente: 0 },
  { id: 4002, bokf: "2025-02-03", handel: "2025-02-03", oppgj: "2025-02-05",
    portef: 999, type: "SPLITT UTTAK VP", verdipapir: "Kongsberg Automotive", isin: "NO0003035305",
    antall: 1000, kurs: 0, beløp: 0, valBeløp: "NOK", veksl: "",
    tekst: "Splitt 10 KOA til 1 KOA",
    sluttsed: "D003", verifik: "D004" },
  { id: 4003, bokf: "2025-03-01", handel: "2025-03-01", oppgj: "2025-03-03",
    portef: 999, type: "BYTTE INNLEGG VP", verdipapir: "ODIN Global D NOK", isin: "NO0010876097",
    antall: k(9.8998), kurs: "", beløp: 0, valBeløp: "NOK",
    kjøpsv: 2000, valKjøpsv: "NOK", veksl: "",
    tekst: "Andelsklassbyte Odin - Ratio: 1;1,797720728",
    sluttsed: "D005", verifik: "D006" },
  { id: 4004, bokf: "2025-04-15", handel: "2025-04-15", oppgj: "2025-04-17",
    portef: 999, type: "REINVESTERT UTBYTTE", verdipapir: "Equinor", isin: "NO0010096985",
    antall: 5, kurs: 280, beløp: 0, valBeløp: "NOK",
    veksl: 1, tekst: "DRIP",
    sluttsed: "D007", verifik: "D008" },
]);

// ============================================================
// Fixture 5: INNLEGG OVERFØRING
// 1 OVERFØRING (NOK Kjøpsverdi → syntetisk kjøp) + 1 senere SALG av samme aksje
// Forventet: 2 transaksjoner, 0 hoppet over
// Overføring: Antall=50, Kjøpsverdi=12500 NOK ⇒ pris/aksje = 250, kurtasje=0
// Salg: 50 @ 290, kurtasje 29 → Beløp = 14471, gevinst etter FIFO = 14471 - 12500 = 1971
// ============================================================
fil("fixture-5-overforing.csv", [
  { id: 5001, bokf: "2024-11-28", handel: "2024-11-28", oppgj: "2024-11-30",
    portef: 999, type: "INNLEGG OVERFØRING", verdipapir: "DNB", isin: "NO0010031479",
    antall: 50, kurs: 250, beløp: 0, valBeløp: "NOK",
    kjøpsv: 12500, valKjøpsv: "NOK", resultat: 0, valRes: "NOK",
    totalt: 50, saldo: 0, veksl: "", tekst: "Overføring fra DNB Markets",
    sluttsed: "E001", verifik: "E002", kurtasje: 0, valKurt: "NOK", valkurs: 1, innledRente: 0 },
  { id: 5002, bokf: "2025-09-15", handel: "2025-09-15", oppgj: "2025-09-17",
    portef: 999, type: "SALG", verdipapir: "DNB", isin: "NO0010031479",
    antall: 50, kurs: 290, totAvg: 29, valAvg: "NOK", beløp: 14471, valBeløp: "NOK",
    kjøpsv: "", valKjøpsv: "NOK", resultat: 1971, valRes: "NOK",
    totalt: 0, saldo: 0, veksl: 1, tekst: "Salg DNB",
    sluttsed: "E003", verifik: "E004", kurtasje: 29, valKurt: "NOK", valkurs: 1, innledRente: 0 },
]);

// ============================================================
// Fixture 6: Malformert
// To varianter: feil header (manglende kolonne) og rad med for få felt
// Skriver to filer for å teste begge feil-typer
// ============================================================
{
  const linjer = [
    ["Id","Bokføringsdag","Handelsdag","Transaksjonstype","Verdipapir"].join("\t"),
    ["6001","2025-01-15","2025-01-15","KJØPT","Equinor"].join("\t"),
  ];
  writeFileSync(
    join(__dirname, "fixture-6a-malformert-header.csv"),
    linjer.join("\r\n") + "\r\n",
    "utf-8"
  );
  console.log("Skrev fixture-6a-malformert-header.csv (feil header)");
}
{
  // Korrekt header, men én rad har for få felt
  const fullHeader = HEADER.join("\t");
  const gyldigRad = bygg({
    id: 6001, bokf: "2025-01-15", handel: "2025-01-15", oppgj: "2025-01-17",
    portef: 999, type: "KJØPT", verdipapir: "Equinor", isin: "NO0010096985",
    antall: 100, kurs: 280, totAvg: 29, valAvg: "NOK", beløp: -28029, valBeløp: "NOK",
    kjøpsv: 28000, valKjøpsv: "NOK", resultat: 0, valRes: "NOK",
    totalt: 100, saldo: 0, veksl: 1, tekst: "Kjøp Equinor",
    sluttsed: "F001", verifik: "F002", kurtasje: 29, valKurt: "NOK", valkurs: 1, innledRente: 0,
  });
  const trunkertRad = "6002\t2025-02-15\tEquinor"; // bare 3 felt
  const linjer = [fullHeader, gyldigRad, trunkertRad];
  writeFileSync(
    join(__dirname, "fixture-6b-trunkert-rad.csv"),
    linjer.join("\r\n") + "\r\n",
    "utf-8"
  );
  console.log("Skrev fixture-6b-trunkert-rad.csv (trunkert datasrad)");
}
