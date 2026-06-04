import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import {
  parseNordnetCsv,
  NordnetCsvFeil,
  type NordnetParseResultat,
} from "../lib/csv-parsers/nordnet.js";

function dekodNordnetBuffer(buf: Buffer): string {
  // Nordnet eksporterer UTF-16 LE med BOM. Defensiv: håndter også UTF-8 hvis bruker
  // har konvertert filen, og UTF-16 BE som krever byte-swap.
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString("utf16le");
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16 BE — bytt om byte-par til LE og dekod
    const le = Buffer.alloc(buf.length - 2);
    for (let i = 2; i + 1 < buf.length; i += 2) {
      le[i - 2] = buf[i + 1];
      le[i - 1] = buf[i];
    }
    return le.toString("utf16le");
  }
  // Antatt UTF-8 (med eller uten BOM — parseNordnetCsv stripper BOM internt)
  return buf.toString("utf-8");
}

function formaterOutput(
  filsti: string,
  resultat: NordnetParseResultat
): string {
  const linjer: string[] = [
    `Nordnet-import: ${filsti}`,
    ``,
    `Oppsummering:`,
    `  Antall kjøp:                ${resultat.oppsummering.antall_kjøp}`,
    `  Antall salg:                ${resultat.oppsummering.antall_salg}`,
    `  Antall hoppet over:         ${resultat.oppsummering.antall_hoppet_over}`,
    `  Periode:                    ${resultat.oppsummering.periode.fra || "(ingen)"} → ${resultat.oppsummering.periode.til || "(ingen)"}`,
    `  Native valutaer:            ${resultat.oppsummering.valutaer_native.join(", ") || "(ingen)"}`,
    `  Unike verdipapirer:         ${resultat.oppsummering.antall_unike_verdipapirer}`,
    ``,
  ];

  // Klassifisering — gruppert
  const grupper = new Map<string, string[]>();
  for (const [verdipapir, kategori] of Object.entries(
    resultat.klassifisering_hint
  )) {
    if (!grupper.has(kategori)) grupper.set(kategori, []);
    grupper.get(kategori)!.push(verdipapir);
  }

  linjer.push(`Klassifiseringshint per kategori:`);
  const kategoriRekkefølge: Array<keyof typeof KATEGORI_ETIKETT> = [
    "aksje",
    "fond_aksje_sannsynlig",
    "fond_rente_sannsynlig",
    "etf",
    "ukjent",
  ];
  const KATEGORI_ETIKETT = {
    aksje: "Ren aksje",
    fond_aksje_sannsynlig: "Aksjefond (sannsynlig)",
    fond_rente_sannsynlig: "Rentefond (sannsynlig)",
    etf: "ETF",
    ukjent: "Ukjent",
  } as const;

  for (const kat of kategoriRekkefølge) {
    const liste = grupper.get(kat);
    if (!liste || liste.length === 0) continue;
    linjer.push(`  ${KATEGORI_ETIKETT[kat]} (${liste.length}):`);
    for (const navn of liste.sort()) {
      linjer.push(`    - ${navn}`);
    }
  }

  // Hoppet over — gruppert per type med antall
  if (resultat.hoppet_over.length > 0) {
    const perType = new Map<string, number>();
    for (const h of resultat.hoppet_over) {
      perType.set(h.transaksjonstype, (perType.get(h.transaksjonstype) ?? 0) + 1);
    }
    linjer.push(``, `Hoppet over (per type):`);
    const sortert = [...perType.entries()].sort((a, b) => b[1] - a[1]);
    for (const [type, antall] of sortert) {
      linjer.push(`  ${type}: ${antall}`);
    }

    // Detaljer for typer som krever brukers oppmerksomhet
    const krevsOppfølging = resultat.hoppet_over.filter((h) =>
      [
        "BYTTE INNLEGG VP",
        "BYTTE UTTAK VP",
        "SPLITT INNLEGG VP",
        "SPLITT UTTAK VP",
        "REINVESTERT UTBYTTE",
      ].includes(h.transaksjonstype)
    );
    if (krevsOppfølging.length > 0) {
      linjer.push(``, `Krever manuell oppfølging:`);
      for (const h of krevsOppfølging) {
        linjer.push(`  Linje ${h.rad_nr}: ${h.grunn}`);
      }
    }
  }

  // Embed full JSON for nedstrøms verktøy
  linjer.push(
    ``,
    `For neste verktøy (calculate_aksjegevinst e.l.) — kopier transaksjons-arrayet:`,
    `\`\`\`json`,
    JSON.stringify(resultat, null, 2),
    `\`\`\``
  );

  return linjer.join("\n");
}

export function registerImportNordnetVerktøy(server: McpServer): void {
  server.registerTool(
    "import_transaksjoner_nordnet",
    {
      title: "Import transaksjoner fra Nordnet-CSV",
      description:
        "Leser en Nordnet transaksjons-eksport (UTF-16 LE TSV) og returnerer kanonisk transaksjons-array klar for calculate_aksjegevinst, sammen med klassifiseringshint per verdipapir og rapport over hoppet-over rader. Bare KJØPT/SALG/INNLEGG OVERFØRING blir oversatt til transaksjoner — alle andre rad-typer havner i hoppet_over med begrunnelse.",
      inputSchema: {
        filsti: z
          .string()
          .min(1)
          .describe("Absolutt sti til Nordnet CSV-eksport"),
      },
    },
    async ({ filsti }) => {
      let buf: Buffer;
      try {
        buf = await readFile(filsti);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [
            { type: "text" as const, text: `Kunne ikke lese fil: ${msg}` },
          ],
        };
      }

      const innhold = dekodNordnetBuffer(buf);

      let resultat: NordnetParseResultat;
      try {
        resultat = parseNordnetCsv(innhold);
      } catch (err) {
        if (err instanceof NordnetCsvFeil) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: err.message }],
          };
        }
        throw err;
      }

      return {
        content: [
          { type: "text" as const, text: formaterOutput(filsti, resultat) },
        ],
      };
    }
  );
}
