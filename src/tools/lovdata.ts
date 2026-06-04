import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROSJEKTROT = join(__dirname, "..", "..");
const CACHE_DIR = join(PROSJEKTROT, "data", "lovdata-cache");
const PARAGRAF_DIR = join(CACHE_DIR, "paragrafer");
const LOVER_DIR = join(CACHE_DIR, "lover");
const ARKIV_STI = join(CACHE_DIR, "gjeldende-lover.tar.bz2");
const ARKIV_URL =
  "https://api.lovdata.no/v1/publicData/get/gjeldende-lover.tar.bz2";

interface CacheParagraf {
  refID: string;
  tittel: string;
  lovnavn: string;
  tekst: string;
  url: string;
  hentet: string;
}

export type ParagrafRef = { refID: string; tittel: string };

function sanitiserRefID(refID: string): string {
  return refID.replace(/[/§\\]/g, "_").replace(/[^a-zA-Z0-9_\-.]/g, "_");
}

function parsRefID(
  refID: string
): { lovID: string; paragrafNr: string } | null {
  const m = refID.match(/^lov\/([0-9][0-9\-]+)\/§(.+)$/);
  if (!m) return null;
  return { lovID: m[1], paragrafNr: m[2] };
}

// "1999-03-26-14" → "nl/nl-19990326-014.xml" (arkivsti)
function lovIDTilArkivSti(lovID: string): string {
  const deler = lovID.split("-");
  if (deler.length < 4) throw new Error(`Ugyldig lov-ID: ${lovID}`);
  const dato = deler.slice(0, 3).join("");
  const nr = parseInt(deler.slice(3).join(""), 10);
  return `nl/nl-${dato}-${String(nr).padStart(3, "0")}.xml`;
}

function hentLovTittel(html: string): string {
  const m = html.match(/<title>([^<]+)<\/title>/);
  return m ? m[1] : "Ukjent lov";
}

function finnAnker(html: string, paragrafNr: string): string | null {
  // TOC-lenken: href="#kapittel-X-[kapittel-Y-]paragraf-Z">§ ParagrafNr.
  // Search for the TOC entry with the paragraph number. The § character in HTML
  // is sometimes a UTF-8 § and sometimes &sect; — handle both.
  const escaped = paragrafNr.replace(/-/g, "\\-");
  const patterns = [
    new RegExp(`href="(#[^"]+)"[^>]*>\\s*§\\s+${escaped}[\\s\\.]`),
    new RegExp(`href="(#[^"]+)"[^>]*>\\s*&sect;\\s+${escaped}[\\s\\.]`),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1].slice(1); // strip leading #
  }
  return null;
}

function trekkUtTekst(
  html: string,
  anker: string,
  paragrafNr: string
): { tittel: string; tekst: string } {
  const startIdx = html.indexOf(`id="${anker}"`);
  if (startIdx === -1) throw new Error(`Anker ikke funnet: ${anker}`);

  const rest = html.slice(startIdx);
  const subPrefix = anker + "-";

  // Finn slutten: neste id= som IKKE er et underelement av ankeret
  const idRe = /id="([^"]+)"/g;
  idRe.lastIndex = anker.length + 10;
  let endIdx = rest.length;
  let m;
  while ((m = idRe.exec(rest)) !== null) {
    if (!m[1].startsWith(subPrefix)) {
      endIdx = m.index;
      break;
    }
  }

  // Hopp over resten av åpnings-taggen (id="..." er midt i en tag)
  const tagLukk = rest.indexOf(">") + 1;

  // endIdx peker inn i neste elements åpnings-tag; scan bakover for å finne <
  let trueEnd = endIdx;
  for (let i = endIdx - 1; i > tagLukk; i--) {
    if (rest[i] === "<") { trueEnd = i; break; }
  }

  const slice = rest.slice(tagLukk, trueEnd);
  let text = slice.replace(/<[^>]+>/g, " ");
  text = text.replace(/\s+/g, " ").trim();

  // Fjern endringshistorikk ("Endret ved lov..." er støy for LLM)
  text = text.replace(/\s+Endret ved lov[\s\S]*$/, "").trim();

  // Trekk ut tittelen (§ X-Y . Overskrift) fra starten av teksten
  const tittelRe = /^(§\s+[\d\-]+\s*\.\s*.+?)(?=\s*\(1\)|\s*\(a\))/;
  let tittel = `§ ${paragrafNr}`;
  let body = text;

  const tittelMatch = text.match(tittelRe);
  if (tittelMatch) {
    tittel = tittelMatch[1].replace(/\s+/g, " ").trim();
    // Normaliser "§ 9-3 ." → "§ 9-3."
    tittel = tittel.replace(/§\s+([\d\-]+)\s*\./, "§ $1.");
    body = text.slice(tittelMatch[1].length).trim();
  } else {
    // Fallback: alt opp til første parentes eller nytt avsnitt
    const alt = text.match(/^(§\s+[\d\-]+\s*\.\s*.+)$/);
    if (alt) {
      tittel = alt[1].replace(/§\s+([\d\-]+)\s*\./, "§ $1.").replace(/\s+/g, " ").trim();
      body = text;
    }
  }

  return { tittel, tekst: body };
}

async function finnesArkiv(): Promise<boolean> {
  try {
    await access(ARKIV_STI);
    return true;
  } catch {
    return false;
  }
}

async function lastNedArkiv(): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  const resp = await fetch(ARKIV_URL, {
    headers: { "User-Agent": "skatt-mcp/0.1 (personlig bruk)" },
    signal: AbortSignal.timeout(90_000),
  });
  if (!resp.ok)
    throw new Error(`Nedlasting feilet: ${resp.status} ${resp.statusText}`);
  const data = await resp.arrayBuffer();
  await writeFile(ARKIV_STI, Buffer.from(data));
}

async function hentLovHTML(lovID: string): Promise<string> {
  const arkivSti = lovIDTilArkivSti(lovID);
  const lokalFilnavn = arkivSti.replace("nl/", "");
  const lokalSti = join(LOVER_DIR, lokalFilnavn);

  try {
    await access(lokalSti);
    return await readFile(lokalSti, "utf-8");
  } catch {
    /* ikke cachet */
  }

  if (!(await finnesArkiv())) {
    await lastNedArkiv();
  }

  // encoding:"buffer" unngår Windows CP-1252-omvei som dobbelkoder UTF-8.
  // Relativ sti unngår at GNU tar (Git Bash) tolker "C:" som remote host.
  const result = spawnSync("tar", ["-xjOf", "gjeldende-lover.tar.bz2", arkivSti], {
    cwd: CACHE_DIR,
    encoding: "buffer",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
  });

  if (result.status !== 0 || !result.stdout?.length) {
    throw new Error(
      `Lov ${lovID} ikke funnet i arkivet. Sjekk at referansen er korrekt.`
    );
  }

  const html = result.stdout.toString("utf-8");
  await mkdir(LOVER_DIR, { recursive: true });
  await writeFile(lokalSti, html, "utf-8");
  return html;
}

export function registerLovdataVerktøy(server: McpServer): void {
  server.registerTool(
    "lookup_paragraf",
    {
      title: "Slå opp norsk lovparagraf",
      description:
        "Henter full tekst for en norsk lovparagraf fra Lovdata sitt offentlige datasett (NLOD 2.0-lisens). " +
        "Cacher lokalt — første kall laster ned skatteloven (~5 sek), " +
        "påfølgende kall er øyeblikkelige. " +
        "Alle gjeldende norske lover er tilgjengelige. " +
        "Eksempler: 'lov/1999-03-26-14/§5-1' (inntektsregel), " +
        "'lov/1999-03-26-14/§9-3' (boligsalg skattefritak), " +
        "'lov/1999-03-26-14/§10-12' (skjermingsfradrag), " +
        "'lov/1999-03-26-14/§10-31' (aksjegevinst).",
      inputSchema: {
        refID: z.string().describe(
          "Lovdata referanse-ID på formatet 'lov/{lov-id}/§{paragraf}'. " +
            "Skatteloven er lov/1999-03-26-14. " +
            "Eksempel: 'lov/1999-03-26-14/§9-3'"
        ),
      },
    },
    async ({ refID }) => {
      const feil = (tekst: string) => ({
        content: [{ type: "text" as const, text: tekst }],
        isError: true as const,
      });

      const parsed = parsRefID(refID);
      if (!parsed) {
        return feil(
          `Ugyldig refID: "${refID}". Forventet format: "lov/{lov-id}/§{paragraf}". ` +
            `Eksempel: "lov/1999-03-26-14/§9-3"`
        );
      }
      const { lovID, paragrafNr } = parsed;

      // Sjekk paragraf-cache
      await mkdir(PARAGRAF_DIR, { recursive: true });
      const cacheSti = join(PARAGRAF_DIR, `${sanitiserRefID(refID)}.json`);
      try {
        const cached = JSON.parse(
          await readFile(cacheSti, "utf-8")
        ) as CacheParagraf;
        const dato = cached.hentet.slice(0, 10);
        return {
          content: [
            {
              type: "text" as const,
              text: [
                cached.tittel,
                cached.lovnavn,
                "",
                cached.tekst,
                "",
                `Kilde: ${cached.url}`,
                `Hentet: ${dato} (fra cache)`,
              ].join("\n"),
            },
          ],
        };
      } catch {
        /* ingen cache */
      }

      // Hent HTML fra arkiv
      let html: string;
      try {
        html = await hentLovHTML(lovID);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("ikke funnet")) {
          return feil(`Paragraf ikke funnet: ${refID}`);
        }
        return feil(`Lovdata utilgjengelig — ${msg}`);
      }

      // Finn anker via TOC
      const anker = finnAnker(html, paragrafNr);
      if (!anker) {
        return feil(
          `Paragraf ikke funnet: ${refID}. ` +
            `Sjekk at paragrafnummeret er korrekt (f.eks. "§9-3", ikke "§ 9-3").`
        );
      }

      // Trekk ut tekst
      let tittel: string;
      let tekst: string;
      try {
        ({ tittel, tekst } = trekkUtTekst(html, anker, paragrafNr));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return feil(`Feil ved parsing av ${refID}: ${msg}`);
      }

      const lovnavn = `${hentLovTittel(html)} (lov ${lovID})`;
      const url = `https://lovdata.no/lov/${lovID}/§${paragrafNr}`;
      const hentet = new Date().toISOString();

      const cacheData: CacheParagraf = {
        refID,
        tittel,
        lovnavn,
        tekst,
        url,
        hentet,
      };
      try {
        await writeFile(cacheSti, JSON.stringify(cacheData, null, 2), "utf-8");
      } catch {
        /* cache-feil er ikke kritisk */
      }

      return {
        content: [
          {
            type: "text" as const,
            text: [
              tittel,
              lovnavn,
              "",
              tekst,
              "",
              `Kilde: ${url}`,
              `Hentet: ${hentet.slice(0, 10)}`,
            ].join("\n"),
          },
        ],
      };
    }
  );
}
