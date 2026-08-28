// Grensetest for fondsklassifisering etter aksjeandel — skatteloven § 10-20 (2).
//
// Loven er skrevet med STRENGE ulikheter:
//
//   «Utdeling fra verdipapirfond med mer enn 80 prosent aksjeandel skattlegges
//    som aksjeutbytte.»
//   «Utdeling fra verdipapirfond med mindre enn 20 prosent aksjeandel
//    skattlegges som renteinntekt.»
//   — skatteloven § 10-20 (2) bokstav a og b, lest 2026-08-28
//
// Skatteetaten sier det samme ordrett («Beskatning av andeler i verdipapirfond»,
// lest 2026-08-28): mer enn 80 prosent → aksjeutbytte, mindre enn 20 prosent →
// renteinntekt, «mellom 20 prosent og 80 prosent» → splittes.
//
// Konsekvensen er at nøyaktig 80,0 og nøyaktig 20,0 hører hjemme i
// mellomsjiktet, ikke i ytterkantene. `fondsLabel()` brukte `>=` og `<=` og
// plasserte dem feil. Testen låser grensene fast i BEGGE retninger: at
// randverdiene faller i midten, OG at verdier så vidt utenfor fortsatt faller ut
// slik de alltid har gjort (så en overkorreksjon også blir rød).
//
// Stopper med exit 1 ved første avvik.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { beregnPerIsin } from "../dist/tools/fond.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const SATSER = JSON.parse(
  readFileSync(join(repoRoot, "src", "data", "satser", "2025.json"), "utf-8")
);
const SKJERMINGSRENTE = SATSER.skjermingsrente.personlige_aksjonærer;
const OPPJUSTERING = SATSER.aksjeoppjustering.faktor;

const ÅR = 2025;
const ISIN = "NO0000000001"; // syntetisk, aldri i konfigfila

// Kjører den ekte kodestien (beregnPerIsin → fondsLabel) med en syntetisk
// klassifisering, så testen treffer produksjonslogikken og ikke en kopi.
function labelFor(aksjeandel, { medSalg }) {
  const trans = [
    {
      isin: ISIN,
      type: "kjøp",
      dato: `${ÅR}-01-02`,
      antall: 100,
      pris_per_andel: 100,
      tegnings_innloesningsgebyr: 0,
    },
  ];
  if (medSalg) {
    // Salg med gevinst, så labelSnitt regnes av vektet aksjedel/gevinst
    // i stedet for av konfigverdien direkte. Kjøp og salg samme år gir
    // snitt = (aksjeandel + aksjeandel) / 2 = aksjeandel.
    trans.push({
      isin: ISIN,
      type: "salg",
      dato: `${ÅR}-11-03`,
      antall: 100,
      pris_per_andel: 130,
      tegnings_innloesningsgebyr: 0,
    });
  }
  return beregnPerIsin({
    isin: ISIN,
    trans,
    inngangs_carry: 0,
    rapporteringsår: ÅR,
    skjermingsrente: SKJERMINGSRENTE,
    oppjusteringsfaktor: OPPJUSTERING,
    override_klass: {
      navn: `Grensetest ${aksjeandel}`,
      type: "kombinasjonsfond",
      aksjeandel_per_år: { [String(ÅR)]: aksjeandel },
    },
  }).fondslabel;
}

// [aksjeandel, forventet label, hvorfor]
const CASES = [
  // ── Randverdiene: hele poenget med testen ──────────────────────────────
  [0.8, "kombinasjonsfond", "nøyaktig 80,0 % er IKKE «mer enn 80 %» (§ 10-20 (2) a)"],
  [0.2, "kombinasjonsfond", "nøyaktig 20,0 % er IKKE «mindre enn 20 %» (§ 10-20 (2) b)"],

  // ── Så vidt utenfor: skal fortsatt falle ut, ellers er fiksen for bred ──
  [0.8 + Number.EPSILON, "aksjefond", "så vidt over 80 % er «mer enn 80 %»"],
  [0.2 - Number.EPSILON, "rentefond", "så vidt under 20 % er «mindre enn 20 %»"],

  // ── Uendret oppførsel utenfor randen (regresjonsvakt) ──────────────────
  [1.0, "aksjefond", "rent aksjefond"],
  [0.9, "aksjefond", "godt over grensen"],
  [0.8001, "aksjefond", "like over grensen"],
  [0.7999, "kombinasjonsfond", "like under øvre grense"],
  [0.5, "kombinasjonsfond", "midt i mellomsjiktet"],
  [0.2001, "kombinasjonsfond", "like over nedre grense"],
  [0.1999, "rentefond", "like under nedre grense"],
  [0.1, "rentefond", "godt under grensen"],
  [0.0, "rentefond", "rent rentefond"],
];

let kjørt = 0;
let feil = 0;

for (const medSalg of [false, true]) {
  const sti = medSalg ? "med salg (label fra vektet salgssnitt)" : "uten salg (label fra konfig)";
  for (const [andel, forventet, hvorfor] of CASES) {
    kjørt++;
    let faktisk;
    try {
      faktisk = labelFor(andel, { medSalg });
    } catch (e) {
      feil++;
      console.error(`✗ [${sti}] aksjeandel ${andel}: kastet — ${e.message}`);
      continue;
    }
    if (faktisk !== forventet) {
      feil++;
      console.error(
        `✗ [${sti}] aksjeandel ${andel}: fikk "${faktisk}", forventet ` +
          `"${forventet}" — ${hvorfor}`
      );
    }
  }
}

// Randverdiene endrer ETIKETTEN, ikke skatten: den proporsjonale splitten
// styres av `hentAksjeandel` (konfig), ikke av `fondsLabel`. Denne asserten
// låser den avgrensningen fast, så en framtidig «fiks» som lar etiketten
// styre matten blir rød her.
{
  kjørt++;
  const r = beregnPerIsin({
    isin: ISIN,
    trans: [
      { isin: ISIN, type: "kjøp", dato: `${ÅR}-01-02`, antall: 100, pris_per_andel: 100, tegnings_innloesningsgebyr: 0 },
      { isin: ISIN, type: "salg", dato: `${ÅR}-11-03`, antall: 100, pris_per_andel: 130, tegnings_innloesningsgebyr: 0 },
    ],
    inngangs_carry: 0,
    rapporteringsår: ÅR,
    skjermingsrente: SKJERMINGSRENTE,
    oppjusteringsfaktor: OPPJUSTERING,
    override_klass: {
      navn: "Grensetest 0.8 — splitt",
      type: "kombinasjonsfond",
      aksjeandel_per_år: { [String(ÅR)]: 0.8 },
    },
  });
  const s = r.salg_i_år[0];
  const gevinst = s.gevinst;
  const forventetAksjedel = gevinst * 0.8;
  const forventetRentedel = gevinst * 0.2;
  const nær = (a, b) => Math.abs(a - b) < 1e-9;
  if (!nær(s.aksjedel, forventetAksjedel) || !nær(s.rentedel, forventetRentedel)) {
    feil++;
    console.error(
      `✗ ved nøyaktig 80 % skal splitten fortsatt være proporsjonal: ` +
        `aksjedel ${s.aksjedel} (forventet ${forventetAksjedel}), ` +
        `rentedel ${s.rentedel} (forventet ${forventetRentedel})`
    );
  }
}

if (feil > 0) {
  console.error(`\ntest-fond-grenser: ${feil} av ${kjørt} sjekker FEILET`);
  process.exit(1);
}
console.log(`test-fond-grenser: ${kjørt} sjekker OK (§ 10-20 (2) strenge ulikheter)`);
process.exit(0);
