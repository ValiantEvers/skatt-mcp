import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import satser2025 from "../data/satser/2025.json" with { type: "json" };
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

function formaterKrDesimal(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  const harDesimaler = rounded % 1 !== 0;
  return rounded.toLocaleString("nb-NO", {
    minimumFractionDigits: harDesimaler ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

function hentOppjusteringsfaktor(rapporteringsår: number): number {
  if (rapporteringsår === 2025) return satser2025.aksjeoppjustering.faktor;
  throw new Error(
    `Aksjeoppjusteringsfaktor for ${rapporteringsår} er ikke implementert ennå — kun 2025 støttes`
  );
}

function paragrafBlokk(refs: ParagrafRef[]): string {
  return ["", "Relevante paragrafer:",
    ...refs.map(r => `  ${r.refID.padEnd(28)} (${r.tittel})`),
  ].join("\n");
}

const PARAGRAFER_AKSJEGEVINST: ParagrafRef[] = [
  { refID: "lov/1999-03-26-14/§10-31", tittel: "Skatteplikt for gevinst og fradragsrett for tap" },
  { refID: "lov/1999-03-26-14/§10-32", tittel: "Beregning av gevinst og tap" },
  { refID: "lov/1999-03-26-14/§10-33", tittel: "Skattemessig kontinuitet ved arv og gave av visse aksjer og andeler" },
];

const PARAGRAFER_SKJERMING: ParagrafRef[] = [
  { refID: "lov/1999-03-26-14/§10-12", tittel: "Fradrag for skjerming" },
];

export function registerAksjeVerktøy(server: McpServer): void {
  const transaksjonSchema = z.object({
    ticker: z
      .string()
      .min(1)
      .describe("Tickersymbol, f.eks. 'EQNR' eller 'AAPL'"),
    type: z.enum(["kjøp", "salg"]),
    dato: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe("ISO-dato YYYY-MM-DD"),
    antall: z.number().positive().describe("Antall aksjer i transaksjonen"),
    pris_per_aksje: z
      .number()
      .nonnegative()
      .describe("Pris per aksje i NOK"),
    kurtasje: z
      .number()
      .nonnegative()
      .default(0)
      .describe("Total kurtasje for transaksjonen i NOK"),
  });

  server.registerTool(
    "calculate_aksjegevinst",
    {
      title: "Beregn aksjegevinst/-tap (FIFO)",
      description:
        "Beregner realisert aksjegevinst og -tap per ticker med FIFO-metoden. " +
        "Multi-ticker støttes — beregnes separat per ticker. " +
        "Inkluderer aksjeoppjustering og implisert skatt (22 %). " +
        "Viser per-salg-breakdown, aggregerte totaler og gjenstående lots.",
      inputSchema: {
        transaksjoner: z
          .array(transaksjonSchema)
          .min(1)
          .describe(
            "Liste over alle transaksjoner. Multi-ticker støttes."
          ),
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
      // Les oppjusteringsfaktor fra satser — ikke hardkodet
      let oppjusteringsfaktor: number;
      try {
        oppjusteringsfaktor = hentOppjusteringsfaktor(rapporteringsaar);
      } catch (e) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: (e as Error).message }],
        };
      }

      // Grupper per ticker (insertion-order bevart via Map)
      const perTicker = new Map<string, typeof transaksjoner>();
      for (const t of transaksjoner) {
        const liste = perTicker.get(t.ticker) ?? [];
        liste.push(t);
        perTicker.set(t.ticker, liste);
      }

      // Kjør FIFO per ticker via delt lib
      type TickerResultat = {
        ticker: string;
        realiserteSalg: RealisertSalg[];
        lots: Lot[];
      };

      const resultater: TickerResultat[] = [];
      const feilmeldinger: string[] = [];

      for (const [ticker, tList] of perTicker) {
        const fifoTrans: FifoTransaksjon[] = tList.map((t) => ({
          type: t.type,
          dato: t.dato,
          antall: t.antall,
          pris_per_enhet: t.pris_per_aksje,
          transaksjonsgebyr: t.kurtasje,
        }));

        try {
          const res = kjørFifo(fifoTrans, ticker);
          const realiserteSalg: RealisertSalg[] = res.salg.map((s) => ({
            ...s,
            rapportert:
              parseInt(s.dato.substring(0, 4), 10) === rapporteringsaar,
          }));
          resultater.push({ ticker, realiserteSalg, lots: res.lots });
        } catch (e) {
          if (e instanceof IkkeNokBeholdningFeil) {
            feilmeldinger.push(
              `Ikke nok aksjer for salg — ` +
                `ticker: ${e.identifikator}, dato: ${e.dato}, ` +
                `forsøkt: ${e.forsøkt}, tilgjengelig: ${e.tilgjengelig}`
            );
          } else {
            throw e;
          }
        }
      }

      // Returner samlet feil dersom noe gikk galt
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
      const oppjustert = netto * oppjusteringsfaktor;
      const implisertSkatt = oppjustert * 0.22;

      // Bygg output
      const linjer: string[] = [
        `Aksjegevinst — rapporteringsår ${rapporteringsaar}`,
        ``,
        `Per ticker:`,
      ];

      for (const r of resultater) {
        const rapporterte = r.realiserteSalg.filter((s) => s.rapportert);
        const historiske = r.realiserteSalg.filter((s) => !s.rapportert);

        if (rapporterte.length === 0) {
          linjer.push(`  ${r.ticker} — ingen realiserte salg i ${rapporteringsaar}`);
          for (const s of historiske) {
            linjer.push(
              `    ${s.dato}: solgte ${s.antall} @ ${formaterKr(s.pris_per_enhet)}, ` +
                `salgssum netto ${formaterKr(s.salgssum_netto)}, kostbase ${formaterKr(s.kostbase)} ` +
                `→ ${s.gevinst >= 0 ? "gevinst" : "tap"} ${formaterKr(s.gevinst)} (utenfor rapporteringsår)`
            );
          }
        } else {
          const tickerNetto = rapporterte.reduce((sum, s) => sum + s.gevinst, 0);
          linjer.push(
            `  ${r.ticker} — ${rapporterte.length} realisert${rapporterte.length !== 1 ? "e" : ""} salg i ${rapporteringsaar}`
          );
          for (const s of rapporterte) {
            linjer.push(
              `    ${s.dato}: solgte ${s.antall} @ ${formaterKr(s.pris_per_enhet)}, ` +
                `salgssum netto ${formaterKr(s.salgssum_netto)}, kostbase ${formaterKr(s.kostbase)} ` +
                `→ ${s.gevinst >= 0 ? "gevinst" : "tap"} ${formaterKr(s.gevinst)}`
            );
          }
          linjer.push(
            `    Sum: ${tickerNetto >= 0 ? "gevinst" : "tap"} ${formaterKr(tickerNetto)}`
          );
        }
        linjer.push(``);
      }

      linjer.push(
        `Aggregert:`,
        `  Sum gevinst:              ${formaterKr(sumGevinst).padStart(12)}`,
        `  Sum tap:                  ${formaterKr(sumTap).padStart(12)}`,
        `  Netto realisert:          ${formaterKr(netto).padStart(12)}`,
        `  Oppjustert (×${oppjusteringsfaktor}):      ${formaterKr(oppjustert).padStart(12)}`,
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
          linjer.push(`  ${r.ticker}: 0 aksjer`);
        } else {
          for (const lot of r.lots) {
            if (lot.antall_gjenstående > 0) {
              const lotKostbase = lot.antall_gjenstående * lot.kostpris_per_enhet;
              linjer.push(
                `  ${r.ticker}: ${lot.antall_gjenstående} aksjer ` +
                  `(fra ${lot.dato} @ kostpris ${formaterKr(lot.kostpris_per_enhet)}/aksje, ` +
                  `kostbase ${formaterKr(lotKostbase)})`
              );
            }
          }
        }
      }

      linjer.push(paragrafBlokk(PARAGRAFER_AKSJEGEVINST));

      return {
        content: [{ type: "text" as const, text: linjer.join("\n") }],
      };
    }
  );

  // ── calculate_skjermingsfradrag ──────────────────────────────────────────

  const innehavSchema = z.object({
    ticker: z.string().min(1),
    antall_aksjer_31_12: z
      .number()
      .nonnegative()
      .describe("Antall aksjer eid per 31.12 i rapporteringsåret"),
    total_kostbase: z
      .number()
      .nonnegative()
      .describe("Sum kostpris for alle eide aksjer (inkl. kurtasje fra kjøp)"),
    akkumulert_ubrukt_skjerming: z
      .number()
      .nonnegative()
      .default(0)
      .describe("Ubrukt skjerming overført fra tidligere år (NOK)"),
  });

  const utbytteSchema = z.object({
    ticker: z.string().min(1),
    beloep_per_aksje: z.number().nonnegative(),
    antall_aksjer_paa_utbytte_dato: z.number().positive(),
    dato: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  });

  server.registerTool(
    "calculate_skjermingsfradrag",
    {
      title: "Beregn skjermingsfradrag",
      description:
        "Beregner skjermingsfradrag for utbytte på personlig-eide aksjer. " +
        "Multi-ticker støttes. Viser årets skjerming, brukt/ubrukt mot utbytte, " +
        "ny akkumulert ubrukt (carry-forward) og skattepliktig utbytte per ticker.",
      inputSchema: {
        innehav: z
          .array(innehavSchema)
          .describe(
            "Aksjebeholdning per 31.12. Tomt array = ingen skjerming."
          ),
        utbytter: z
          .array(utbytteSchema)
          .default([])
          .describe("Utbytter mottatt i rapporteringsåret."),
        rapporteringsaar: z
          .number()
          .int()
          .min(2025)
          .max(2025)
          .default(2025),
      },
    },
    async ({ innehav, utbytter, rapporteringsaar }) => {
      const skjermingsrente =
        satser2025.skjermingsrente.personlige_aksjonærer;
      const oppjusteringsfaktor = satser2025.aksjeoppjustering.faktor;
      const renteProsent = (skjermingsrente * 100)
        .toFixed(1)
        .replace(".", ",");

      // Tom case
      if (innehav.length === 0 && utbytter.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Skjermingsfradrag — rapporteringsår ${rapporteringsaar}`,
                `Skjermingsrente: ${renteProsent} %`,
                ``,
                `Ingen aksjebeholdning rapportert.`,
                ``,
                `Aggregert:`,
                `  Total skjerming:                          0`,
                `  Total utbytte mottatt:                    0`,
                `  Total skattepliktig utbytte:              0`,
                `  Oppjustert (×${oppjusteringsfaktor}):                       0`,
                `  Implisert skatt (22 %):                   0`,
              ].join("\n"),
            },
          ],
        };
      }

      // Grupper utbytter per ticker
      const utbytterPerTicker = new Map<string, typeof utbytter>();
      for (const u of utbytter) {
        const liste = utbytterPerTicker.get(u.ticker) ?? [];
        liste.push(u);
        utbytterPerTicker.set(u.ticker, liste);
      }

      // Finn utbytte-tickers uten tilsvarende innehav (warning-tickers)
      const innehavTickers = new Set(innehav.map((h) => h.ticker));
      const warningTickers: string[] = [];
      for (const ticker of utbytterPerTicker.keys()) {
        if (!innehavTickers.has(ticker)) warningTickers.push(ticker);
      }

      let totalSkjerming = 0;
      let totalUtbytte = 0;
      let totalSkattepliktig = 0;

      const linjer: string[] = [
        `Skjermingsfradrag — rapporteringsår ${rapporteringsaar}`,
        `Skjermingsrente: ${renteProsent} %`,
        ``,
        `Per ticker:`,
      ];

      // Prosesser innehav-tickers
      for (const h of innehav) {
        const tickerUtbytter = utbytterPerTicker.get(h.ticker) ?? [];
        const sumUtbytte = tickerUtbytter.reduce(
          (sum, u) => sum + u.beloep_per_aksje * u.antall_aksjer_paa_utbytte_dato,
          0
        );
        totalUtbytte += sumUtbytte;

        if (h.antall_aksjer_31_12 === 0) {
          // Eid 0 per 31.12 → ingen skjerming
          linjer.push(
            `  ${h.ticker} — ikke eid 31.12 → ingen skjerming`
          );
          if (sumUtbytte > 0) {
            linjer.push(
              `    Utbytte mottatt:           ${formaterKr(sumUtbytte).padStart(12)}`,
              `    Brukt skjerming:                        0`,
              `    Skattepliktig utbytte:     ${formaterKr(sumUtbytte).padStart(12)}`
            );
            totalSkattepliktig += sumUtbytte;
          }
          linjer.push(``);
          continue;
        }

        const skjermingsgrunnlag =
          h.total_kostbase + h.akkumulert_ubrukt_skjerming;
        const åresSkjerming = skjermingsgrunnlag * skjermingsrente;
        const bruktSkjerming = Math.min(åresSkjerming, sumUtbytte);
        const ubruktDette = åresSkjerming - bruktSkjerming;
        const nyAkkumulert = h.akkumulert_ubrukt_skjerming + ubruktDette;
        const skattepliktig = Math.max(0, sumUtbytte - åresSkjerming);

        totalSkjerming += åresSkjerming;
        totalSkattepliktig += skattepliktig;

        linjer.push(
          `  ${h.ticker} — ${h.antall_aksjer_31_12} aksjer eid 31.12`,
          `    Skjermingsgrunnlag:        ${formaterKrDesimal(skjermingsgrunnlag).padStart(12)}  (kostbase ${formaterKr(h.total_kostbase)} + akkumulert ${formaterKr(h.akkumulert_ubrukt_skjerming)})`,
          `    Årets skjerming:           ${formaterKrDesimal(åresSkjerming).padStart(12)}  (${formaterKr(skjermingsgrunnlag)} × ${renteProsent} %)`,
          `    Utbytte mottatt:           ${formaterKrDesimal(sumUtbytte).padStart(12)}`,
          `    Brukt skjerming:           ${formaterKrDesimal(bruktSkjerming).padStart(12)}`,
          `    Ubrukt dette år:           ${formaterKrDesimal(ubruktDette).padStart(12)}`,
          `    Ny akkumulert ubrukt:      ${formaterKrDesimal(nyAkkumulert).padStart(12)}`,
          `    Skattepliktig utbytte:     ${formaterKrDesimal(skattepliktig).padStart(12)}`,
          ``
        );
      }

      // Prosesser warning-tickers (utbytte uten innehav)
      for (const ticker of warningTickers) {
        const tickerUtbytter = utbytterPerTicker.get(ticker)!;
        const sumUtbytte = tickerUtbytter.reduce(
          (sum, u) =>
            sum + u.beloep_per_aksje * u.antall_aksjer_paa_utbytte_dato,
          0
        );
        totalUtbytte += sumUtbytte;
        totalSkattepliktig += sumUtbytte;

        linjer.push(
          `  ${ticker} — ingen innehav 31.12 — hele utbyttet skattepliktig`,
          `    Utbytte mottatt:           ${formaterKr(sumUtbytte).padStart(12)}`,
          `    Brukt skjerming:                        0`,
          `    Skattepliktig utbytte:     ${formaterKr(sumUtbytte).padStart(12)}`,
          ``
        );
      }

      const oppjustert = totalSkattepliktig * oppjusteringsfaktor;
      const implisertSkatt = oppjustert * 0.22;

      linjer.push(
        `Aggregert:`,
        `  Total skjerming:              ${formaterKr(totalSkjerming).padStart(12)}`,
        `  Total utbytte mottatt:        ${formaterKr(totalUtbytte).padStart(12)}`,
        `  Total skattepliktig utbytte:  ${formaterKr(totalSkattepliktig).padStart(12)}`,
        `  Oppjustert (×${oppjusteringsfaktor}):           ${formaterKr(oppjustert).padStart(12)}`,
        `  Implisert skatt (22 %):       ${formaterKr(implisertSkatt).padStart(12)}`
      );

      linjer.push(paragrafBlokk(PARAGRAFER_SKJERMING));

      return {
        content: [{ type: "text" as const, text: linjer.join("\n") }],
      };
    }
  );
}
