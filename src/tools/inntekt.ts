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

function formaterProsent(sats: number): string {
  return (sats * 100).toFixed(1).replace(".", ",") + " %";
}

function paragrafBlokk(refs: ParagrafRef[]): string {
  return ["", "Relevante paragrafer:",
    ...refs.map(r => `  ${r.refID.padEnd(28)} (${r.tittel})`),
  ].join("\n");
}

const PARAGRAFER_INNTEKT: ParagrafRef[] = [
  { refID: "lov/1999-03-26-14/§5-1",  tittel: "Hovedregel om inntekt" },
  { refID: "lov/1999-03-26-14/§5-10", tittel: "Fordel vunnet ved arbeid" },
  { refID: "lov/1999-03-26-14/§6-32", tittel: "Beregning av minstefradrag" },
  { refID: "lov/1999-03-26-14/§15-4", tittel: "Personfradrag i alminnelig inntekt" },
];

const PARAGRAF_BSU: ParagrafRef = {
  refID: "lov/1999-03-26-14/§16-10",
  tittel: "Skattefradrag ved boligsparing for ungdom (BSU)",
};

export function registerInntektsskattVerktøy(server: McpServer): void {
  server.registerTool(
    "lookup_satser",
    {
      title: "Slå opp skattesatser",
      description:
        "Returnerer alle skattesatser og grenser for et gitt inntektsår. " +
        "Nyttig for å inspisere hvilke satser som brukes i beregningene.",
      inputSchema: {
        aar: z
          .number()
          .int()
          .min(2025)
          .max(2025)
          .describe("Inntektsår (kun 2025 støttet ennå)"),
      },
    },
    async ({ aar }) => {
      const satser = hentSatser(aar);
      return {
        content: [{ type: "text", text: JSON.stringify(satser, null, 2) }],
      };
    }
  );

  server.registerTool(
    "calculate_inntektsskatt",
    {
      title: "Beregn inntektsskatt",
      description:
        "Beregner alminnelig inntektsskatt, trinnskatt og trygdeavgift. " +
        "Støtter lønn, pensjon og næringsinntekt. " +
        "Inkluderer valgfrie fradrag: gjeldsrenter, reisefradrag, foreldrefradrag, " +
        "fagforeningskontingent og BSU. Viser alle mellomregninger.",
      inputSchema: {
        bruttoinntekt: z
          .number()
          .positive()
          .describe("Brutto årsinntekt i NOK"),
        inntektstype: z.enum(["lønn", "pensjon", "næring"]).default("lønn"),
        aar: z.number().int().min(2025).max(2025).default(2025),
        gjeldsrenter: z
          .number()
          .nonnegative()
          .default(0)
          .describe("Sum betalte gjeldsrenter"),
        reisefradrag_km: z
          .number()
          .nonnegative()
          .optional()
          .describe("Avstand til jobb én vei i km"),
        reisefradrag_dager: z
          .number()
          .int()
          .nonnegative()
          .default(230)
          .describe("Antall arbeidsdager (default 230)"),
        foreldrefradrag_antall_barn: z
          .number()
          .int()
          .nonnegative()
          .default(0)
          .describe("Antall barn under 12 år"),
        foreldrefradrag_dokumenterte_kostnader: z
          .number()
          .nonnegative()
          .default(0)
          .describe("Dokumenterte pass- og omsorgsutgifter"),
        fagforeningskontingent: z.number().nonnegative().default(0),
        andre_fradrag: z
          .number()
          .nonnegative()
          .default(0)
          .describe("Catch-all for øvrige fradrag i alminnelig inntekt"),
        bsu_innskudd: z
          .number()
          .nonnegative()
          .default(0)
          .describe("Innskudd på BSU dette året (maks 27 500)"),
      },
    },
    async ({
      bruttoinntekt,
      inntektstype,
      aar,
      gjeldsrenter,
      reisefradrag_km,
      reisefradrag_dager,
      foreldrefradrag_antall_barn,
      foreldrefradrag_dokumenterte_kostnader,
      fagforeningskontingent,
      andre_fradrag,
      bsu_innskudd,
    }) => {
      const s = hentSatser(aar);

      // 1. Minstefradrag (næring har ikke minstefradrag)
      let minstefradrag = 0;
      let minstefradragInfo = "";
      if (inntektstype === "lønn") {
        const beregnet = bruttoinntekt * s.minstefradrag.lønn.sats;
        minstefradrag = Math.min(beregnet, s.minstefradrag.lønn.maks);
        minstefradragInfo =
          beregnet >= s.minstefradrag.lønn.maks
            ? " (kappet på maks)"
            : ` (${formaterProsent(s.minstefradrag.lønn.sats)} av brutto)`;
      } else if (inntektstype === "pensjon") {
        const beregnet = bruttoinntekt * s.minstefradrag.pensjon.sats;
        minstefradrag = Math.min(beregnet, s.minstefradrag.pensjon.maks);
        minstefradragInfo =
          beregnet >= s.minstefradrag.pensjon.maks
            ? " (kappet på maks)"
            : ` (${formaterProsent(s.minstefradrag.pensjon.sats)} av brutto)`;
      }

      // 2. Reisefradrag (km er én vei, ganger 2 for tur/retur)
      let reisefradrag = 0;
      let reiseBrutto = 0;
      if (reisefradrag_km !== undefined && reisefradrag_km > 0) {
        reiseBrutto =
          reisefradrag_km * reisefradrag_dager * 2 * s.reisefradrag.sats_per_km;
        reisefradrag = Math.max(0, reiseBrutto - s.reisefradrag.egenandel);
      }

      // 3. Foreldrefradrag
      let foreldrefradrag = 0;
      if (foreldrefradrag_antall_barn >= 1) {
        const maksForeldrefradrag =
          s.foreldrefradrag.første_barn +
          (foreldrefradrag_antall_barn - 1) * s.foreldrefradrag.hvert_ekstra_barn;
        foreldrefradrag = Math.min(
          foreldrefradrag_dokumenterte_kostnader,
          maksForeldrefradrag
        );
      }

      // 4. Fagforening (kappet på maks)
      const fagforeningCapped = Math.min(
        fagforeningskontingent,
        s.fagforeningskontingent.maks
      );

      // Sum alle fradrag utenom minstefradrag
      const sumAndreFradrag =
        gjeldsrenter +
        reisefradrag +
        foreldrefradrag +
        fagforeningCapped +
        andre_fradrag;

      // 5. Alminnelig inntekt
      const alminneligInntekt =
        bruttoinntekt - minstefradrag - sumAndreFradrag;

      // 6. Skattegrunnlag alminnelig inntekt
      const skattegrunnlag = Math.max(
        0,
        alminneligInntekt - s.personfradrag.klasse_1
      );

      // 7. Skatt på alminnelig inntekt
      const skattAlminnelig =
        skattegrunnlag * s.alminnelig_inntektsskatt.sats;

      // 8. Trinnskatt (beregnes på bruttoinntekt/personinntekt)
      const trinn = s.trinnskatt;
      let trinnskattTotal = 0;
      const trinnDetaljer: Array<{
        nr: number;
        beløp: number;
        sats: number;
        bidrag: number;
      }> = [];
      for (let i = 0; i < trinn.length; i++) {
        const innslag = trinn[i].innslagspunkt;
        const øvre = trinn[i + 1]?.innslagspunkt ?? Infinity;
        if (bruttoinntekt > innslag) {
          const beløp = Math.min(bruttoinntekt, øvre) - innslag;
          const bidrag = beløp * trinn[i].sats;
          trinnskattTotal += bidrag;
          trinnDetaljer.push({ nr: i + 1, beløp, sats: trinn[i].sats, bidrag });
        }
      }

      // 9. Trygdeavgift (25 %-regel glatter overgang rett over nedre grense)
      const { nedre_grense, satser, tjuefem_prosent_regel } = s.trygdeavgift;
      const trygdSats =
        inntektstype === "lønn"
          ? satser.lønn
          : inntektstype === "pensjon"
          ? satser.pensjon
          : satser.næring;
      let trygdeavgift = 0;
      if (bruttoinntekt > nedre_grense) {
        const standard = bruttoinntekt * trygdSats;
        const tak = (bruttoinntekt - nedre_grense) * tjuefem_prosent_regel;
        trygdeavgift = Math.min(standard, tak);
      }

      // 10. BSU-fradrag (trekkes fra total skatt, ikke fra inntekt)
      const bsuCapped = Math.min(bsu_innskudd, s.BSU.maks_årlig_innskudd);
      const bsuFradrag = bsuCapped * s.BSU.skattefradrag_sats;

      // 11. Total skatt
      const totalFørBSU = skattAlminnelig + trinnskattTotal + trygdeavgift;
      const totalSkatt = Math.max(0, totalFørBSU - bsuFradrag);

      // 12. Nettoinntekt
      const nettoinntekt = bruttoinntekt - totalSkatt;
      const effektivSats = (totalSkatt / bruttoinntekt) * 100;

      // Bygg output
      const linjer: string[] = [
        `Inntektsskatt ${aar} — bruttoinntekt ${formaterKr(bruttoinntekt)} (${inntektstype})`,
        ``,
        `Mellomregninger:`,
        `  Minstefradrag:            ${formaterKr(minstefradrag).padStart(10)}${minstefradragInfo}`,
      ];

      if (gjeldsrenter > 0)
        linjer.push(
          `  Gjeldsrenter:             ${formaterKr(gjeldsrenter).padStart(10)}`
        );
      if (reisefradrag > 0)
        linjer.push(
          `  Reisefradrag:             ${formaterKr(reisefradrag).padStart(10)}  (brutto ${formaterKr(reiseBrutto)} − egenandel ${formaterKr(s.reisefradrag.egenandel)})`
        );
      if (foreldrefradrag > 0)
        linjer.push(
          `  Foreldrefradrag:          ${formaterKr(foreldrefradrag).padStart(10)}`
        );
      if (fagforeningCapped > 0)
        linjer.push(
          `  Fagforeningskontingent:   ${formaterKr(fagforeningCapped).padStart(10)}`
        );
      if (andre_fradrag > 0)
        linjer.push(
          `  Andre fradrag:            ${formaterKr(andre_fradrag).padStart(10)}`
        );

      linjer.push(
        `  Sum andre fradrag:        ${formaterKr(sumAndreFradrag).padStart(10)}`,
        `  Alminnelig inntekt:       ${formaterKr(alminneligInntekt).padStart(10)}`,
        `  − Personfradrag:          ${formaterKr(s.personfradrag.klasse_1).padStart(10)}`,
        `  Skattegrunnlag alm.:      ${formaterKr(skattegrunnlag).padStart(10)}`,
        ``,
        `Skatter:`,
        `  Skatt på alm. inntekt:    ${formaterKr(skattAlminnelig).padStart(10)}  (${formaterKr(skattegrunnlag)} × 22 %)`,
        `  Trinnskatt:               ${formaterKr(trinnskattTotal).padStart(10)}`
      );

      for (const t of trinnDetaljer) {
        linjer.push(
          `    Trinn ${t.nr}: ${formaterKr(t.beløp)} × ${formaterProsent(t.sats)} = ${formaterKr(t.bidrag)}`
        );
      }

      linjer.push(
        `  Trygdeavgift:             ${formaterKr(trygdeavgift).padStart(10)}  (${inntektstype} ${formaterProsent(trygdSats)})`,
        `  BSU-fradrag:              ${bsuFradrag > 0 ? `${formaterKr(bsuFradrag).padStart(10)}  (${formaterKr(bsuCapped)} × 10 %)` : formaterKr(0).padStart(10)}`,
        `  ──────────────────────────────────────`,
        `  Total skatt:              ${formaterKr(totalSkatt).padStart(10)}`,
        `  Nettoinntekt:             ${formaterKr(nettoinntekt).padStart(10)}`,
        ``,
        `Effektiv sats: ${effektivSats.toFixed(2).replace(".", ",")} %`
      );

      const paragrafRefs: ParagrafRef[] = [...PARAGRAFER_INNTEKT];
      if (bsu_innskudd > 0) paragrafRefs.push(PARAGRAF_BSU);
      linjer.push(paragrafBlokk(paragrafRefs));

      return {
        content: [{ type: "text", text: linjer.join("\n") }],
      };
    }
  );
}
