// Regresjonstest for nye fond.ts (FIFO-/transaksjons-basert).
//
// Bakgrunn: ved A1-bytting (mai 2026) ble fond.ts erstattet med FIFO-basert
// implementasjon. På bytte-tidspunktet ble fixturene aksjefond-fullsalg og
// rentefond-fullsalg verifisert numerisk identisk mot dagens fond.ts via
// MD5-bit-sammenligning (full-salg-cases). Dette skriptet bevarer den
// identiteten som regresjon mot fremtidige endringer: tall i
// fixture.forventet er den "frosne" identitets-baseline.
//
// Stopper med exit 1 ved første avvik.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { beregnPerIsin } from "../dist/tools/fond.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const SATSER = JSON.parse(
  readFileSync(join(repoRoot, "src", "data", "satser", "2025.json"), "utf-8")
);
const SKJERMINGSRENTE = SATSER.skjermingsrente.personlige_aksjonærer;
const OPPJUSTERING = SATSER.aksjeoppjustering.faktor;

const FIXTUR_DIR = join(repoRoot, "test-fixtures", "fond");
function lastFixtur(filnavn) {
  return JSON.parse(readFileSync(join(FIXTUR_DIR, filnavn), "utf-8"));
}

function nyTilNumerisk(resultater) {
  let gevinst = 0,
    aksjedel = 0,
    rentedel = 0,
    brukt = 0,
    aksjeEtter = 0,
    oppjustert = 0,
    skattAksje = 0,
    skattRente = 0,
    bortfalt = 0;
  for (const r of resultater) {
    for (const s of r.salg_i_år) {
      gevinst += s.gevinst;
      aksjedel += s.aksjedel;
      rentedel += s.rentedel;
      aksjeEtter += s.aksjedel_etter_skjerming;
      oppjustert += s.oppjustert_aksjedel;
      skattAksje += s.skatt_aksjedel;
      skattRente += s.skatt_rentedel;
    }
    brukt += r.brukt_skjerming_total;
    bortfalt += r.bortfalt_skjerming;
  }
  return {
    gevinst,
    aksjedel,
    rentedel,
    brukt_skjerming: brukt,
    aksjedel_etter_skjerming: aksjeEtter,
    oppjustert_aksjedel: oppjustert,
    skatt_aksjedel: skattAksje,
    skatt_rentedel: skattRente,
    total_skatt: skattAksje + skattRente,
    bortfalt_skjerming: bortfalt,
  };
}

function kanoniser(obj) {
  const keys = Object.keys(obj).sort();
  const ut = {};
  for (const k of keys) {
    ut[k] = Math.round(obj[k] * 100) / 100;
  }
  return JSON.stringify(ut);
}

function md5(s) {
  return createHash("md5").update(s).digest("hex");
}

function nesten(a, b, eps = 0.01) {
  return Math.abs(a - b) <= eps;
}

function assertObjektMatch(navn, faktisk, forventet, eps = 0.01) {
  const feil = [];
  for (const k of Object.keys(forventet)) {
    if (faktisk[k] === undefined) {
      feil.push(`  ${k}: forventet ${forventet[k]}, fikk undefined`);
      continue;
    }
    if (!nesten(faktisk[k], forventet[k], eps)) {
      feil.push(`  ${k}: forventet ${forventet[k]}, fikk ${faktisk[k]}`);
    }
  }
  if (feil.length > 0) {
    console.error(`❌ ${navn} — avvik:`);
    for (const f of feil) console.error(f);
    return false;
  }
  console.log(`✅ ${navn}`);
  return true;
}

function kjørNy(fixtur) {
  const ny = fixtur.ny_input;
  const carryMap = new Map();
  for (const c of ny.inngangs_carry_per_isin ?? []) {
    carryMap.set(c.isin, c.akkumulert_ubrukt_skjerming_inngaaende);
  }
  const perIsin = new Map();
  for (const t of ny.transaksjoner) {
    const liste = perIsin.get(t.isin) ?? [];
    liste.push(t);
    perIsin.set(t.isin, liste);
  }
  const resultater = [];
  for (const [isin, tList] of perIsin) {
    resultater.push(
      beregnPerIsin({
        isin,
        trans: tList,
        inngangs_carry: carryMap.get(isin) ?? 0,
        rapporteringsår: ny.rapporteringsaar,
        skjermingsrente: SKJERMINGSRENTE,
        oppjusteringsfaktor: OPPJUSTERING,
        override_klass: fixtur.klassifisering,
      })
    );
  }
  return resultater;
}

const aksjefondFix = lastFixtur("aksjefond-fullsalg.json");
const rentefondFix = lastFixtur("rentefond-fullsalg.json");
const kombiFix = lastFixtur("kombinasjonsfond-toår.json");

let allesGreit = true;

// Identitets-baselines (frosset ved A1-bytting mot dagens fond.ts).
// Disse MD5-ene representerer det numeriske svaret dagens fond.ts gav for
// full-salg-cases. Hvis ny implementasjon avviker → regresjon mot identitet.
const BASELINE_MD5 = {
  aksjefond: "90dfb149e343b4657e77e30df98ac8b8",
  rentefond: "b193070afb26ffe056f68b0b9393a83a",
};

for (const [navn, fix, baseline] of [
  ["aksjefond", aksjefondFix, BASELINE_MD5.aksjefond],
  ["rentefond", rentefondFix, BASELINE_MD5.rentefond],
]) {
  console.log(`\n=== ${fix.navn} ===`);
  const res = kjørNy(fix);
  const tall = nyTilNumerisk(res);
  console.log("Ny fond.ts numerisk:", tall);
  allesGreit &= assertObjektMatch(`  Ny vs forventet (${navn})`, tall, fix.forventet);
  const m = md5(kanoniser(tall));
  console.log(`  MD5 ny:       ${m}`);
  console.log(`  MD5 baseline: ${baseline}`);
  if (m !== baseline) {
    console.error(
      `  ❌ MD5-avvik mot identitets-baseline — dagens fond.ts ville gitt andre tall`
    );
    allesGreit = false;
  } else {
    console.log("  ✅ MD5-identitet med baseline bekreftet");
  }
}

// Kombinasjon — ny logikk, ingen identitets-baseline (dagens fond.ts støtter
// ikke per-lot snittsaksjeandel).
console.log(`\n=== ${kombiFix.navn} ===`);
const nyKombiRes = kjørNy(kombiFix);
const nyKombiTall = nyTilNumerisk(nyKombiRes);
console.log("Ny fond.ts numerisk:", nyKombiTall);
const kombiFor = kombiFix.forventet;
allesGreit &= assertObjektMatch("  Ny vs forventet (kombinasjon)", nyKombiTall, {
  gevinst: kombiFor.gevinst,
  aksjedel: kombiFor.aksjedel,
  rentedel: kombiFor.rentedel,
  brukt_skjerming: kombiFor.brukt_skjerming,
  aksjedel_etter_skjerming: kombiFor.aksjedel_etter_skjerming,
  oppjustert_aksjedel: kombiFor.oppjustert_aksjedel,
  skatt_aksjedel: kombiFor.skatt_aksjedel,
  skatt_rentedel: kombiFor.skatt_rentedel,
  total_skatt: kombiFor.total_skatt,
  bortfalt_skjerming: kombiFor.bortfalt_skjerming,
});

const r3 = nyKombiRes[0];
const detaljOK =
  nesten(r3.årets_skjerming_beregnet, kombiFor.årets_skjerming_beregnet) &&
  nesten(r3.utgangs_carry, kombiFor.utgangs_carry) &&
  r3.gjenstående_lots.reduce((s, l) => s + l.antall_gjenstående, 0) ===
    kombiFor.gjenstående_andeler;
if (detaljOK) {
  console.log(
    `  ✅ Detaljer (årets skjerming ${Math.round(r3.årets_skjerming_beregnet)}, utgangs-carry ${Math.round(r3.utgangs_carry)}, gjenstående ${r3.gjenstående_lots.reduce((s, l) => s + l.antall_gjenstående, 0)} andeler)`
  );
} else {
  console.error("  ❌ Kombinasjon-detaljer avvik");
  allesGreit = false;
}

console.log("");
if (allesGreit) {
  console.log("✅ ALLE TESTER GRØNN");
  process.exit(0);
} else {
  console.error("❌ FEIL");
  process.exit(1);
}
