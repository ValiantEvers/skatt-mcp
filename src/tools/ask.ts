import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import satser2025 from "../data/satser/2025.json" with { type: "json" };
import type { ParagrafRef } from "./lovdata.js";

type Satser = typeof satser2025;

function hentSatser(år: number): Satser {
  if (år === 2025) return satser2025;
  throw new Error(`Satser for ${år} er ikke implementert ennå`);
}

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

function paragrafBlokk(refs: ParagrafRef[]): string {
  return ["", "Relevante paragrafer:",
    ...refs.map(r => `  ${r.refID.padEnd(28)} (${r.tittel})`),
  ].join("\n");
}

const PARAGRAFER_ASK: ParagrafRef[] = [
  { refID: "lov/1999-03-26-14/§10-21", tittel: "Skattlegging av aksjesparekonto og kontohaver" },
  { refID: "lov/1999-03-26-14/§10-12", tittel: "Fradrag for skjerming" },
];

export function registerAskVerktøy(server: McpServer): void {
  server.registerTool(
    "calculate_ask",
    {
      title: "Beregn ASK (aksjesparekonto)",
      description:
        "Beregner skattekonsekvenser for en aksjesparekonto (ASK) for ett rapporteringsår. " +
        "Håndterer tre scenarier: ingen aktivitet (skjerming akkumuleres, skatt utsatt), " +
        "uttak i året (skatt på gevinst over skjerming), og avslutning av kontoen. " +
        "Viser skjermingsberegning, skatteoppgjør og ny state for neste år.",
      inputSchema: {
        innskudd_start_aar: z
          .number()
          .nonnegative()
          .describe(
            "Total innskuddssaldo ved 1.1 i rapporteringsåret (det som kan tas ut skattefritt ved start av året)"
          ),
        innskudd_i_aaret: z
          .number()
          .nonnegative()
          .default(0)
          .describe("Sum nye innskudd lagt til ASK i løpet av året"),
        uttak_i_aaret: z
          .number()
          .nonnegative()
          .default(0)
          .describe(
            "Sum uttak fra ASK i året. Utbytte som blir stående på kontoen regnes ikke som uttak."
          ),
        laveste_innskuddssaldo: z
          .number()
          .nonnegative()
          .optional()
          .describe(
            "Laveste innskuddssaldo i året (fra bankens årsoppgave). " +
            "Approksimeres som max(0, innskudd_start_aar − uttak_i_aaret) hvis utelatt."
          ),
        akkumulert_ubrukt_skjerming: z
          .number()
          .nonnegative()
          .default(0)
          .describe("Akkumulert ubrukt skjerming overført fra tidligere år"),
        markedsverdi_31_12: z
          .number()
          .nonnegative()
          .describe("Markedsverdi av aksjer/fond på ASK per 31.12"),
        avslutter_kontoen: z
          .boolean()
          .default(false)
          .describe(
            "Hvis true: kontoen tømmes — all urealisert gevinst eller tap realiseres i rapporteringsåret"
          ),
        rapporteringsaar: z
          .number()
          .int()
          .min(2025)
          .max(2025)
          .default(2025),
      },
    },
    async ({
      innskudd_start_aar,
      innskudd_i_aaret,
      uttak_i_aaret,
      laveste_innskuddssaldo,
      akkumulert_ubrukt_skjerming,
      markedsverdi_31_12,
      avslutter_kontoen,
      rapporteringsaar,
    }) => {
      const s = hentSatser(rapporteringsaar);
      const skjermingsrente = s.skjermingsrente.personlige_aksjonærer;
      const oppjusteringsfaktor = s.aksjeoppjustering.faktor;
      const renteProsent = (skjermingsrente * 100).toFixed(1).replace(".", ",");

      // Tom konto — special case
      if (
        innskudd_start_aar === 0 &&
        innskudd_i_aaret === 0 &&
        uttak_i_aaret === 0 &&
        markedsverdi_31_12 === 0
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `ASK — rapporteringsår ${rapporteringsaar}`,
                `Skjermingsrente: ${renteProsent} %`,
                ``,
                `Tom ASK — ingen skattekonsekvens.`,
                ``,
                `Ny state etter året:`,
                `  Innskuddssaldo 31.12:                       0`,
                `  Ny akkumulert ubrukt:                       0`,
              ].join("\n"),
            },
          ],
        };
      }

      // Steg 1: Laveste innskuddssaldo
      const erApproksimasjon = laveste_innskuddssaldo === undefined;
      const laveste = erApproksimasjon
        ? Math.max(0, innskudd_start_aar - uttak_i_aaret)
        : laveste_innskuddssaldo;

      // Steg 2: Skjermingsberegning
      const skjermingsgrunnlag = laveste + akkumulert_ubrukt_skjerming;
      const åresSkjerming = skjermingsgrunnlag * skjermingsrente;
      const totalDisponibel = akkumulert_ubrukt_skjerming + åresSkjerming;

      // Steg 3: Skatteberegning
      let innskuddsuttak = 0;
      let gevinstuttak = 0;
      let gevinstFørSkjerming = 0;
      let tapBeløp = 0;
      let bruktSkjerming = 0;
      let bortfaltSkjerming = 0;
      let skattepliktig = 0;
      let nyInnskudd = 0;
      let nyAkkumulert = 0;
      let scenario: string;

      if (avslutter_kontoen) {
        const totalInnskudd =
          innskudd_start_aar + innskudd_i_aaret - uttak_i_aaret;
        if (markedsverdi_31_12 >= totalInnskudd) {
          gevinstFørSkjerming = markedsverdi_31_12 - totalInnskudd;
          bruktSkjerming = Math.min(gevinstFørSkjerming, totalDisponibel);
          skattepliktig = gevinstFørSkjerming - bruktSkjerming;
          bortfaltSkjerming = totalDisponibel - bruktSkjerming;
          scenario = "avslutning med gevinst";
        } else {
          tapBeløp = totalInnskudd - markedsverdi_31_12;
          skattepliktig = -tapBeløp;
          bruktSkjerming = 0;
          bortfaltSkjerming = totalDisponibel;
          scenario = "avslutning med tap";
        }
        nyInnskudd = 0;
        nyAkkumulert = 0;
      } else if (uttak_i_aaret > 0) {
        const totalInnskudd = innskudd_start_aar + innskudd_i_aaret;
        innskuddsuttak = Math.min(uttak_i_aaret, totalInnskudd);
        gevinstuttak = uttak_i_aaret - innskuddsuttak;
        bruktSkjerming = Math.min(gevinstuttak, totalDisponibel);
        skattepliktig = gevinstuttak - bruktSkjerming;
        nyInnskudd = totalInnskudd - innskuddsuttak;
        nyAkkumulert = totalDisponibel - bruktSkjerming;
        scenario = "uttak";
      } else {
        skattepliktig = 0;
        bruktSkjerming = 0;
        nyInnskudd = innskudd_start_aar + innskudd_i_aaret;
        nyAkkumulert = akkumulert_ubrukt_skjerming + åresSkjerming;
        scenario = "ingen aktivitet";
      }

      // Steg 4: Skattekonsekvens
      const oppjustert = skattepliktig * oppjusteringsfaktor;
      const implisertSkatt = oppjustert * 0.22;

      // Bygg output
      const linjer: string[] = [
        `ASK — rapporteringsår ${rapporteringsaar}`,
        `Skjermingsrente: ${renteProsent} %`,
        `Scenario: ${scenario}`,
        ``,
        `State ved start:`,
        `  Innskuddssaldo 1.1:               ${formaterKr(innskudd_start_aar).padStart(12)}`,
        `  Akkumulert ubrukt skjerming:      ${formaterKr(akkumulert_ubrukt_skjerming).padStart(12)}`,
        `  Markedsverdi 31.12:               ${formaterKr(markedsverdi_31_12).padStart(12)}`,
        ``,
        `Skjermingsberegning:`,
        `  Laveste innskuddssaldo:           ${formaterKr(laveste).padStart(12)}${erApproksimasjon ? "  (approksimert)" : ""}`,
        `  Skjermingsgrunnlag:               ${formaterKr(skjermingsgrunnlag).padStart(12)}  (laveste + akkumulert ${formaterKr(akkumulert_ubrukt_skjerming)})`,
        `  Årets skjerming:                  ${formaterKrDesimal(åresSkjerming).padStart(12)}  (${formaterKr(skjermingsgrunnlag)} × ${renteProsent} %)`,
        `  Total disponibel skjerming:       ${formaterKrDesimal(totalDisponibel).padStart(12)}`,
        ...(erApproksimasjon
          ? [`⚠ Approksimasjon brukt. Oppgi laveste_innskuddssaldo fra årsoppgaven for nøyaktig beregning.`]
          : []),
        ``,
        `Skatteberegning:`,
      ];

      if (avslutter_kontoen) {
        const totalInnskudd =
          innskudd_start_aar + innskudd_i_aaret - uttak_i_aaret;
        linjer.push(
          `  Innskudd ved avslutning:          ${formaterKr(totalInnskudd).padStart(12)}`
        );
        if (tapBeløp > 0) {
          linjer.push(
            `  Realisert tap:                    ${formaterKr(tapBeløp).padStart(12)}`,
            `  Brukt skjerming:                  ${formaterKr(bruktSkjerming).padStart(12)}`,
            `  Bortfalt skjerming (faller bort):  ${formaterKrDesimal(bortfaltSkjerming).padStart(12)}`,
            `  Endelig skattepliktig:            ${formaterKr(skattepliktig).padStart(12)}  (tap — gir skattefradrag)`
          );
        } else {
          linjer.push(
            `  Gevinst før skjerming:            ${formaterKr(gevinstFørSkjerming).padStart(12)}`,
            `  Brukt skjerming:                  ${formaterKrDesimal(bruktSkjerming).padStart(12)}`,
            `  Endelig skattepliktig:            ${formaterKr(skattepliktig).padStart(12)}`
          );
          if (bortfaltSkjerming > 0) {
            linjer.push(
              `  Bortfalt skjerming (faller bort):  ${formaterKrDesimal(bortfaltSkjerming).padStart(12)}`
            );
          }
        }
      } else if (uttak_i_aaret > 0) {
        linjer.push(
          `  Totalt uttak:                     ${formaterKr(uttak_i_aaret).padStart(12)}`,
          `  Innskuddsuttak (skattefritt):     ${formaterKr(innskuddsuttak).padStart(12)}`,
          `  Gevinstuttak:                     ${formaterKr(gevinstuttak).padStart(12)}`,
          `  Brukt skjerming:                  ${formaterKrDesimal(bruktSkjerming).padStart(12)}`,
          `  Endelig skattepliktig:            ${formaterKr(skattepliktig).padStart(12)}`
        );
      } else {
        linjer.push(
          `  Ingen uttak dette år — skatten er utsatt.`,
          `  Endelig skattepliktig:            ${formaterKr(0).padStart(12)}`
        );
      }

      linjer.push(
        `  Oppjustert (×${oppjusteringsfaktor}):               ${formaterKrDesimal(oppjustert).padStart(12)}`
      );

      if (oppjustert < 0) {
        linjer.push(
          `  Implisert skattefradrag (22 %):   ${formaterKr(implisertSkatt).padStart(12)}`
        );
      } else {
        linjer.push(
          `  Implisert skatt (22 %):           ${formaterKr(implisertSkatt).padStart(12)}`
        );
      }

      linjer.push(``, `Ny state etter året:`);

      if (avslutter_kontoen) {
        linjer.push(`  Kontoen avsluttet — alle saldoer satt til 0.`);
        if (bortfaltSkjerming > 0) {
          linjer.push(
            `  Bortfalt skjerming:               ${formaterKrDesimal(bortfaltSkjerming).padStart(12)}`
          );
        }
      } else {
        linjer.push(
          `  Innskuddssaldo 31.12:             ${formaterKr(nyInnskudd).padStart(12)}`,
          `  Ny akkumulert ubrukt:             ${formaterKrDesimal(nyAkkumulert).padStart(12)}`
        );
      }

      linjer.push(paragrafBlokk(PARAGRAFER_ASK));

      return {
        content: [{ type: "text" as const, text: linjer.join("\n") }],
      };
    }
  );
}
