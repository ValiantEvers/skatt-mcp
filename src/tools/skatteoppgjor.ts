import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import satser2025 from "../data/satser/2025.json" with { type: "json" };
import fondKlassRaw from "../data/fond-klassifisering.json" with { type: "json" };
import {
  parseNordnetCsv,
  NordnetCsvFeil,
  type KanoniskTransaksjon,
} from "../lib/csv-parsers/nordnet.js";
import {
  kjørFifo,
  IkkeNokBeholdningFeil,
  type FifoTransaksjon,
  type Lot,
} from "../lib/fifo.js";
import {
  beregnPerIsin,
  type IsinBeregning,
  type KanoniskFondTransaksjon,
} from "./fond.js";

// ── Klassifiserings-config (samme kilde som fond.ts) ────────────────────────

interface FondKlassifiseringEntry {
  navn: string;
  tick_navn?: string;
  type: "aksje" | "aksjefond" | "rentefond" | "kombinasjonsfond" | "ukjent";
  aksjeandel_per_år?: Record<string, number>;
  regel?: string;
}

const klassifisering = fondKlassRaw as unknown as Record<
  string,
  FondKlassifiseringEntry
>;

// ── Hjelpere ────────────────────────────────────────────────────────────────

function formaterKr(n: number): string {
  return Math.round(n).toLocaleString("nb-NO");
}

function aar(dato: string): number {
  return parseInt(dato.substring(0, 4), 10);
}

// Nordnet eksporterer UTF-16 LE med BOM. Defensiv mot UTF-8/UTF-16 BE.
// (Identisk med dekoderen i import_nordnet.ts — duplisert bevisst for å holde
//  orkestratoren selvstendig.)
function dekodNordnetBuffer(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString("utf16le");
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const le = Buffer.alloc(buf.length - 2);
    for (let i = 2; i + 1 < buf.length; i += 2) {
      le[i - 2] = buf[i + 1];
      le[i - 1] = buf[i];
    }
    return le.toString("utf16le");
  }
  return buf.toString("utf-8");
}

const PARAGRAF_FOOTER = [
  "",
  "Relevante paragrafer:",
  "  lov/1999-03-26-14/§10-31  (Skatteplikt for gevinst og fradragsrett for tap)",
  "  lov/1999-03-26-14/§10-32  (Beregning av gevinst og tap)",
  "  lov/1999-03-26-14/§10-20  (Skattlegging av verdipapirfond og andelseiere)",
  "  lov/1999-03-26-14/§10-12  (Fradrag for skjerming)",
].join("\n");

// ── Aksje-realisering (samme logikk som aksjer.ts, men nøklet på ISIN) ───────

interface AksjeIsinResultat {
  isin: string;
  navn: string;
  gevinst_i_år: number; // netto for denne ISIN-en i rapporteringsåret
  antall_salg: number;
  gjenstående_lots: Lot[];
}

function beregnAksjeForIsin(
  isin: string,
  navn: string,
  trans: KanoniskTransaksjon[],
  rapporteringsår: number
): AksjeIsinResultat {
  const fifoTrans: FifoTransaksjon[] = trans.map((t) => ({
    type: t.type,
    dato: t.dato,
    antall: t.antall,
    pris_per_enhet: t.pris_per_aksje,
    transaksjonsgebyr: t.kurtasje,
  }));

  const res = kjørFifo(fifoTrans, `${isin} (${navn})`);
  const salgIÅr = res.salg.filter((s) => aar(s.dato) === rapporteringsår);
  const gevinst = salgIÅr.reduce((sum, s) => sum + s.gevinst, 0);

  return {
    isin,
    navn,
    gevinst_i_år: gevinst,
    antall_salg: salgIÅr.length,
    gjenstående_lots: res.lots,
  };
}

// ── MCP tool ────────────────────────────────────────────────────────────────

export function registerSkatteoppgjoerVerktøy(server: McpServer): void {
  const carrySchema = z.object({
    isin: z.string(),
    akkumulert_ubrukt_skjerming_inngaaende: z
      .number()
      .nonnegative()
      .describe(
        "Akkumulert ubrukt skjerming pr 31.12 forrige år for denne ISIN-en (kun fond)"
      ),
  });

  server.registerTool(
    "beregn_skatteoppgjoer_nordnet",
    {
      title: "Fullt skatteoppgjør fra Nordnet-eksport",
      description:
        "Tar en Nordnet transaksjons-eksport (filsti ELLER innlimt rå CSV-tekst), " +
        "parser den, grupperer per ISIN og ruter automatisk: rene aksjer kjøres " +
        "gjennom aksje-FIFO (oppjustering ×1,72), verdipapirfond gjennom fond-motoren " +
        "(per-lot snittsaksjeandel, skjerming, oppjustering kun på aksjedel). Returnerer " +
        "ett samlet skatteoppgjør for realiserte gevinster/tap i rapporteringsåret. " +
        "ISIN-er som mangler i fond-klassifisering.json rapporteres som handlingsbare " +
        "advarsler. Utbytte beregnes IKKE her — bruk calculate_skjermingsfradrag for det.",
      inputSchema: {
        csv_filsti: z
          .string()
          .optional()
          .describe("Absolutt sti til Nordnet CSV-eksport (UTF-16 LE TSV)"),
        csv_tekst: z
          .string()
          .optional()
          .describe("Rå CSV-tekst limt inn direkte (alternativ til csv_filsti)"),
        rapporteringsaar: z.number().int().min(2020).max(2025).default(2025),
        inngangs_carry_per_isin: z
          .array(carrySchema)
          .default([])
          .describe("Valgfri skjerming-carry inn til rapporteringsåret per fond-ISIN"),
      },
    },
    async ({ csv_filsti, csv_tekst, rapporteringsaar, inngangs_carry_per_isin }) => {
      // 0. Årssperre: satser finnes foreløpig kun for 2025
      //    (src/data/satser/2025.json). Schemaet tillater 2020–2025 for å være
      //    konsistent med aksjer.ts/krypto.ts (FIFO-historikk), men uten
      //    års-spesifikke satser ville et annet rapporteringsår fått 2025-
      //    skjermingsrente og -oppjusteringsfaktor påført stille — feil tall.
      //    Stopp eksplisitt heller enn å regne galt.
      const STØTTEDE_ÅR = [2025];
      if (!STØTTEDE_ÅR.includes(rapporteringsaar)) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                `Rapporteringsår ${rapporteringsaar} støttes ikke: satser finnes kun for ` +
                `${STØTTEDE_ÅR.join(", ")} (src/data/satser/). Legg til satser/<år>.json ` +
                `og utvid STØTTEDE_ÅR før skatteoppgjør for andre år kjøres.`,
            },
          ],
        };
      }

      // 1. Skaff CSV-innhold
      if (!csv_filsti && !csv_tekst) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: "Oppgi enten csv_filsti (sti til fil) eller csv_tekst (innlimt CSV).",
            },
          ],
        };
      }
      if (csv_filsti && csv_tekst) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: "Oppgi bare én av csv_filsti og csv_tekst, ikke begge.",
            },
          ],
        };
      }

      let innhold: string;
      if (csv_filsti) {
        try {
          const buf = await readFile(csv_filsti);
          innhold = dekodNordnetBuffer(buf);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            isError: true,
            content: [{ type: "text" as const, text: `Kunne ikke lese fil: ${msg}` }],
          };
        }
      } else {
        innhold = csv_tekst!;
      }

      // 2. Parse
      let parsed;
      try {
        parsed = parseNordnetCsv(innhold);
      } catch (err) {
        if (err instanceof NordnetCsvFeil) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: err.message }],
          };
        }
        throw err;
      }

      // 3. Grupper transaksjoner per ISIN
      const perIsin = new Map<string, KanoniskTransaksjon[]>();
      const utenIsin: string[] = [];
      for (const t of parsed.transaksjoner) {
        if (!t.isin) {
          utenIsin.push(`${t.dato} ${t.type} ${t.ticker}`);
          continue;
        }
        const liste = perIsin.get(t.isin) ?? [];
        liste.push(t);
        perIsin.set(t.isin, liste);
      }

      // 4. Ruting per ISIN
      const aksjeResultater: AksjeIsinResultat[] = [];
      const fondResultater: IsinBeregning[] = [];
      const ukjenteIsin: string[] = [];
      const feilPerIsin: string[] = [];

      const carryMap = new Map<string, number>();
      for (const c of inngangs_carry_per_isin) {
        carryMap.set(c.isin, c.akkumulert_ubrukt_skjerming_inngaaende);
      }

      const skjermingsrente = satser2025.skjermingsrente.personlige_aksjonærer;
      const oppjusteringsfaktor = satser2025.aksjeoppjustering.faktor;

      for (const [isin, tList] of perIsin) {
        const navn = tList[0]?.ticker ?? isin;
        const klass = klassifisering[isin];

        if (!klass || klass.type === "ukjent") {
          ukjenteIsin.push(`${isin}  ${navn}`);
          continue;
        }

        try {
          if (klass.type === "aksje") {
            aksjeResultater.push(
              beregnAksjeForIsin(isin, klass.navn || navn, tList, rapporteringsaar)
            );
          } else {
            const fondTrans: KanoniskFondTransaksjon[] = tList.map((t) => ({
              isin,
              type: t.type,
              dato: t.dato,
              antall: t.antall,
              pris_per_andel: t.pris_per_aksje,
              tegnings_innloesningsgebyr: t.kurtasje,
            }));
            fondResultater.push(
              beregnPerIsin({
                isin,
                trans: fondTrans,
                inngangs_carry: carryMap.get(isin) ?? 0,
                rapporteringsår: rapporteringsaar,
                skjermingsrente,
                oppjusteringsfaktor,
              })
            );
          }
        } catch (e) {
          if (e instanceof IkkeNokBeholdningFeil) {
            feilPerIsin.push(
              `${isin} (${navn}): ikke nok beholdning for salg ${e.dato} ` +
                `(forsøkt ${e.forsøkt}, tilgjengelig ${e.tilgjengelig})`
            );
          } else {
            feilPerIsin.push(`${isin} (${navn}): ${(e as Error).message}`);
          }
        }
      }

      // 5. Aggreger aksjer
      let aksjeSumGevinst = 0;
      let aksjeSumTap = 0;
      for (const r of aksjeResultater) {
        if (r.gevinst_i_år >= 0) aksjeSumGevinst += r.gevinst_i_år;
        else aksjeSumTap += r.gevinst_i_år;
      }
      const aksjeNetto = aksjeSumGevinst + aksjeSumTap;
      const aksjeOppjustert = aksjeNetto * oppjusteringsfaktor;
      const aksjeSkatt = aksjeOppjustert * 0.22;

      // 6. Aggreger fond
      let fondSumGevinst = 0;
      let fondSumTap = 0;
      let fondSkattAksje = 0;
      let fondSkattRente = 0;
      let fondBruktSkjerming = 0;
      let fondBortfaltSkjerming = 0;
      for (const r of fondResultater) {
        for (const s of r.salg_i_år) {
          if (s.gevinst >= 0) fondSumGevinst += s.gevinst;
          else fondSumTap += s.gevinst;
          fondSkattAksje += s.skatt_aksjedel;
          fondSkattRente += s.skatt_rentedel;
        }
        fondBruktSkjerming += r.brukt_skjerming_total;
        fondBortfaltSkjerming += r.bortfalt_skjerming;
      }
      const fondSkatt = fondSkattAksje + fondSkattRente;

      const totalSkatt = aksjeSkatt + fondSkatt;

      // 7. Bygg output
      const skjermingsrenteProsent = (skjermingsrente * 100)
        .toFixed(1)
        .replace(".", ",");

      const L: string[] = [
        `Skatteoppgjør fra Nordnet — rapporteringsår ${rapporteringsaar}`,
        `Skjermingsrente: ${skjermingsrenteProsent} %, oppjusteringsfaktor: ${oppjusteringsfaktor}`,
        `Kilde: ${csv_filsti ?? "innlimt CSV-tekst"}`,
        `Transaksjoner parset: ${parsed.transaksjoner.length} ` +
          `(${parsed.oppsummering.antall_kjøp} kjøp, ${parsed.oppsummering.antall_salg} salg), ` +
          `${perIsin.size} unike ISIN-er`,
        ``,
        `══════════ AKSJER ══════════`,
      ];

      if (aksjeResultater.length === 0) {
        L.push(`  Ingen rene aksjer å rapportere.`);
      } else {
        for (const r of aksjeResultater) {
          if (r.antall_salg === 0) {
            L.push(`  ${r.isin}  ${r.navn}: ingen salg i ${rapporteringsaar}`);
          } else {
            const tegn = r.gevinst_i_år >= 0 ? "gevinst" : "tap";
            L.push(
              `  ${r.isin}  ${r.navn}: ${r.antall_salg} salg → ${tegn} ${formaterKr(Math.abs(r.gevinst_i_år))}`
            );
          }
        }
        L.push(``);
        L.push(`  Sum gevinst:            ${formaterKr(aksjeSumGevinst).padStart(12)}`);
        L.push(`  Sum tap:                ${formaterKr(aksjeSumTap).padStart(12)}`);
        L.push(`  Netto realisert:        ${formaterKr(aksjeNetto).padStart(12)}`);
        L.push(`  Oppjustert (×${oppjusteringsfaktor}):    ${formaterKr(aksjeOppjustert).padStart(12)}`);
        L.push(`  Skatt aksjer (22 %):    ${formaterKr(aksjeSkatt).padStart(12)}`);
      }

      L.push(``, `══════════ VERDIPAPIRFOND ══════════`);
      if (fondResultater.length === 0) {
        L.push(`  Ingen fond å rapportere.`);
      } else {
        for (const r of fondResultater) {
          const totG = r.salg_i_år.reduce((s, x) => s + x.gevinst, 0);
          if (r.salg_i_år.length === 0) {
            L.push(
              `  ${r.isin}  ${r.navn} (${r.fondslabel}): ingen salg i ${rapporteringsaar}`
            );
          } else {
            const tegn = totG >= 0 ? "gevinst" : "tap";
            const skattIsin = r.salg_i_år.reduce(
              (s, x) => s + x.skatt_aksjedel + x.skatt_rentedel,
              0
            );
            L.push(
              `  ${r.isin}  ${r.navn} (${r.fondslabel}): ${r.salg_i_år.length} salg → ` +
                `${tegn} ${formaterKr(Math.abs(totG))}, skatt ${formaterKr(skattIsin)}`
            );
          }
        }
        L.push(``);
        L.push(`  Sum gevinst:            ${formaterKr(fondSumGevinst).padStart(12)}`);
        L.push(`  Sum tap:                ${formaterKr(fondSumTap).padStart(12)}`);
        L.push(`  Skatt aksjedel (22 %):  ${formaterKr(fondSkattAksje).padStart(12)}`);
        L.push(`  Skatt rentedel (22 %):  ${formaterKr(fondSkattRente).padStart(12)}`);
        L.push(`  Skatt fond totalt:      ${formaterKr(fondSkatt).padStart(12)}`);
        L.push(`  Brukt skjerming:        ${formaterKr(fondBruktSkjerming).padStart(12)}`);
        if (fondBortfaltSkjerming > 0) {
          L.push(`  Bortfalt skjerming:     ${formaterKr(fondBortfaltSkjerming).padStart(12)}`);
        }
      }

      L.push(``, `══════════ SAMLET ══════════`);
      L.push(`  Skatt aksjer:           ${formaterKr(aksjeSkatt).padStart(12)}`);
      L.push(`  Skatt fond:             ${formaterKr(fondSkatt).padStart(12)}`);
      L.push(
        `  ${totalSkatt >= 0 ? "SAMLET SKATT" : "SAMLET SKATTEFRADRAG"}:           ${formaterKr(totalSkatt).padStart(12)}`
      );

      // 8. Advarsler / oppfølging
      const advarsler: string[] = [];
      if (ukjenteIsin.length > 0) {
        advarsler.push(
          `${ukjenteIsin.length} ISIN-er mangler/ukjent i fond-klassifisering.json ` +
            `(ikke med i beregningen — legg til entry og kjør på nytt):`
        );
        for (const u of ukjenteIsin) advarsler.push(`    ${u}`);
      }
      if (feilPerIsin.length > 0) {
        advarsler.push(`${feilPerIsin.length} ISIN-er feilet under beregning:`);
        for (const f of feilPerIsin) advarsler.push(`    ${f}`);
      }
      if (utenIsin.length > 0) {
        advarsler.push(
          `${utenIsin.length} transaksjoner manglet ISIN i eksporten (hoppet over).`
        );
      }

      // Utbytte-rader (havner i hoppet_over som UTBYTTE) — informativ påminnelse
      const antallUtbytte = parsed.hoppet_over.filter(
        (h) => h.transaksjonstype === "UTBYTTE"
      ).length;
      const antallKreverManuell = parsed.hoppet_over.filter((h) =>
        [
          "BYTTE INNLEGG VP",
          "BYTTE UTTAK VP",
          "SPLITT INNLEGG VP",
          "SPLITT UTTAK VP",
          "REINVESTERT UTBYTTE",
        ].includes(h.transaksjonstype)
      ).length;
      if (antallUtbytte > 0) {
        advarsler.push(
          `${antallUtbytte} utbytte-rader funnet — IKKE inkludert her. ` +
            `Bruk calculate_skjermingsfradrag for utbytteskatt.`
        );
      }
      if (antallKreverManuell > 0) {
        advarsler.push(
          `${antallKreverManuell} rader (bytte/splitt/reinvestert utbytte) krever manuell ` +
            `lot-justering før FIFO — se import_transaksjoner_nordnet for detaljer.`
        );
      }

      if (advarsler.length > 0) {
        L.push(``, `══════════ ADVARSLER / OPPFØLGING ══════════`);
        for (const a of advarsler) L.push(`  ${a}`);
      }

      L.push(PARAGRAF_FOOTER);
      L.push(
        ``,
        `Merk: kun realiserte gevinster/tap er beregnet. Utbytte, formuesverdi og ` +
          `andre poster må beregnes med de respektive verktøyene.`
      );

      return {
        content: [{ type: "text" as const, text: L.join("\n") }],
      };
    }
  );
}
