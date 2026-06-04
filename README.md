# skatt-mcp

En lokal [MCP](https://modelcontextprotocol.io)-server som lar Claude svare på norske
skattespørsmål med **faktiske beregninger** i stedet for generelle forklaringer — f.eks.
«hvor mye skatt skylder jeg på denne aksjegevinsten?» eller «hva blir formuesskatten min
for 2025?».

Tolv verktøy dekker inntekt, formue, aksjer, aksjesparekonto (ASK), verdipapirfond, bolig,
krypto, Lovdata-paragrafoppslag, Nordnet-import og et samlet skatteoppgjør.

---

## ⚠️ Ansvarsfraskrivelse

**Dette er ikke skatterådgivning.** Verktøyet er et personlig hjelpemiddel for å estimere
norsk skatt, og kan inneholde feil, forenklinger eller utdaterte satser. Alle tall **må
verifiseres** mot [Skatteetaten](https://www.skatteetaten.no/) og din egen skattemelding før
de brukes til noe. Satsene gjelder **inntektsåret 2025** (se `src/data/satser/2025.json` for
kilder og hentedato). Bruk skjer på eget ansvar.

---

## 🔒 Personvern

Skatteberegningene kjører **100 % lokalt** over stdio. Tallene og transaksjonene dine sendes
aldri over nettverket og forlater aldri maskinen din — det er ingen telemetri, ingen
innlogging og ingen tredjepartstjeneste involvert.

Den eneste nettverkstrafikken i hele serveren er at `lookup_paragraf` kan laste ned
**offentlig** lovtekst fra [Lovdatas](https://lovdata.no/) åpne bulk-arkiv og cache den
lokalt i `data/lovdata-cache/` (gitignored). Ingen personlige data inngår i det oppslaget —
det henter bare paragraftekst fra skatteloven.

Ekte Nordnet-eksporter holdes **utenfor** repoet: `*.csv` er gitignored (med unntak for de
syntetiske filene i `test-fixtures/`), slik at faktiske finansdata aldri kan bli committet ved
et uhell.

---

## Kom i gang

### 1. Installér og bygg

```bash
git clone https://github.com/ValiantEvers/skatt-mcp.git
cd skatt-mcp
npm install
npm run build      # kompilerer TypeScript → dist/
```

### 2. Røyktest

Bekreft at serveren svarer (lister opp alle verktøyene):

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node dist/server.js
```

> På **Windows** kjør denne i `cmd.exe`, ikke PowerShell — PowerShell tolker `{}` som
> blokksyntaks i en echo-pipe.

### 3. Koble til Claude Desktop

Åpne config-fila:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Legg til serveren med en **absolutt** sti til `dist/server.js` (config-fila ekspanderer ikke
`~` eller miljøvariabler):

```json
{
  "mcpServers": {
    "skatt-mcp": {
      "command": "node",
      "args": ["/Users/<DITT-BRUKERNAVN>/projects/skatt-mcp/dist/server.js"]
    }
  }
}
```

På Windows oppgir du den tilsvarende absolutte stien til `dist\server.js` under din egen
brukermappe. Tips: kjør `pwd` (macOS/Linux) eller `cd` (Windows) i prosjektmappa for å få
den fulle stien.

Start Claude Desktop på nytt. Du skal nå se verktøy-ikonet (🔨) og `skatt-mcp`-verktøyene i
listen.

### 4. (Alternativ) Koble til Claude Code

Kjør fra prosjektroten:

```bash
# macOS / Linux
claude mcp add skatt-mcp -- node "$(pwd)/dist/server.js"
```

```cmd
:: Windows (cmd.exe)
claude mcp add skatt-mcp -- node %CD%\dist\server.js
```

> Etter endringer i `src/`: kjør `npm run build` på nytt, og start Claude Desktop på nytt for
> at endringene plukkes opp.

---

## Verktøy

| Verktøy | Hva det gjør |
|---------|--------------|
| `calculate_inntektsskatt` | Alminnelig inntektsskatt + trinnskatt + trygdeavgift for et gitt år |
| `lookup_satser` | Slår opp gjeldende skattesatser (trinn, fradrag, rabatter) for året |
| `calculate_formuesskatt` | Formuesskatt med verdsettingsrabatter per formuesklasse |
| `calculate_aksjegevinst` | Gevinst/tap på aksjer med FIFO og oppjustering ×1,72 |
| `calculate_skjermingsfradrag` | Skjermingsfradrag på aksjeutbytte/-gevinst |
| `calculate_ask` | Skatt på aksjesparekonto (ASK), inkl. skjerming |
| `calculate_aksjefond` | Verdipapirfond med FIFO per ISIN og aksjedel/rentedel-splitt |
| `calculate_boliggevinst` | Gevinst ved salg av primær-, sekundær- eller fritidsbolig |
| `calculate_kryptogevinst` | Gevinst/tap på kryptovaluta med FIFO |
| `import_transaksjoner_nordnet` | Parser en Nordnet CSV-eksport → kanonisk transaksjons-array |
| `beregn_skatteoppgjoer_nordnet` | Fullt skatteoppgjør fra en Nordnet-eksport (auto-ruter aksjer/fond per ISIN) |
| `lookup_paragraf` | Henter og siterer en paragraf fra skatteloven (via Lovdata) |

Alle kalkulatorene avslutter svaret med en `Relevante paragrafer:`-blokk slik at tallene kan
spores tilbake til lovhjemmel.

---

## Eksempel-dialog

> **Du:** Jeg solgte 100 Equinor-aksjer i 2025 som jeg kjøpte i 2021 for 200 kr stykket.
> Salgskursen var 280 kr. Hva skylder jeg?

Claude kaller `calculate_aksjegevinst` med transaksjonene dine og svarer med faktiske tall,
omtrent slik *(illustrative tall)*:

```
Equinor — rapporteringsår 2025
  Salg 2025: 100 @ 280  → salgssum 28 000, kostbase 20 000, gevinst 8 000
  Oppjustert (×1,72):                       13 760
  Implisert skatt (22 %):                    3 027

Relevante paragrafer:
  lov/1999-03-26-14/§10-31    (Skatteplikt for gevinst og fradragsrett for tap)
  ...
```

Har du hele Nordnet-eksporten? Da kan Claude bruke `beregn_skatteoppgjoer_nordnet`, som
parser eksporten, grupperer per ISIN og automatisk ruter rene aksjer til aksje-FIFO og
verdipapirfond til fond-motoren — og returnerer ett samlet skatteoppgjør.

---

## Arkitektur

- **TypeScript ESM** (`NodeNext`), stdio-transport via `@modelcontextprotocol/sdk`.
- **Delt FIFO-motor** — `src/lib/fifo.ts` er en domene-nøytral FIFO-implementasjon som
  gjenbrukes av aksjer, verdipapirfond og krypto. Salgsresultatene kan inkludere per-lot
  «delsalg»-breakdown for korrekt snittsaksjeandel i fond.
- **Zod-validering** — alle verktøyenes input valideres med [Zod](https://zod.dev/)
  (ingen Pydantic; dette er et rent TypeScript-prosjekt).
- **Satser fra data, ikke hardkodet** — alle skattesatser ligger i
  `src/data/satser/2025.json` med en `_meta`-blokk som dokumenterer kilde og hentedato.
- **Tre-lags Lovdata-cache** — `lookup_paragraf` laster Lovdatas åpne `tar.bz2`-arkiv, pakker
  ut lov-XML og cacher ferdig-parsede paragrafer som JSON, alt under `data/lovdata-cache/`.
- **Fond-klassifisering** — `src/data/fond-klassifisering.json` mapper ISIN → fondstype
  (`aksjefond` / `rentefond` / `kombinasjonsfond`) og valgfri `aksjeandel_per_år`. Repoet
  leveres med en liten **seed** av alminnelige fond. Legg til dine egne ved å føye til en
  oppføring med ISIN-en som nøkkel:

  ```json
  "NO0010xxxxxx": {
    "navn": "Mitt fond",
    "type": "aksjefond"
  }
  ```

  For kombinasjonsfond oppgir du `"aksjeandel_per_år": { "2024": 0.55, "2025": 0.57 }`.

Se [`CLAUDE.md`](CLAUDE.md) for kodekonvensjoner og [`STATUS.md`](STATUS.md) for full
arkitekturhistorikk, beslutninger og edge cases.

---

## Kjøre testene

```bash
npm test          # bygger og kjører hele den committede testpakken
npm run typecheck # ren type-sjekk uten å skrive filer
```

Testpakken kjører parser-enhetstester, en MD5-frosset identitetstest for fond-motoren, det
samlede skatteoppgjøret og en ende-til-ende-test mot syntetiske fixturer (`test-fixtures/`).
Ingen ekte data kreves.

---

## Roadmap

- [ ] **DNB-parser** — støtte for et andre meglerformat. Mønsteret er etablert via
  Nordnet-parseren, så dette bør bli vesentlig mindre arbeid.
- [ ] **Validering mot ekte 2025-skattemelding** — sammenlign verktøyets tall mot et
  ferdigstilt skattemeldingsutkast fra Skatteetaten for å avdekke eventuelle hull.

---

## Lisens

[MIT](LICENSE) © Valiant Evers
