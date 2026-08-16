# skatt-mcp — STATUS

**Sist oppdatert: 2026-08-16**

---

## 1. Oppsummering

`skatt-mcp` er en lokal MCP-server (TypeScript ESM, stdio-transport) som lar Claude svare på norske skatte-spørsmål med faktiske beregninger framfor generelle forklaringer.

Per i dag har vi 7 ferdige kalkulator-domener (inntekt, formue, aksjer, ASK, fond, bolig, krypto) + Lovdata-paragraf-oppslag + Nordnet CSV-importør. FIFO-engine er ekstrahert til delt lib og brukes av aksjer, krypto og fond. Nordnet-import er verifisert mot ekte 484-rad eksport. **A1 (fond-FIFO) er fullført 2026-05-10** — `fond.ts` er nå transaksjons-/FIFO-basert med per-lot snittsaksjeandel, skjerming-carry og oppjustering ×1,72 kun på aksjedel.

**A2 (orkestrator) er fullført 2026-05-31** — nytt verktøy `beregn_skatteoppgjoer_nordnet` (`src/tools/skatteoppgjor.ts`) kjeder CSV → parse → per-ISIN-ruting → full skatteberegning i ett kall. Parseren (`csv-parsers/nordnet.ts`) er utvidet med `isin` per transaksjon (additivt; kolonne 7 leses nå inn) slik at automatisk ruting mot `fond-klassifisering.json` er mulig. Aksjer går til aksje-FIFO, fond til `beregnPerIsin` (gjenbrukt fra `fond.ts`). Verktøyet godtar `csv_filsti` ELLER `csv_tekst`. Utbytte/bytte/splitt rapporteres som advarsler, ikke beregnet. Verifisert med `scripts/test-skatteoppgjoer.mjs` (kombinert aksje+fond-fixture: 2 248 + 7 568 = 9 816). Eksisterende parser- og fond-identitetstester fortsatt grønne.

**Årsstøtte 2026 er åpnet 2026-08-16 (v0.1.0).** `hentSatser` og `src/data/satser/2026.json`
hadde vært klare en stund, men fem verktøy var fortsatt låst til `max(2025)` i zod-skjemaet —
`aksjer` (begge verktøy), `ask`, `bolig`, `formue` og `krypto`. Grensene er hevet til 2026;
**defaulten står bevisst igjen på 2025**, fordi skattemeldingen man leverer nå gjelder
inntektsåret 2025. `hentOppjusteringsfaktor` leser nå faktoren fra årets satsfil i stedet for
å hardkode 2025. Forbeholdet om den foreløpige 2026-skjermingsrenten (`satsForbehold`) er
wiret inn i `aksjer` og `ask` — de eneste to av de fem som faktisk bruker skjermingsrenten;
å sette det på bolig/formue/krypto ville vært et forbehold på tall det ikke berører.
2025-output er uendret (forbeholdet returnerer `null` for 2025).

**⚠️ Feil funnet og rettet i samme slag: primærbolig-terskelen.** `2026.json` sa 10 MNOK og
«uendret 2025→2026», og `formue.ts` hadde grensen **hardkodet** som `10_000_000`. Riktig for
inntektsåret 2026 er **14 MNOK** (25 % under, 70 % over) — verifisert mot Skatteetatens satsside
for 2026. Feilkilden er sannsynlig: Prop. 1 LS (2025–2026) fra høsten 2025 hadde fortsatt 10 M,
og hevingen kom senere. Terskelen ligger nå i satsfila (`primærbolig.terskel`), og nøklene er
døpt om fra `verdsetting_opp_til_10M`/`_over_10M` til `_under_terskel`/`_over_terskel` — de gamle
navnene ville vært direkte usanne for 2026. Utslag: en primærbolig til 15 MNOK ble verdsatt til
6 000 000 der fasit er 4 200 000, altså **1,8 MNOK for høyt formuesgrunnlag**.
Kryssjekk: `renteriket` hadde allerede 14 MNOK riktig; det var dette repoet som lå etter.

**Nye golden-tester: `scripts/test-2026.mjs`** (11 stk, wiret inn i `npm test`). Alle fasiter er
regnet for hånd fra `2026.json` med utregningen i kommentar over hver test — ikke observert
output limt inn i etterkant. Dekker den restrukturerte formuesskatten (kommunal 0,35 %, statlig
trinn 1 0,65 %, trinn 2 0,75 % over 21,5 MNOK, bunnfradrag 1,9/3,8 MNOK), ektefelledoblingen av
**både** bunnfradrag og innslag, og primærbolig-terskelen i praksis.

**Neste anbefalte steg: DNB-parser eller validering mot 2025-skattemelding.** Begge krever ekstern data — DNB-parser krever en eksempelfil, validering krever ferdigstilt skattemelding for inntektsåret 2025.

---

## 2. Status per modul

### Ferdig

| Modul | Verktøy | Notat |
|-------|---------|-------|
| `src/tools/inntekt.ts` | `calculate_inntektsskatt`, `lookup_satser` | Trinnskatt, trygdeavgift, BSU |
| `src/tools/formue.ts` | `calculate_formuesskatt` | Verdsettingsrabatter |
| `src/tools/aksjer.ts` | `calculate_aksjegevinst`, `calculate_skjermingsfradrag` | Bruker `lib/fifo.ts` |
| `src/tools/ask.ts` | `calculate_ask` | Aksjesparekonto |
| `src/tools/fond.ts` | `calculate_aksjefond` | **A1 ferdig (2026-05-10):** transaksjons-array-input, FIFO per ISIN via `lib/fifo.ts`, per-lot snittsaksjeandel, skjerming-carry, oppjustering kun aksjedel |
| `src/tools/bolig.ts` | `calculate_boliggevinst` | Primær/sekundær/fritid |
| `src/tools/krypto.ts` | `calculate_kryptogevinst` | Bruker `lib/fifo.ts`, ingen oppjustering/skjerming |
| `src/tools/lovdata.ts` | `lookup_paragraf` | Tre-lags cache (tar.bz2 → XML → paragraf-JSON) |
| `src/tools/import_nordnet.ts` | `import_transaksjoner_nordnet` | UTF-16 LE TSV → kanonisk transaksjons-array |
| `src/lib/fifo.ts` | (lib) | Domene-nøytral `kjørFifo` + `IkkeNokBeholdningFeil` + opt-in `delsalg`-output |
| `src/lib/csv-parsers/nordnet.ts` | (lib) | `parseNordnetCsv` + `NordnetCsvFeil` |
| `src/data/fond-klassifisering.json` | (data) | **12 entries** (8 aksjefond, 3 rentefond, 1 aksje), ISIN som nøkkel. Bevisst offentlig **seed**, ikke full dekning — repoet er public, og hvilke fond jeg eier er ikke noe som skal ligge her. Ukjent ISIN er ingen stille feil: `fond.ts` kaster med filnavnet i meldingen, så den som mangler et fond legger det inn selv (talt 2026-08-16) |

17 paragrafblokker hardkodet på tvers av kalkulatorene, alle verifisert mot Lovdatas bulk-arkiv (kjørt via `lookup_paragraf` ved hardkoding).

### Tracked, ikke startet

| Steg | Beskrivelse |
|------|-------------|
| DNB-parser | Andre megler-format. Mønster etablert via Nordnet — bør bli betydelig mindre arbeid. Trenger eksempelfil først. |
| Validering mot ekte 2025-skattemelding | Mulig nå som fond-FIFO er på plass. Krever ferdigstilt skattemelding-utkast fra Skatteetaten. |

---

## 3. Arkitektur-beslutninger logget

- **FIFO-kjernen ekstrahert til `src/lib/fifo.ts`.** Domene-nøytral (`identifikator`, `pris_per_enhet`, `transaksjonsgebyr`). Brukes av `aksjer.ts`, `krypto.ts` og `fond.ts`.
- **`lib/fifo.ts` utvidet med opt-in `delsalg`-output (2026-05-10, A1-økten).** Tredje parameter `inkluder_delsalg = false` til `kjørFifo`. Når true: hvert salgsresultat har `delsalg: DelSalg[]` med per-lot kostbase, salgssum-andel og gevinst. Backwards-kompatibilitet verifisert via md5-bit-sammenligning av `aksjer.ts` og `krypto.ts` output før/etter endringen.
- **`fond.ts` lookup mot statisk JSON-config (A1).** `src/data/fond-klassifisering.json` er **autoritativ kilde** for type per ISIN (aksjefond/rentefond/kombinasjonsfond) + valgfri `aksjeandel_per_år`. `klassifisering_hint` fra Nordnet-importøren er fortsatt kun rådgivende metadata, og overstyrer ikke konfigurasjonen.
- **Hybrid aksjeandel-default.** Aksjefond default 1.0, rentefond default 0.0 hvis ingen `aksjeandel_per_år` oppgitt. Kombinasjonsfond krever eksplisitt `aksjeandel_per_år` for hvert relevant kjøps- og salgsår — kaster feil hvis manglende. Type "aksje" eller "ukjent" → feil med rute-hint til `calculate_aksjegevinst`.
- **§ 10-20 (6) per-lot snittsaksjeandel-håndtering.** For hver FIFO-lot avhendet i et salg: snitt av aksjeandel i lottens kjøpsår og salgsåret. Implementert via `delsalg`-breakdown fra `kjørFifo`. Konsekvens: aksjedel av gevinst kan variere over lots innen samme salg.
- **80 % / 20 % aksjeandel-grenser hardkodet i fond.ts** (`AKSJEFOND_GRENSE = 0.8`, `RENTEFOND_GRENSE = 0.2`) med kommentar som peker til § 10-20 (2). Lovbestemt — ikke flyttet til `satser/2025.json`.
- **Exception-mønster på tvers av prosjektet.** `IkkeNokBeholdningFeil`, `NordnetCsvFeil` — alle verktøy bruker `throw new Error(...)`-konvensjonen.
- **`transaksjonsgebyr` (ikke `kurtasje`) i lib.** Kurtasje er meglerterm for verdipapir; krypto bruker "gebyr"; fond bruker "tegnings_innløsningsgebyr". Lib bruker nøytralt navn, kallere oversetter på input-laget.
- **Nordnet-parser produserer rå transaksjons-array (A3-valg).** Ingen automatisk ruting av aksje vs fond. `klassifisering_hint` per verdipapir er rådgivende metadata.
- **17 paragrafblokker hardkodet.** RefID + kort tittel verifisert mot Lovdata-cache. Kalkulatorer kaller IKKE `lookup_paragraf` ved hver kjøring — refID-listene er statiske.
- **Ektefeller har DOBLE beløpsgrenser i formuesskatten — også trinn 2-innslaget (fiks 2026-08-16, v0.0.2).**
  `formue.ts` doblet bunnfradraget, men brukte trinn 2-innslaget (2025: 20,7 MNOK) rått for
  ektefeller, slik at felles formue mellom 20,7 og 41,4 MNOK feilaktig fikk 0,575 %-satsen på
  toppen — 30 MNOK ble overbeskattet med 9 300 kr, 50 MNOK med 20 700 kr. Nå
  `trinn2Innslag = statlig_trinn2_innslag × 2` for ektefeller, brukt i både trinn 1-grunnlaget
  og trinn 2. Kilde: Stortingets skattevedtak 2025 § 2-1 (Lovdata 2024-12-13-3203) — ektefeller
  som lignes under ett: bunnfradrag 3 520 000, 0,475 % opp til **41 400 000**, 0,575 % over.
  Samme bugg ble funnet og fikset først i søster-porten skatt-optimizer `formue.py`
  (`83873ba`, 2026-07-12) — **ikke synk tilbake til gammel oppførsel.**
  Fire golden-tester i `scripts/test-formue-ektefeller.mjs` (verifisert at de faktisk feiler
  når fiksen reverteres). Samme økt: satsene i etikettene («Kommunal (0,525 %)») kommer nå fra
  satsfila i stedet for å være hardkodet i teksten — 2025-output er byte-identisk, men et nytt
  satsår kan ikke lenger gi en etikett som lyver om tallet ved siden av.
- **MD5-baseline-mønster ved refaktorering.** For A1: før- og etter-output for full-salg-cases ble md5-bit-sammenlignet. Baseline-MD5 frosset i `scripts/identity-test-fond.mjs` som regresjon-detector — `90dfb149e343b4657e77e30df98ac8b8` (aksjefond-fullsalg) og `b193070afb26ffe056f68b0b9393a83a` (rentefond-fullsalg). Samme mønster brukt for `aksjer.ts` og `krypto.ts` da `delsalg`-feltet ble lagt til i `lib/fifo.ts`.

---

## 4. Filstruktur (relevant)

```
skatt-mcp/
├── CLAUDE.md                          ← prosjekt-instruksjoner, peker hit
├── design/fond-fifo-design.md         ← A1 design-dokument (2026-05-10)
├── src/
│   ├── server.ts                      ← MCP-entry, registrerer alle verktøy
│   ├── tools/                         ← 9 verktøyfiler (én per domene)
│   ├── lib/
│   │   ├── fifo.ts                    ← domene-nøytral FIFO-engine (med opt-in delsalg)
│   │   └── csv-parsers/nordnet.ts     ← Nordnet-parser (ren funksjon)
│   └── data/
│       ├── satser/2025.json           ← skattesatser med _meta-blokk
│       └── fond-klassifisering.json   ← ISIN → type + aksjeandel_per_år
├── data/lovdata-cache/                ← gitignored, lazy-cached lov-XML + paragrafer
├── test-fixtures/
│   ├── nordnet/                       ← 7 syntetiske CSV-fixturer + build.mjs
│   └── fond/                          ← 3 JSON-fixturer (aksjefond, rentefond, kombinasjon)
└── scripts/                           ← test-runners (ikke alle commit-relevante)
    ├── identity-test-fond.mjs         ← MD5-regresjonstest mot frosset baseline
    ├── identity-test-aksjer.mjs       ← før/etter-snapshot ved aksjer-refaktorering
    ├── test-nordnet-parser.mjs        ← unit-tester mot fixturer
    ├── test-nordnet-e2e.mjs           ← parser → calculate_aksjegevinst, ekte fil
    ├── test-krypto.mjs                ← krypto-aksept-test
    ├── test-formue-ektefeller.mjs     ← 4 golden-tester, ektefellers doble beløpsgrenser
    ├── fetch-paragraf.mjs             ← én-shot lookup_paragraf via MCP
    └── generate-fond-klassifisering.mjs ← bygger draft fra to Nordnet-eksporter
```

---

## 5. Test-data og fixturer

- **Ekte testdata (utenfor prosjektet, personlig data — ALDRI kopier inn):** ekte Nordnet-eksporter holdes utenfor repoet og committes aldri (`*.csv` er gitignored utenom `test-fixtures/`). `fond-klassifisering.json` i repoet er en generisk seed av alminnelige fond — utvid den med dine egne ISIN-er lokalt.

- **Test-fixturer (i prosjektet, syntetiske, committable):**
  - `test-fixtures/nordnet/` — 7 `.csv`-filer + `build-fixtures.mjs`
  - `test-fixtures/fond/` — 3 `.json`-filer (aksjefond-fullsalg, rentefond-fullsalg, kombinasjonsfond-toår). Syntetiske ISIN-er NO0099999991/92/93.

- **Test-skripter:**
  - `scripts/test-nordnet-parser.mjs` — unit-tester mot fixturer
  - `scripts/test-nordnet-e2e.mjs` — fixture 1 → `calculate_aksjegevinst` + parse av ekte fil
  - `scripts/identity-test-aksjer.mjs` — før/etter-snapshot ved aksjer-refaktorering (md5)
  - `scripts/identity-test-fond.mjs` — fond-fixturer mot frosset MD5-baseline (2026-05-10)
  - `scripts/test-krypto.mjs` — krypto-aksept-test (3 cases)
  - `scripts/fetch-paragraf.mjs` — én-shot lookup_paragraf via MCP
  - `scripts/generate-fond-klassifisering.mjs` — bygger `fond-klassifisering.draft.json` fra to Nordnet-eksporter

- **`.gitignore`:** `*.csv` globalt ignorert (beskytter mot at ekte data sniker seg inn), whitelist `!test-fixtures/**/*.csv`. Script-snapshot-filer (`scripts/before-*.txt` osv.) er også ignorert.

---

## 6. Verifisering

Kjør disse i prosjektroten for å bekrefte at status fortsatt stemmer:

```bash
npm run typecheck && npm run build && node scripts/test-nordnet-parser.mjs && node scripts/identity-test-fond.mjs
```

Forventet: ren TypeScript-kompilering + alle fixture-assertions passerer + MD5-identitet med fond-baseline bekreftet.

Hele den committede testpakken kjøres med:

```bash
npm test
```

Ende-til-ende-testen (`scripts/test-nordnet-e2e.mjs`) kjører nå mot syntetisk fixture — ingen ekte fil kreves.

---

## 7. Neste anbefalte økt

To likestilte alternativer — brukeren velger:

**A. DNB-parser.** Andre megler-format. Mønster etablert via Nordnet — `lib/csv-parsers/dnb.ts` analogt med `nordnet.ts`. Krever eksempelfil først (ekte eksport fra DNB med kjente tall). Anslag: ~300 linjer + fixturer + test-skript.

**B. Validering mot ekte 2025-skattemelding.** Krever utkast fra Skatteetaten med faktiske beregnede tall (aksjegevinst, utbytte, fond-gevinst per ISIN, skjerming-akkumulering). Sammenlign med `calculate_aksjegevinst` + `calculate_skjermingsfradrag` + `calculate_aksjefond` på samme transaksjons-array fra Nordnet-eksporten. Eventuelle diff-er identifiserer huller i implementasjonen.

---

## 8. Kjente tekniske TODO-er

Lavprioritets-saker som ikke er "neste steg", men som ikke skal glemmes.

1. **Trygdeavgift-routing hardkodet.** `=== "lønn" ? ...` i `inntekt.ts` — TS strict + JSON-import gir ikke skikkelig type-narrowing. Fix: definer `Satser`-interface for JSON-strukturen.
2. **Stortingets trinnskatt-satser mangler i Lovdata-arkivet** (årlige vedtak). Vedlikeholdes manuelt i `src/data/satser/<år>.json` — vurder kobling til regjeringen.no for automatisering.
3. **`fond-klassifisering.json` mangler `aksjeandel_per_år` for de fleste fond.** Defaults (1.0 for aksjefond, 0.0 for rentefond) fungerer pragmatisk, men kombinasjonsfond kan ikke beregnes uten års-data. Seed-klassifiseringen inneholder foreløpig ingen kombinasjonsfond.
4. **Forskriften til § 10-20 (FSFIN § 10-20-1 ff.) ikke konsultert.** `lookup_paragraf` støtter kun `lov/...`-refID-er, ikke `for/...`. Relevant hvis fond utenfor EØS skal støttes på linje med EØS-fond.
5. **MCP-klient ikke konfigurert ennå.** Serveren er bygget men ikke nødvendigvis koblet til Claude Desktop eller CC-MCP-config. Verktøyene fungerer via test-scripts, men brukes ikke interaktivt ennå. Når validering mot ekte 2025-skattemelding starter, blir interaktiv kjøring relevant — da må `claude_desktop_config.json` (eller `claude mcp add skatt-mcp ...`) settes opp.
6. **Property-keys i tool-input-schemaer må være ASCII (Anthropic API-restriksjon, regex `^[a-zA-Z0-9_.-]{1,64}$`).** Norsk æøå translittert til aa/oe/ae (`år`→`aar`, `kjøpspris`→`kjoepspris`, `påkostninger`→`paakostninger` osv.). Enum-verdier (`kjøp`, `salg`, `primærbolig`) og `.describe()`-strenger beholder norsk. Interne TS-typer/variabler (f.eks. `BeregnArgs.rapporteringsår` i `fond.ts`) kan også beholde norsk — bare det som serialiseres til JSON Schema property-key må være ASCII.

---

## 9. Kjente edge cases / fallgruver

- **INNLEGG OVERFØRING med ikke-NOK Kjøpsverdi** → hoppes over av parseren (1 rad i ekte data, "Nordnet Suomi Indeksi" i EUR). Manuell oppfølging.
- **BYTTE INNLEGG/UTTAK VP, SPLITT, REINVESTERT UTBYTTE** → hoppes over med eksplisitt `grunn`-tekst. Krever manuell justering av FIFO-lots før verktøyet kjøres.
- **Fond-rader mates IKKE inn i `calculate_aksjegevinst`** — feil oppjustering for rentefond, og kombinasjonsfond håndteres ikke. Bruk `calculate_aksjefond` (nytt fra A1) med ISIN-bærende transaksjons-array. Hvis ISIN ikke finnes i `fond-klassifisering.json`: legg til entry først.
- **Røyktest av MCP-server skal gjøres via cmd.exe, ikke PowerShell.** PowerShell parser `{}` som blokksyntaks i echo-pipe.
- **Etter endringer i kode:** `npm run build` → restart Claude Desktop for at nye verktøy plukkes opp.
- **Norsk locale-output** bruker `U+202F` (narrow no-break space) som tusenseparator, ikke vanlig mellomrom. Test-regex må bruke `\s` for å matche.
- **`calculate_aksjefond` med type=aksje i config** → feil med rute-hint til `calculate_aksjegevinst`. Per A1-design, bevisst stopp i stedet for stille filtrering.
- **Kombinasjonsfond uten `aksjeandel_per_år` for et realiseringsår** → eksplisitt feil (per A1-design). Kombinasjonsfond kan ikke beregnes med default-aksjeandel — både kjøpsårets og salgsårets aksjeandel må være eksplisitt definert i `fond-klassifisering.json` for at per-lot snittsaksjeandel skal kunne beregnes.
- **Skjerming-bortfall ved 100 % salg.** Skjerming-akkumulering knyttet til en aksje/fondsandel faller bort når andelen realiseres fullt ut, jf. § 10-12 (2) og § 10-21. `fond.ts` rapporterer `bortfalt_skjerming` per ISIN ved fullt salg; ubrukt skjerming kan ikke videreføres til andre ISIN-er.

---

## 10. Hvordan starte neste økt

Lim inn til ny CC-økt:

> Les `STATUS.md` i prosjektroten, og fortsett deretter med [DNB-parser | validering mot 2025-skattemelding]. Bekreft at du har forstått statusen før du begynner å skrive kode.
