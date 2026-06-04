# A1 — calculate_aksjefond (FIFO/transaksjons-basert)

Designdokument. Ingen kode skrevet ennå.

Mål: erstatte dagens full-salg-baserte `calculate_aksjefond` med en FIFO-/transaksjons-basert variant som:
- Konsumerer transaksjons-array (samme form som `calculate_aksjegevinst`).
- Bruker `kjørFifo` fra `src/lib/fifo.ts` per ISIN.
- Slår opp type (aksje/aksjefond/rentefond/kombinasjon) og aksjeandel per år fra `src/data/fond-klassifisering.json`.
- Oppjusterer ×1,72 kun på aksjedel av gevinst/tap.
- Akkumulerer skjerming per ISIN per år med carry-forward.

---

## 1. Input-skjema for ny `calculate_aksjefond`

### Forslag

```typescript
const transaksjonSchema = z.object({
  isin: z.string().regex(/^[A-Z]{2}[A-Z0-9]{9}\d$/).describe("ISIN, 12 tegn"),
  navn: z.string().min(1).describe("Verdipapir-navn (for output, ikke nøkkel)"),
  type: z.enum(["kjøp", "salg"]),
  dato: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  antall: z.number().positive(),
  pris_per_andel: z.number().nonnegative(),
  tegnings_innløsningsgebyr: z.number().nonnegative().default(0),
});

// Per-ISIN skjermings-carry-forward fra forrige år
const carrySchema = z.object({
  isin: z.string(),
  akkumulert_ubrukt_skjerming_per_31_12_forrige_år: z.number().nonnegative(),
});

inputSchema: {
  transaksjoner: z.array(transaksjonSchema).min(1),
  skjerming_carry: z.array(carrySchema).default([]),
  rapporteringsår: z.number().int().min(2020).max(2025).default(2025),
}
```

Merknader:
- `isin` er den eneste pålitelige nøkkelen mot `fond-klassifisering.json`. Navnet er kun for menneskelig lesbarhet i output (Nordnet kan endre navn over tid, ISIN er stabil).
- `tegnings_innløsningsgebyr` mapper til `transaksjonsgebyr` i `FifoTransaksjon`. Fond har sjelden kurtasje (men har av og til tegningsgebyr/innløsningsgebyr).
- `rapporteringsår` følger samme mønster som `aksjer.ts` (`min(2020)` for FIFO-historikk utenfor rapporteringsår — også her for at akkumulering skal kunne strekke seg år tilbake).

### Hvilke linjer i dagens `src/tools/fond.ts` som erstattes

| Linje-spenn | Innhold | Hva skjer |
|-------------|---------|-----------|
| 1–11 | Imports og `hentSatser` | Beholdes, suppleres med `kjørFifo`-import fra `../lib/fifo.js` og JSON-import for klassifisering |
| 13–30 | `formaterKr`, `formaterKrDesimal`, `paragrafBlokk` | Beholdes uendret |
| 32–36 | `PARAGRAFER_FOND` | Beholdes (refID-listen er korrekt) |
| **38–277** | **Hele `registerFondVerktøy`-funksjonen** | **Erstattes** |

Estimert ny lengde på `registerFondVerktøy`: ~250–300 linjer (større fordi den må håndtere multi-fond, multi-salg, per-år-akkumulering).

---

## 2. Lookup-mønster mot `fond-klassifisering.json`

### Foreslått JSON-skjema (utvidet versjon av draft fra fase 1)

```json
{
  "NO0010732852": {
    "navn": "ODIN Global D NOK",
    "type": "aksjefond",
    "aksjeandel_per_år": {
      "2020": 1.00,
      "2021": 1.00,
      "...": 1.00
    }
  },
  "NO0010396838": {
    "navn": "DNB High Yield",
    "type": "rentefond",
    "aksjeandel_per_år": {
      "2020": 0.00,
      "...": 0.00
    }
  },
  "NO0010823958": {
    "navn": "Storebrand Kombinasjon",
    "type": "kombinasjonsfond",
    "aksjeandel_per_år": {
      "2020": 0.55,
      "2021": 0.58,
      "2022": 0.52,
      "2023": 0.54,
      "2024": 0.56,
      "2025": 0.57
    }
  },
  "NO0010096985": {
    "navn": "Equinor",
    "type": "aksje"
  }
}
```

### Lookup-funksjoner

```typescript
function hentKlassifisering(isin: string): FondKlassifisering {
  const entry = klassifisering[isin];
  if (!entry) {
    throw new Error(
      `ISIN ${isin} mangler i fond-klassifisering.json. ` +
      `Legg til entry før verktøyet kjøres. ` +
      `Forventet format: { type: "aksje|aksjefond|rentefond|kombinasjonsfond", aksjeandel_per_år: {...} }`
    );
  }
  return entry;
}

function hentAksjeandel(klass: FondKlassifisering, år: number): number {
  if (klass.type === "aksje") return 1.0;     // Aksjer = 100% aksjeandel
  if (klass.type === "aksjefond") return 1.0; // Konvensjon: aksjefond behandles som 100%
  if (klass.type === "rentefond") return 0.0;
  // kombinasjonsfond — krever per-år-data
  const verdi = klass.aksjeandel_per_år?.[String(år)];
  if (verdi === undefined) {
    throw new Error(
      `ISIN ${klass.isin} (${klass.navn}) er kombinasjonsfond men mangler ` +
      `aksjeandel_per_år["${år}"]. Fyll inn faktisk aksjeandel pr 1. januar ${år}.`
    );
  }
  return verdi;
}
```

### Feilmodus

- **ISIN ikke i config** → kast `Error` (per låst premiss: ingen stille fallback).
- **Kombinasjonsfond, manglende aksjeandel for et år** → kast `Error` med tydelig melding om hvilket år som mangler.
- **Type "aksje" i transaksjons-array** → verktøyet skal returnere feilmelding og foreslå at brukeren ruter til `calculate_aksjegevinst` i stedet. (Type-check ved input gjør at vi unngår å beregne aksjer som rentefond.)

---

## 3. FIFO-integrasjon

### Per-ISIN-gruppering og kall

```typescript
const perIsin = new Map<string, KanoniskFondTransaksjon[]>();
for (const t of transaksjoner) {
  const liste = perIsin.get(t.isin) ?? [];
  liste.push(t);
  perIsin.set(t.isin, liste);
}

for (const [isin, tList] of perIsin) {
  const klass = hentKlassifisering(isin);

  const fifoTrans: FifoTransaksjon[] = tList.map((t) => ({
    type: t.type,
    dato: t.dato,
    antall: t.antall,
    pris_per_enhet: t.pris_per_andel,
    transaksjonsgebyr: t.tegnings_innløsningsgebyr,
  }));

  const { lots, salg } = kjørFifo(fifoTrans, `${isin} (${klass.navn})`);
  // ...
}
```

### Per-salg-beregning — utfordring

`FifoSalgsResultat` gir én aggregert `kostbase` per salg, men flere FIFO-lots kan ha bidratt — hver med sitt eget ervervsår. Dette er avgjørende fordi § 10-20 (6) krever **gjennomsnitt av aksjeandel i ervervsåret og salgsåret per andel**, ikke per salgs-event.

Tre håndteringsalternativer:

a) **Utvide `lib/fifo.ts`** med per-lot-breakdown i salgsresultatet:
   ```typescript
   interface FifoSalgsResultat {
     // ... eksisterende felter
     delsalg: { fra_dato: string; antall: number; kostbase_del: number }[];
   }
   ```
   Additiv endring — aksjer/krypto kan ignorere `delsalg`. Anbefalt.

b) **Re-implementere FIFO i fond.ts** for å ha kontroll på per-lot-info. Bryter premissen om gjenbruk.

c) **Single-lot-restriksjon** — kun støtte 1 kjøp per ISIN. Praktisk ubrukelig for reelle data.

Anbefaling: **a)**. Den utvider lib uten å bryte eksisterende kallere. Linje-anslag: +20 linjer i `lib/fifo.ts`, ingen endring i `aksjer.ts`/`krypto.ts`. Se åpent spørsmål 1 nedenfor — endring i delt lib må godkjennes.

---

## 4. Skjerming — akkumulering med carry-forward

### Beregningsformel per § 10-20 (4) og § 10-12

For hver FIFO-lot per 31.12 i ett gitt år:
```
skjermingsgrunnlag_lot_år = lot.kostbase × aksjeandel_ervervsår_for_lot
årets_skjerming_lot      = skjermingsgrunnlag_lot_år × skjermingsrente_år
```

Aggregert per ISIN per år:
```
ny_akkumulering_per_isin = forrige_akkumulering_per_isin
                         + sum(årets_skjerming_lot)
                         - skjerming_brukt_på_salg_i_året
```

### Anvendelse ved salg

Per salg (sortert kronologisk innen året):
```
aksjedel_av_gevinst   = gevinst × snittsaksjeandel  // (kjøpsår + salgsår)/2 per lot
brukt_skjerming       = min(aksjedel_av_gevinst, tilgjengelig_akkumulering_for_isin)
aksjedel_etter_skjerming = aksjedel_av_gevinst − brukt_skjerming
```

Skjerming kan bare brukes mot **positiv aksjedel** (gevinst). Tap gir ikke skjerming-bruk; akkumuleringen forblir.

### 100% salg + senere gjenkjøp

Dagens fond.ts viser "bortfalt skjerming ved salg" når kostpris=0 og salgssum=0 i tom-posisjon-grenen. Det er en utstrekning av regelen i § 10-12: skjerming følger andelen, ikke skattyteren. Konkret oppførsel for ny implementasjon:

- Etter siste FIFO-lot avhendet (alle lots = 0 antall): all gjenværende akkumulert skjerming er bortfalt. Rapporter eksplisitt.
- Gjenkjøp etter full avhending: skaper ny FIFO-lot. Den får ny inngangsverdi, ny skjermingsgrunnlag fra null. Akkumulering starter på 0 fra og med året etter gjenkjøp.

### Tidsdimensjonen — flere år samtidig

Hvis input dekker 2020–2025 og rapporteringsår er 2025, må vi simulere skjerming-akkumulering år for år for å finne riktig start-state for rapporteringsåret. Dette skiller seg fra dagens flate input (én `akkumulert_ubrukt_skjerming`).

Alternativ: la `skjerming_carry`-arrayet i input dekke 31.12 forrige år (2024), og kjør bare rapporteringsåret. Krever at brukeren har carry-tall fra fjorårets selvangivelse — som man realistisk har siden dette uansett er en self-service-kalkulator.

**Anbefalt**: `skjerming_carry` for forrige år, beregn kun rapporteringsåret. Ikke simuler hele FIFO-historikken for skjerming-akkumulering. Dette samsvarer med hvordan `calculate_skjermingsfradrag` i aksjer.ts allerede gjør det.

---

## 5. Oppjustering ×1,72 — kun på aksjedelen av gevinst/tap

Per § 10-20 (6) siste setning: "*Bare den beregnede aksjeandelen oppjusteres etter § 10-11 første ledd annet punktum.*"

### Behandling per fondstype

| Fondstype | aksjedel | rentedel | Oppjustering |
|-----------|----------|----------|--------------|
| `aksjefond` | gevinst × 1,0 (konvensjon) | 0 | ×1,72 på aksjedel etter skjerming |
| `rentefond` | 0 | gevinst × 1,0 | Ingen |
| `kombinasjonsfond` | gevinst × snittsaksjeandel | gevinst × (1−snittsaksjeandel) | ×1,72 kun på aksjedel etter skjerming |

### Subtil forskjell fra dagens fond.ts

Dagens `calculate_aksjefond` (linje 142–155) behandler aksjefond som om **hele gevinsten** oppjusteres ×1,72. Det er en forenkling: hvis snittsaksjeandel = 0,85 for et "aksjefond" (snittsaksjeandel ≥ 0,80), så er strengt tatt 15 % av gevinsten rentedel som ikke skal oppjusteres.

For praktiske formål er forskjellen liten (de fleste aksjefond er 95–100 % aksjer), men design-spørsmål: skal A1 være **lov-strikt** (alltid bruke snittsaksjeandel) eller **dagens-kompatibel** (klassifisere først, deretter behandle som 100% / 0% / faktisk andel)?

**Anbefalt**: lov-strikt. Kombinasjonsfond med ekte 85 % aksjeandel skal behandles symmetrisk med 75 % aksjeandel — kun terskelen for hva som rapporteres som "type" i output endrer seg. Dette er også grunnen til at `aksjeandel_per_år` er nødvendig også for "aksjefond" (eller settes til 1,0 hvis ingen data).

Konsekvens for identitetstest (seksjon 8): dagens calculate_aksjefond gir identisk svar **bare hvis** input aksjeandel er nøyaktig 1,0 (aksjefond) eller 0,0 (rentefond). For ekte aksjeandel < 1,0 / > 0,0 vil ny implementasjon avvike — det er en **bevisst forbedring**, ikke en regresjon.

---

## 6. Tap-håndtering

Symmetrisk med gevinst:

```
hvis gevinst < 0:
  aksjedel_av_tap = gevinst × snittsaksjeandel  (negativt tall)
  rentedel_av_tap = gevinst × (1 − snittsaksjeandel)
  // Skjerming bortfaller IKKE ved tap — akkumulering forblir
  oppjustert_aksjedel_tap = aksjedel_av_tap × 1,72  (negativt)
  skattefradrag_aksjedel = oppjustert_aksjedel_tap × 0,22  (negativt)
  skattefradrag_rentedel = rentedel_av_tap × 0,22         (negativt)
```

Output rapporterer dette som "skattefradrag" (positivt beløp som reduserer skatt) i stedet for "skatt". Følger samme mønster som `calculate_aksjegevinst` for konsistens.

---

## 7. Aksjeandel-tidspunkt — verifisert mot lov

**Kilde: Lov om skatt av formue og inntekt (skatteloven) § 10-20**, fra Lovdata-cache `data/lovdata-cache/paragrafer/lov_1999-03-26-14__10-20.json` (hentet 2026-05-09).

### § 10-20 (3) — Hovedregel for aksjeandel

> *"Aksjeandelen beregnes ut fra forholdet mellom verdien av aksjer og andre verdipapirer ved inntektsårets begynnelse. For fond som er etablert i inntektsåret, beregnes andelen ut fra forholdet ved inntektsårets slutt. (...)"*

Konkret tidspunkt: **per 1. januar i inntektsåret**. For fond etablert i året: per 31. desember samme år.

### § 10-20 (6) — Ved realisasjon

> *"(...) Gjennomsnittet av aksjeandelen i ervervsåret og i salgsåret legges til grunn. Annet og tredje ledd gjelder tilsvarende ved beregning av aksjeandelen i ervervsåret og i salgsåret. Bare den beregnede aksjeandelen oppjusteres etter § 10-11 første ledd annet punktum."*

Konkret tidspunkt ved realisasjon: **snitt av (aksjeandel per 1.1 i ervervsåret) og (aksjeandel per 1.1 i salgsåret)**.

### § 10-20 (4) — Skjermingsgrunnlag

> *"Bare den delen av andelens inngangsverdi som tilsvarer aksjeandelen i ervervsåret, er skjermingsgrunnlag etter § 10-12 . Annet og tredje ledd gjelder tilsvarende ved beregning av aksjeandelen i ervervsåret."*

Skjermingsgrunnlag bruker **kun aksjeandel per 1.1 i ervervsåret**, ikke snitt.

### Forskriften (FSFIN § 10-20-1 ff.)

Forskriften ble forsøkt hentet via `lookup_paragraf`, men verktøyet støtter kun lovs-refID-er (`lov/...`), ikke forskrifts-refID-er (`for/...`). § 10-20 (7) viser til forskriften kun for å definere "tilsvarende fond etablert i eller utenfor EØS" og fastsette dokumentasjonskrav — den endrer ikke **tidspunktsregelen**, som er fullstendig fastsatt i lov-paragrafen (3) og (6).

For A1 er dette tilstrekkelig. Hvis man senere vil verifisere forskriften manuelt:
- FSFIN § 10-20-1 og påfølgende: https://lovdata.no/forskrift/1999-11-19-1158/§10-20-1
- Praktisk konsekvens: hvis vi senere skal støtte amerikanske/asiatiske fond på linje med EØS-fond, er forskriften relevant. Norske og EØS-fond dekkes uavhengig av forskriften.

---

## 8. Identitetstest-strategi mot dagens `calculate_aksjefond`

### Hvorfor identitetstest?

Refaktoreringen av `aksjer.ts` (per STATUS § 3) ble verifisert med md5-sammenligning før/etter. Samme prinsipp her: for **full-salg av rent aksjefond eller rent rentefond med samme aksjeandel inn/ut**, må ny implementasjon gi identisk numerisk resultat som dagens.

For kombinasjonsfond og partielle salg er forskjellen forventet (per seksjon 5) — kan ikke identitetstestes mot dagens.

### Eksisterende fixturer

Ingen fond-spesifikke fixturer eksisterer i dag. `test-fixtures/nordnet/` er aksje-orientert.

### Nye fixturer som trengs

1. **`test-fixtures/fond/aksjefond-fullsalg.json`** — manuelt skrevet transaksjons-array:
   ```json
   {
     "transaksjoner": [
       {"isin": "NO0010732852", "navn": "ODIN Global D NOK",
        "type": "kjøp", "dato": "2020-08-18",
        "antall": 100, "pris_per_andel": 1000, "tegnings_innløsningsgebyr": 0},
       {"isin": "NO0010732852", "navn": "ODIN Global D NOK",
        "type": "salg", "dato": "2025-04-23",
        "antall": 100, "pris_per_andel": 1500, "tegnings_innløsningsgebyr": 0}
     ],
     "skjerming_carry": [
       {"isin": "NO0010732852",
        "akkumulert_ubrukt_skjerming_per_31_12_forrige_år": 5000}
     ],
     "rapporteringsår": 2025,
     "forventet_kostpris_dagens": 100000,
     "forventet_salgssum_dagens": 150000,
     "forventet_aksjeandel_kjøpsår": 1.0,
     "forventet_aksjeandel_salgsår": 1.0
   }
   ```
2. **`test-fixtures/fond/rentefond-fullsalg.json`** — analogt, med rentefond-ISIN og aksjeandel 0,0.
3. **`test-fixtures/fond/kombinasjon-multi-salg.json`** — flere kjøp (2020 + 2022) og partielle salg (2024, 2025). Brukes til ny logikk, ikke identitetstest — har egne forventede tall regnet manuelt.

### Identitetstest-skript

`scripts/identity-test-fond.mjs`, analogt med `scripts/identity-test-aksjer.mjs`:

1. Kjør ny `calculate_aksjefond` med transaksjons-array fra fixture 1.
2. Kjør dagens `calculate_aksjefond` med tilsvarende flate parametre (`kostpris`, `salgssum`, etc.) regnet fra samme fixture.
3. Sammenlign output bit-for-bit (md5).
4. Gjenta for fixture 2.

Dette krever at vi beholder dagens implementasjon parallelt under én økt av A1 — bygges, identitetstestes, deretter slettes (per premiss "Eksisterende calculate_aksjefond skal erstattes — ikke parallelle verktøy"). Konkret framgangsmåte i A1-økten:
- Steg 1: bygg ny implementasjon i `fond-ny.ts` med eksport `registerFondNyVerktøy` (midlertidig sideby-side).
- Steg 2: kjør identitetstest mot `fond.ts`.
- Steg 3: når identitet bekreftet for de relevante cases, gjør den endelige byttingen i én commit.
- Steg 4: slett `fond-ny.ts`.

---

## 9. Filer som endres i implementasjonsfasen (A1-økten)

| Fil | Endring | Linje-anslag |
|-----|---------|--------------|
| `src/tools/fond.ts` | Erstatt linje 38–277 (hele `registerFondVerktøy`); behold imports, formatering, paragrafblokk | ~280 → ~430 |
| `src/lib/fifo.ts` | Tilføy `delsalg: {...}[]` til `FifoSalgsResultat` (additiv, breaking-fri) | +20 |
| `src/data/fond-klassifisering.json` | Manuelt godkjent, evt. utvidet med `aksjeandel_per_år` for kombinasjonsfond | ~150 → ~300 |
| `src/data/satser/2025.json` | Verifisere at `skjermingsrente.personlige_aksjonærer` brukes (eksisterer allerede) | 0 |
| `test-fixtures/fond/*.json` | 3 nye fixturer (aksjefond-fullsalg, rentefond-fullsalg, kombinasjon-multi) | ~60 totalt |
| `scripts/identity-test-fond.mjs` | Ny — analogt med `identity-test-aksjer.mjs` | ~80 |
| `scripts/test-fond-fifo.mjs` | Ny — enhetstest mot kombinasjons-fixturen (multi-salg, carry-forward) | ~120 |
| `STATUS.md` | Oppdater A1-status, legg til lessons learned hvis noe | ~10 |

Sum ny/endret kode: **~500–600 linjer**. Premissets anslag på "~200 linjer + tester" undervurderer trolig pga klassifiserings-lookup, per-lot-skjerming og output-formatering.

---

## 10. Åpne designspørsmål — input påkrevd

Disse må avklares før eller tidlig i A1-økten:

1. **Utvidelse av `lib/fifo.ts` med per-salg per-lot-breakdown (`delsalg`)** — er det greit å endre delt lib for å støtte fonds-FIFO? Alternativene er duplisering eller restriktiv single-lot-modus. (Seksjon 3.)
2. **Format for `aksjeandel_per_år` i JSON** — objekt med år → verdi, eller eget objekt med `fra`/`til`-intervaller? Forslag: enkel `{ "år": verdi }`-map. Krever én verdi per relevant år.
3. **Lov-strikt aksjeandel-håndtering for "aksjefond"** — skal vi alltid bruke faktisk `aksjeandel_per_år`, eller forenkle til 1,0 for aksjefond og 0,0 for rentefond? Lov-strikt er teknisk korrekt; forenklet matcher dagens fond.ts. (Seksjon 5.)
4. **Manglende aksjeandel for et år** — kaste feil, eller fallback til siste kjente verdi/0,0/nabotidspunkt? Premiss sier "kaste feil" for manglende ISIN; uklart for manglende år innen ekstistende ISIN.
5. **Aksjefond/rentefond/kombinasjon-grenser (80 %/20 %)** — hardkode som konstanter (lovbestemt, ikke sats), eller flytte til `src/data/satser/2025.json`? Bestemmer hvor robust kalkulatoren er mot framtidige lovjusteringer.
6. **"aksje" type i `fond-klassifisering.json`** — skal `calculate_aksjefond` gi feilmelding og rute brukeren til `calculate_aksjegevinst`, eller bare ignorere/filtrere disse transaksjonene stille? Anbefalt: feilmelding for tydelig brukerfeedback.
7. **`skjerming_carry`-mekanikk** — kun rapporteringsåret (forutsetter at brukeren har 31.12-tall fra forrige år), eller full historikk-simulering fra første kjøp? Forslag: rapporteringsåret kun. (Seksjon 4.)
8. **Output-format ved 100 % salg + gjenkjøp innen samme år** — én blokk per ISIN-segment, eller én blokk per ISIN med kronologisk tabell? Påvirker lesbarhet.
9. **Skjerming-carry-forward når akkumulering eksisterer men beholdning er 0** — strikt "bortfall" (per § 10-12), eller behold til brukeren har en ny posisjon? Lov sier bortfall; brukererfaring sier kanskje noe annet.
10. **Test-fixture eksempel-ISIN-er** — bør identitetstest-fixturene bruke ekte ISIN-er fra en reell eksport, eller syntetiske? Ekte gir tryggere kobling mot reelle data, syntetiske er committable i test-fixtures/. Anbefalt: syntetisk men strukturelt analog.

---

## Sammendrag for A1-økten

Etter godkjenning av åpne spørsmål 1–10:

1. Bygg utvidet `lib/fifo.ts` med `delsalg`-breakdown.
2. Bygg nytt `calculate_aksjefond` i `fond-ny.ts` (midlertidig sideby-side).
3. Skriv 3 fixturer + identitetstest + multi-salg-enhetstest.
4. Kjør identitetstest mot dagens fond.ts (full-salg-cases) — md5-sammenligning.
5. Bytt `registerFondVerktøy`-importen i `server.ts`, slett gammel `fond.ts`-implementasjon, rename `fond-ny.ts → fond.ts`.
6. Verifiser ende-til-ende mot ekte CSV (Nordnet → import → calculate_aksjefond).
7. Oppdater STATUS.md.
