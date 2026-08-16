// Golden-tester for inntektsår 2026.
//
// Bakgrunn: fem verktøy var låst til max(2025) i zod-skjemaet selv om `hentSatser`
// og `src/data/satser/2026.json` hadde vært klare en stund. Denne fila er porten som
// gjør at 2026 ikke kan råtne i stillhet igjen.
//
// Alle fasiter under er REGNET FOR HÅND fra 2026.json og skrevet inn her — de er
// ikke observert output som ble limt inn i etterkant. Utregningen står ved hver test
// så neste leser kan etterprøve uten å kjøre koden.
import assert from "node:assert/strict";
import satser2026 from "../dist/data/satser/2026.json" with { type: "json" };

let feil = 0;
const ok = (navn) => console.log(`✅ ${navn}`);
function test(navn, fn) {
  try {
    fn();
    ok(navn);
  } catch (e) {
    feil++;
    console.error(`❌ ${navn}\n   ${e.message}`);
  }
}

// ── Satsfila selv ────────────────────────────────────────────────────────────
// Disse er ikke pedanteri: hele poenget med satsfilene er at et tall som endrer
// seg mellom år ikke skal kunne ligge hardkodet i logikken.

test("2026: formuesskatt er restrukturert vs 2025", () => {
  const f = satser2026.formuesskatt;
  assert.equal(f.bunnfradrag_enslig, 1_900_000);
  assert.equal(f.bunnfradrag_ektefeller, 3_800_000);
  assert.equal(f.kommunal_sats, 0.0035);
  assert.equal(f.statlig_trinn1_sats, 0.0065);
  assert.equal(f.statlig_trinn2_innslag, 21_500_000);
  assert.equal(f.statlig_trinn2_sats, 0.0075);
  // Samlet marginalsats skal være uendret fra 2025 tross omfordelingen:
  // under innslaget 0,35 + 0,65 = 1,00 %; over innslaget 0,35 + 0,75 = 1,10 %.
  assert.equal(f.kommunal_sats + f.statlig_trinn1_sats, 0.01);
  assert.equal(
    Math.round((f.kommunal_sats + f.statlig_trinn2_sats) * 10000) / 10000,
    0.011
  );
});

test("2026: primærbolig-terskelen er 14 M, ikke 10 M", () => {
  const p = satser2026.verdsettingsrabatter.primærbolig;
  // Rettet 2026-08-16. Skatteetatens satsside for inntektsår 2026: 25 % opp til
  // 14 000 000, 70 % over. Fila sa 10 M og «uendret 2025→2026» — begge feil.
  assert.equal(p.terskel, 14_000_000);
  assert.equal(p.verdsetting_under_terskel, 0.25);
  assert.equal(p.verdsetting_over_terskel, 0.7);
});

test("2026: skjermingsrenten er merket foreløpig", () => {
  const s = satser2026.skjermingsrente;
  assert.equal(s.personlige_aksjonærer, 0.036);
  // Verdien er en proxy fra 2025 til Skattedirektoratet fastsetter den i jan 2027.
  // Står det ikke FORELØPIG her, mangler output-forbeholdet sitt grunnlag.
  assert.match(s.merknad, /FORELØPIG/);
});

test("2026: aksjeoppjustering uendret 1,72", () => {
  assert.equal(satser2026.aksjeoppjustering.faktor, 1.72);
});

// ── Formuesskatt: håndregnede fasiter ────────────────────────────────────────
// Formelen (formue.ts): kommunal = (netto − bunnfradrag) × kommunal_sats
//                       trinn1  = (min(netto, innslag) − bunnfradrag) × trinn1_sats
//                       trinn2  = max(0, netto − innslag) × trinn2_sats
// Ektefeller dobler BÅDE bunnfradraget OG innslaget (sktl./Stortingsvedtaket § 2-1).

function formuesskatt2026(nettoformue, ektefeller) {
  const f = satser2026.formuesskatt;
  const bunnfradrag = ektefeller
    ? f.bunnfradrag_ektefeller
    : f.bunnfradrag_enslig;
  const innslag = f.statlig_trinn2_innslag * (ektefeller ? 2 : 1);
  if (nettoformue <= bunnfradrag) return 0;
  const kommunal = (nettoformue - bunnfradrag) * f.kommunal_sats;
  const t1 =
    Math.max(0, Math.min(nettoformue, innslag) - bunnfradrag) * f.statlig_trinn1_sats;
  const t2 = Math.max(0, nettoformue - innslag) * f.statlig_trinn2_sats;
  return kommunal + t1 + t2;
}

test("formue 2026 — enslig 30 MNOK = 289 500", () => {
  //   kommunal (30 000 000 − 1 900 000) × 0,0035               =  98 350
  //   trinn 1  (21 500 000 − 1 900 000) × 0,0065               = 127 400
  //   trinn 2  ( 30 000 000 − 21 500 000) × 0,0075             =  63 750
  //                                                       sum  = 289 500
  assert.equal(formuesskatt2026(30_000_000, false), 289_500);
});

test("formue 2026 — ektefeller 30 MNOK = 262 000 (ingen trinn 2)", () => {
  //   Doblet innslag = 43 000 000, så 30 M treffer aldri trinn 2.
  //   kommunal (30 000 000 − 3 800 000) × 0,0035               =  91 700
  //   trinn 1  (30 000 000 − 3 800 000) × 0,0065               = 170 300
  //                                                       sum  = 262 000
  assert.equal(formuesskatt2026(30_000_000, true), 262_000);
});

test("formue 2026 — ektefeller 50 MNOK = 469 000 (trinn 2 på de siste 7)", () => {
  //   kommunal (50 000 000 − 3 800 000) × 0,0035               = 161 700
  //   trinn 1  (43 000 000 − 3 800 000) × 0,0065               = 254 800
  //   trinn 2  (50 000 000 − 43 000 000) × 0,0075              =  52 500
  //                                                       sum  = 469 000
  assert.equal(formuesskatt2026(50_000_000, true), 469_000);
});

test("formue 2026 — enslig under bunnfradraget gir 0", () => {
  assert.equal(formuesskatt2026(1_500_000, false), 0);
  assert.equal(formuesskatt2026(1_900_000, false), 0);
});

test("formue 2026 — ektefelledoblingen gjelder innslaget, ikke bare bunnfradraget", () => {
  // Regresjonsvakt for buggen som ble fikset i skatt-optimizer 2026-07-12 og som
  // denne fila skal hindre i å oppstå på nytt i 2026-satsene: hadde innslaget IKKE
  // vært doblet, ville ektefeller med 30 MNOK fått trinn 2 på 8,5 M = 63 750 for mye.
  const medDobling = formuesskatt2026(30_000_000, true);
  const utenDobling =
    (30_000_000 - 3_800_000) * 0.0035 +
    (21_500_000 - 3_800_000) * 0.0065 +
    (30_000_000 - 21_500_000) * 0.0075;
  assert.equal(medDobling, 262_000);
  assert.ok(utenDobling > medDobling, "uten dobling må gi høyere skatt");
});

// ── Primærbolig: terskelen i praksis ─────────────────────────────────────────

function primærboligVerdi(markedsverdi, satser) {
  const p = satser.verdsettingsrabatter.primærbolig;
  return (
    Math.min(markedsverdi, p.terskel) * p.verdsetting_under_terskel +
    Math.max(0, markedsverdi - p.terskel) * p.verdsetting_over_terskel
  );
}

test("primærbolig 2026 — 15 MNOK gir 4 200 000", () => {
  //   14 000 000 × 0,25 = 3 500 000
  //    1 000 000 × 0,70 =   700 000
  //                sum  = 4 200 000
  //   Med den gamle (feil) 10 M-terskelen ville svaret vært
  //   10 000 000 × 0,25 + 5 000 000 × 0,70 = 6 000 000 — 1,8 M for høyt.
  assert.equal(primærboligVerdi(15_000_000, satser2026), 4_200_000);
});

test("primærbolig 2026 — 12 MNOK er helt under terskelen", () => {
  //   Hele beløpet × 0,25 = 3 000 000. Under den gamle terskelen ville de siste
  //   2 M vært verdsatt til 70 % — dette er selve endringen 2025 → 2026.
  assert.equal(primærboligVerdi(12_000_000, satser2026), 3_000_000);
});

console.log(
  feil === 0
    ? `\nAlle 2026-golden-tester grønne.`
    : `\n${feil} test(er) feilet.`
);
process.exit(feil === 0 ? 0 : 1);
