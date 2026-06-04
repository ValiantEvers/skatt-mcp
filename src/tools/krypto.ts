import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ParagrafRef } from "./lovdata.js";
import {
  kjørFifo,
  IkkeNokBeholdningFeil,
  type FifoSalgsResultat,
  type FifoTransaksjon,
  type Lot,
} from "../lib/fifo.js";

type RealisertSalg = FifoSalgsResultat & { rapportert: boolean };

function formaterKr(n: number): string {
  return Math.round(n).toLocaleString("nb-NO");
}

function formaterAntall(n: number): string {
  return n.toLocaleString("nb-NO", { maximumFractionDigits: 8 });
}

function paragrafBlokk(refs: ParagrafRef[]): string {
  return ["", "Relevante paragrafer:",
    ...refs.map(r => `  ${r.refID.padEnd(28)} (${r.tittel})`),
  ].join("\n");
}

const PARAGRAFER_KRYPTO: ParagrafRef[] = [
  { refID: "lov/1999-03-26-14/§5-1", tittel: "Hovedregel om inntekt" },
  { refID: "lov/1999-03-26-14/§9-2", tittel: "Hva realisasjon omfatter" },
  { refID: "lov/1999-03-26-14/§9-3", tittel: "Skattefritak for visse realisasjonsgevinster" },
];

export function registerKryptoVerktøy(server: McpServer): void {
  const transaksjonSchema = z.object({
    valuta: z
      .string()
      .min(1)
      .describe("Valutasymbol, f.eks. 'BTC' eller 'ETH'"),
    type: z.enum(["kjøp", "salg"]),
    dato: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe("ISO-dato YYYY-MM-DD"),
    antall: z
      .number()
      .positive()
      .describe("Antall enheter i transaksjonen (kan være fraksjonelt)"),
    pris_per_enhet: z
      .number()
      .nonnegative()
      .describe("Pris per enhet i NOK"),
    gebyr: z
      .number()
      .nonnegative()
      .default(0)
      .describe("Total transaksjonsgebyr i NOK"),
  });

  server.registerTool(
    "calculate_kryptogevinst",
    {
      title: "Beregn kryptogevinst/-tap (FIFO)",
      description:
        "Beregner realisert kryptogevinst og -tap per valuta med FIFO-metoden. " +
        "Multi-valuta støttes — beregnes separat per valuta. " +
        "FIFO-grupperingen er per valuta uavhengig av kilde-børs/konto. " +
        "Ingen oppjustering, ingen skjermingsfradrag — krypto skattlegges flat 22 % på netto. " +
        "Tap er fradragsberettiget. Viser per-salg-breakdown, aggregerte totaler og gjenstående lots.",
      inputSchema: {
        transaksjoner: z
          .array(transaksjonSchema)
          .min(1)
          .describe("Liste over alle transaksjoner. Multi-valuta støttes."),
        rapporteringsaar: z
          .number()
          .int()
          .min(2020)
          .max(2025)
          .default(2025)
          .describe(
            "Rapporteringsår. Salg utenfor dette året påvirker FIFO-historikk, men ikke rapporterte totaler."
          ),
      },
    },
    async ({ transaksjoner, rapporteringsaar }) => {
      // Grupper per valuta (insertion-order bevart via Map)
      const perValuta = new Map<string, typeof transaksjoner>();
      for (const t of transaksjoner) {
        const liste = perValuta.get(t.valuta) ?? [];
        liste.push(t);
        perValuta.set(t.valuta, liste);
      }

      // Kjør FIFO per valuta via delt lib
      type ValutaResultat = {
        valuta: string;
        realiserteSalg: RealisertSalg[];
        lots: Lot[];
      };

      const resultater: ValutaResultat[] = [];
      const feilmeldinger: string[] = [];

      for (const [valuta, tList] of perValuta) {
        const fifoTrans: FifoTransaksjon[] = tList.map((t) => ({
          type: t.type,
          dato: t.dato,
          antall: t.antall,
          pris_per_enhet: t.pris_per_enhet,
          transaksjonsgebyr: t.gebyr,
        }));

        try {
          const res = kjørFifo(fifoTrans, valuta);
          const realiserteSalg: RealisertSalg[] = res.salg.map((s) => ({
            ...s,
            rapportert:
              parseInt(s.dato.substring(0, 4), 10) === rapporteringsaar,
          }));
          resultater.push({ valuta, realiserteSalg, lots: res.lots });
        } catch (e) {
          if (e instanceof IkkeNokBeholdningFeil) {
            feilmeldinger.push(
              `Ikke nok krypto for salg — ` +
                `valuta: ${e.identifikator}, dato: ${e.dato}, ` +
                `forsøkt: ${formaterAntall(e.forsøkt)}, tilgjengelig: ${formaterAntall(e.tilgjengelig)}`
            );
          } else {
            throw e;
          }
        }
      }

      if (feilmeldinger.length > 0) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: feilmeldinger.join("\n"),
            },
          ],
        };
      }

      // Aggreger rapporterte salg
      let sumGevinst = 0;
      let sumTap = 0;
      for (const r of resultater) {
        for (const s of r.realiserteSalg) {
          if (!s.rapportert) continue;
          if (s.gevinst >= 0) sumGevinst += s.gevinst;
          else sumTap += s.gevinst;
        }
      }

      const netto = sumGevinst + sumTap;
      const implisertSkatt = netto * 0.22;

      // Bygg output
      const linjer: string[] = [
        `Kryptogevinst — rapporteringsår ${rapporteringsaar}`,
        ``,
        `Per valuta:`,
      ];

      for (const r of resultater) {
        const rapporterte = r.realiserteSalg.filter((s) => s.rapportert);
        const historiske = r.realiserteSalg.filter((s) => !s.rapportert);

        if (rapporterte.length === 0) {
          linjer.push(`  ${r.valuta} — ingen realiserte salg i ${rapporteringsaar}`);
          for (const s of historiske) {
            linjer.push(
              `    ${s.dato}: solgte ${formaterAntall(s.antall)} @ ${formaterKr(s.pris_per_enhet)}, ` +
                `salgssum netto ${formaterKr(s.salgssum_netto)}, kostbase ${formaterKr(s.kostbase)} ` +
                `→ ${s.gevinst >= 0 ? "gevinst" : "tap"} ${formaterKr(s.gevinst)} (utenfor rapporteringsår)`
            );
          }
        } else {
          const valutaNetto = rapporterte.reduce((sum, s) => sum + s.gevinst, 0);
          linjer.push(
            `  ${r.valuta} — ${rapporterte.length} realisert${rapporterte.length !== 1 ? "e" : ""} salg i ${rapporteringsaar}`
          );
          for (const s of rapporterte) {
            linjer.push(
              `    ${s.dato}: solgte ${formaterAntall(s.antall)} @ ${formaterKr(s.pris_per_enhet)}, ` +
                `salgssum netto ${formaterKr(s.salgssum_netto)}, kostbase ${formaterKr(s.kostbase)} ` +
                `→ ${s.gevinst >= 0 ? "gevinst" : "tap"} ${formaterKr(s.gevinst)}`
            );
          }
          linjer.push(
            `    Sum: ${valutaNetto >= 0 ? "gevinst" : "tap"} ${formaterKr(valutaNetto)}`
          );
        }
        linjer.push(``);
      }

      linjer.push(
        `Aggregert:`,
        `  Sum gevinst:              ${formaterKr(sumGevinst).padStart(12)}`,
        `  Sum tap:                  ${formaterKr(sumTap).padStart(12)}`,
        `  Netto realisert:          ${formaterKr(netto).padStart(12)}`,
        `  Implisert skatt (22 %):   ${formaterKr(implisertSkatt).padStart(12)}`,
        ``,
        `Gjenstående lots:`
      );

      for (const r of resultater) {
        const totalAntall = r.lots.reduce(
          (sum, lot) => sum + lot.antall_gjenstående,
          0
        );
        if (totalAntall === 0) {
          linjer.push(`  ${r.valuta}: 0 enheter`);
        } else {
          for (const lot of r.lots) {
            if (lot.antall_gjenstående > 0) {
              const lotKostbase = lot.antall_gjenstående * lot.kostpris_per_enhet;
              linjer.push(
                `  ${r.valuta}: ${formaterAntall(lot.antall_gjenstående)} enheter ` +
                  `(fra ${lot.dato} @ kostpris ${formaterKr(lot.kostpris_per_enhet)}/enhet, ` +
                  `kostbase ${formaterKr(lotKostbase)})`
              );
            }
          }
        }
      }

      linjer.push(paragrafBlokk(PARAGRAFER_KRYPTO));

      return {
        content: [{ type: "text" as const, text: linjer.join("\n") }],
      };
    }
  );
}
