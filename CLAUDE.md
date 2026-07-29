# skatt-mcp

Personlig MCP-server for norske skatteberegninger (2025). Kjører lokalt over stdio — ingen data forlater maskinen. Lar chat-Claude svare med faktiske tall, ikke generelle råd.

---

## Status og handoff

Denne prosjektets løpende status, arkitektur-beslutninger, og anbefalte neste steg holdes oppdatert i:
`STATUS.md` (i prosjektroten)

Les den filen først ved start av ny økt.

---

## Oppsett og kjøring

```bash
npm install
npm run build          # tsc → dist/
npm run dev            # tsx src/server.ts (ingen rebuild)
npm run typecheck      # tsc --noEmit

# Verifiser at serveren svarer etter build (bruk cmd.exe, ikke PowerShell, på Windows):
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node dist/server.js
```

**Claude Desktop** — config-fil: macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows `%APPDATA%\Claude\claude_desktop_config.json`. Bruk en **absolutt** sti til `dist/server.js` (config-fila ekspanderer ikke `~`/miljøvariabler):
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

**Claude Code CLI:** `claude mcp add skatt-mcp -- node "$(pwd)/dist/server.js"` (kjør fra prosjektroten).

---

## Mappestruktur

```
skatt-mcp/
├── src/
│   ├── server.ts                    ← MCP-entry, registrerer alle verktøy + stdio-transport
│   ├── tools/                       ← ett verktøy per domene (inntekt, formue, aksjer, ask, fond, bolig, krypto, lovdata, import_nordnet) + felles.ts (delte hjelpere, 2026-07-04)
│   ├── lib/
│   │   ├── fifo.ts                  ← domene-nøytral FIFO-engine (brukt av aksjer + krypto)
│   │   └── csv-parsers/nordnet.ts   ← Nordnet CSV-parser (ren funksjon)
│   └── data/satser/{2025,2026}.json ← skattesatser med _meta-blokk (2026: vedtatt 2025-12-18, FORELØPIG skjermingsrente — forbehold vises i output)
├── data/lovdata-cache/              ← gitignored, lazy-cached lov-XML + paragraf-JSON
├── test-fixtures/nordnet/           ← syntetiske CSV-fixturer + build-fixtures.mjs
└── scripts/                         ← test-runners; snapshot-output gitignored
```

---

## Konvensjoner

### Kode-stil
- TypeScript ESM, `NodeNext` module resolution. **`.js`-suffix påkrevd** i alle import-stier, selv fra `.ts`-filer.
- Norsk i kode (variabler, funksjoner, typenavn). Engelsk snake_case på MCP tool-navn: `calculate_X`, `lookup_X`.
- Én `registerXVerktøy(server: McpServer): void` per fil. Aldri forretningslogikk i `server.ts`.
- Bruk `server.registerTool(name, { title, description, inputSchema }, handler)` — annotert form.
- Stderr-logging for `uncaughtException` og `unhandledRejection`.

Norsk → engelsk domenevokabular (ikke inverter):

| Bruk | Ikke |
|------|------|
| `bruttoinntekt` | `grossIncome` |
| `trinnskatt` | `progressiveTax` |
| `formuesverdi` | `assetValue` |
| `skattepliktigInntekt` | `taxableIncome` |
| `aksjegevinst` | `capitalGain` |
| `skjermingsfradrag` | `shieldingDeduction` |

### Beregning
- Satser kun fra `src/data/satser/{år}.json` — aldri hardkodet. Hver fil krever `_meta`-blokk med kilde og hentedato.
- Halvøre-presisjon på mellomregninger (`formaterKrDesimal`), heltall på totaler (`formaterKr`).
- `Map<string, ...>` for ticker-gruppering (bevarer insertion-order).
- Unicode-minus fra `toLocaleString("nb-NO")` — gotcha for fremtidig CSV-eksport.
- Alle verktøy har `rapporteringsår`-felt. 2026-satser er på plass (2026-07-04): `src/data/satser/2026.json` finnes og kalkulatorene har årsstøtte t.o.m. 2026 — men 2026-skjermingsrenten er FORELØPIG, og output tar forbehold om det. `aksjer.ts` og `krypto.ts` støtter historiske transaksjoner fra 2020 (FIFO-historikk). Ved nytt satsår: opprett `src/data/satser/{år}.json` med `_meta`-blokk **og** utvid min/max-grensene i hver kalkulator.

### MCP / output
- Alle kalkulatorer avslutter output med `paragrafBlokk(refs)` — `Relevante paragrafer:` + refID paddet til 28 tegn.
- `ParagrafRef = { refID: string; tittel: string }` eksportert fra `lovdata.ts`, importert i hver kalkulator.
- Kalkulatorer kaller **aldri** `lookup_paragraf` (ingen IO i hovedflyten — bare statiske refID-lister).
- Lovdata bulk-data (`/v1/publicData/get/gjeldende-lover.tar.bz2`) er åpent. `renderRefID` og `getDocumentIndex` krever auth — ikke bruk.

### Minimal eksempel — nytt verktøy

```typescript
// src/tools/<navn>.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ParagrafRef } from "./lovdata.js";
import satser2025 from "../data/satser/2025.json" with { type: "json" };

const PARAGRAFER: ParagrafRef[] = [
  { refID: "lov/1999-03-26-14/§9-3", tittel: "Skattefritak for visse realisasjonsgevinster" },
];

function paragrafBlokk(refs: ParagrafRef[]): string {
  return ["", "Relevante paragrafer:",
    ...refs.map(r => `  ${r.refID.padEnd(28)} (${r.tittel})`),
  ].join("\n");
}

export function registerKryptoVerktøy(server: McpServer): void {
  server.registerTool("calculate_krypto", {
    title: "...",
    description: "...",
    inputSchema: { /* Zod-schema */ },
  }, async (args) => {
    // beregning
    const linjer: string[] = [];
    linjer.push(paragrafBlokk(PARAGRAFER));
    return { content: [{ type: "text" as const, text: linjer.join("\n") }] };
  });
}
```

Registrer i `server.ts`: importer og kall `registerKryptoVerktøy(server)`.

---

## Lessons Learned

- **Akseptansetester krever eksakte inputs.** To episoder:
  - *Uke 5:* CC brukte syntetiske inputs → komprimert rapport skjulte output-avvik.
  - *Uke 7:* CC brukte syntetiske inputs igjen → tilfeldigvis korrekte tall, men feil prosess. Konsekvent eksakte inputs er eneste pålitelige defense-in-depth mot regresjoner.
- **Rapporter må ha full output, ikke komprimerte tabeller.** Kompresjon skjuler bugs.
- **`spawnSync(..., { encoding: 'utf-8' })` dobbel-koder UTF-8 på Windows** (via CP-1252). Løs med `encoding: 'buffer'` + `.toString('utf-8')`.
- **GNU tar (Git Bash) tolker `C:\...` som remote host.** Løs med `{ cwd: CACHE_DIR }` + relativ filsti.
- **PowerShell parser `{}` som blokksyntaks i echo-pipe.** Bruk cmd.exe for JSON-RPC smoke-testing.
- **ASK skjermingsgrunnlag = laveste innskuddssaldo i året**, ikke 31.12-saldoen. Approksimasjon gir advarsel i output.
- **§5-10 tittel-parsing:** paragrafer uten tidlig `(1)`/`(a)`-anker i HTML får merget tittel/tekst i cache. Hardkodet tittel er korrekt — intern parsing-svakhet som ikke vises for sluttbruker.

---

## Workflow

- **Two-Claude:** chat-Claude (Opus, web) planlegger og verifiserer. CC (Sonnet, lokalt) eksekuterer.
- **Frisk CC-sesjon per økt** for å unngå kontekst-kompaksjon. CLAUDE.md er primær for konvensjoner og arkitektur; STATUS.md er primær for løpende status og neste steg.
- **Én økt = én handoff:** chat-Claude skriver prompt → bruker limer inn i CC → CC rapporterer → chat-Claude verifiserer tall mot forventede verdier i promten.
- **Stopp-betingelser:** tall avviker, rapport komprimert utover spec, kode-bugs.

---

## Avhengigheter

| | |
|---|---|
| Runtime | Node ≥ 18 (innebygd `fetch`) |
| GNU tar | Windows: Git Bash. macOS/Linux: standard |
| `@modelcontextprotocol/sdk` | ^1.29.0 |
| `zod` | ^4 |
| `tsx` (dev) | ^4 |
| `typescript` | ^5.5 |

Deps vedlikeholdes av delt Renovate-preset (`ValiantEvers/renovate-config`, `renovate.json` siden 2026-07-23).
