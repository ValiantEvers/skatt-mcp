import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import satser2025 from "../data/satser/2025.json" with { type: "json" };
import type { ParagrafRef } from "./lovdata.js";

type Satser = typeof satser2025;
type Rabatter = Satser["verdsettingsrabatter"];
type FormuespostType =
  | "primærbolig"
  | "sekundærbolig"
  | "fritidsbolig"
  | "aksjer_aksjefond"
  | "ASK_aksjesparekonto"
  | "driftsmidler"
  | "bankinnskudd"
  | "krypto";

function hentSatser(år: number): Satser {
  if (år === 2025) return satser2025;
  throw new Error(`Satser for ${år} er ikke implementert ennå`);
}

function formaterKr(n: number): string {
  return Math.round(n).toLocaleString("nb-NO");
}

// Brukes for skattekomponenter der halv-krone er vanlig (f.eks. formuesskatt)
function formaterKrDesimal(n: number): string {
  // Vis maks 2 desimaler, men bare om nødvendig (18 322,50 → ikke 18 322,5000)
  const rounded = Math.round(n * 100) / 100;
  const hasDecimals = rounded % 1 !== 0;
  return rounded.toLocaleString("nb-NO", {
    minimumFractionDigits: hasDecimals ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

function beregnSkattemessigVerdi(
  type: FormuespostType,
  markedsverdi: number,
  r: Rabatter
): number {
  switch (type) {
    case "primærbolig": {
      const del1 =
        Math.min(markedsverdi, 10_000_000) * r.primærbolig.verdsetting_opp_til_10M;
      const del2 =
        Math.max(0, markedsverdi - 10_000_000) * r.primærbolig.verdsetting_over_10M;
      return del1 + del2;
    }
    case "sekundærbolig":
      return markedsverdi * r.sekundærbolig.verdsetting;
    case "fritidsbolig":
      return markedsverdi * r.fritidsbolig.verdsetting;
    case "aksjer_aksjefond":
      return markedsverdi * r.aksjer_aksjefond.verdsetting;
    case "ASK_aksjesparekonto":
      return markedsverdi * r.ASK_aksjesparekonto.verdsetting;
    case "driftsmidler":
      return markedsverdi * r.driftsmidler.verdsetting;
    case "bankinnskudd":
      return markedsverdi * r.bankinnskudd.verdsetting;
    case "krypto":
      return markedsverdi * r.krypto.verdsetting;
  }
}

function hentGjeldsreduksjon(type: FormuespostType, r: Rabatter): number {
  switch (type) {
    case "aksjer_aksjefond":
      return r.aksjer_aksjefond.gjeldsreduksjon;
    case "ASK_aksjesparekonto":
      return r.ASK_aksjesparekonto.gjeldsreduksjon;
    case "driftsmidler":
      return r.driftsmidler.gjeldsreduksjon;
    default:
      return 0;
  }
}

function paragrafBlokk(refs: ParagrafRef[]): string {
  return ["", "Relevante paragrafer:",
    ...refs.map(r => `  ${r.refID.padEnd(28)} (${r.tittel})`),
  ].join("\n");
}

const PARAGRAFER_FORMUE: ParagrafRef[] = [
  { refID: "lov/1999-03-26-14/§4-1",  tittel: "Hovedregel om formue" },
  { refID: "lov/1999-03-26-14/§4-10", tittel: "Fast eiendom, herunder andel i boligselskap" },
  { refID: "lov/1999-03-26-14/§4-12", tittel: "Aksje, egenkapitalbevis og andel i verdipapirfond" },
  { refID: "lov/1999-03-26-14/§4-19", tittel: "Gjeldsreduksjon for eiendel med verdsettelsesrabatt" },
];

export function registerFormuesskattVerktøy(server: McpServer): void {
  server.registerTool(
    "calculate_formuesskatt",
    {
      title: "Beregn formuesskatt",
      description:
        "Beregner formuesskatt med korrekt skattemessig verdsetting per " +
        "formuesposttype og proporsjonal gjeldsfordeling. " +
        "Viser per-post-breakdown og alle mellomregninger.",
      inputSchema: {
        formuesposter: z
          .array(
            z.object({
              type: z.enum([
                "primærbolig",
                "sekundærbolig",
                "fritidsbolig",
                "aksjer_aksjefond",
                "ASK_aksjesparekonto",
                "driftsmidler",
                "bankinnskudd",
                "krypto",
              ]),
              markedsverdi: z.number().nonnegative(),
              beskrivelse: z.string().optional(),
            })
          )
          .describe("Liste over alle formuesposter med markedsverdi"),
        total_gjeld: z
          .number()
          .nonnegative()
          .default(0)
          .describe("Sum av all gjeld"),
        ektefeller: z
          .boolean()
          .default(false)
          .describe("Hvis true, dobles bunnfradraget"),
        aar: z.number().int().min(2025).max(2025).default(2025),
      },
    },
    async ({ formuesposter, total_gjeld, ektefeller, aar }) => {
      const s = hentSatser(aar);
      const r = s.verdsettingsrabatter;

      // 1. Skattemessig verdi og gjeldsreduksjonssats per post
      const poster = formuesposter.map((p) => {
        const type = p.type as FormuespostType;
        return {
          ...p,
          type,
          skattemessigVerdi: beregnSkattemessigVerdi(type, p.markedsverdi, r),
          gjeldsreduksjonSats: hentGjeldsreduksjon(type, r),
        };
      });

      // 2. Totaler
      const totalBrutto = poster.reduce((sum, p) => sum + p.markedsverdi, 0);
      const totalSkattemessig = poster.reduce(
        (sum, p) => sum + p.skattemessigVerdi,
        0
      );

      // 3. Proporsjonal gjeldsfordeling
      const posterMedGjeld = poster.map((p) => {
        const tilordnetGjeld =
          totalBrutto > 0 ? total_gjeld * (p.markedsverdi / totalBrutto) : 0;
        const fradragsberettigetGjeld =
          tilordnetGjeld * (1 - p.gjeldsreduksjonSats);
        return { ...p, tilordnetGjeld, fradragsberettigetGjeld };
      });

      const sumFradragsberettigetGjeld = posterMedGjeld.reduce(
        (sum, p) => sum + p.fradragsberettigetGjeld,
        0
      );

      // 4. Nettoformue (gulv på 0)
      const nettoformue = Math.max(0, totalSkattemessig - sumFradragsberettigetGjeld);

      // 5. Bunnfradrag
      const bunnfradrag = ektefeller
        ? s.formuesskatt.bunnfradrag_ektefeller
        : s.formuesskatt.bunnfradrag_enslig;

      // 6. Formuesskatt
      let kommunal = 0;
      let statligTrinn1 = 0;
      let statligTrinn2 = 0;

      if (nettoformue > bunnfradrag) {
        kommunal = (nettoformue - bunnfradrag) * s.formuesskatt.kommunal_sats;
        const st1Grunnlag =
          Math.min(nettoformue, s.formuesskatt.statlig_trinn2_innslag) - bunnfradrag;
        statligTrinn1 =
          Math.max(0, st1Grunnlag) * s.formuesskatt.statlig_trinn1_sats;
        statligTrinn2 =
          Math.max(0, nettoformue - s.formuesskatt.statlig_trinn2_innslag) *
          s.formuesskatt.statlig_trinn2_sats;
      }

      const totalFormuesskatt = kommunal + statligTrinn1 + statligTrinn2;

      // Bygg output
      const linjer: string[] = [
        `Formuesskatt ${aar} — ${ektefeller ? "ektefeller" : "enslig"}`,
        ``,
        `Formuesposter:`,
      ];

      for (const p of posterMedGjeld) {
        const navn = p.beskrivelse ? `${p.type} (${p.beskrivelse})` : p.type;
        let linje = `  ${navn}: mkt ${formaterKr(p.markedsverdi)} → skm ${formaterKr(p.skattemessigVerdi)}`;
        if (total_gjeld > 0) {
          if (p.gjeldsreduksjonSats > 0) {
            linje += `, gjeld ${formaterKr(p.tilordnetGjeld)} → etter ${p.gjeldsreduksjonSats * 100} % red. = ${formaterKr(p.fradragsberettigetGjeld)}`;
          } else {
            linje += `, gjeld ${formaterKr(p.tilordnetGjeld)}`;
          }
        }
        linjer.push(linje);
      }

      linjer.push(
        ``,
        `Oppsummering:`,
        `  Total brutto markedsverdi:     ${formaterKr(totalBrutto).padStart(12)}`
      );

      if (total_gjeld > 0) {
        linjer.push(
          `  Total gjeld:                   ${formaterKr(total_gjeld).padStart(12)}`,
          `  Sum fradragsberettiget gjeld:  ${formaterKr(sumFradragsberettigetGjeld).padStart(12)}`
        );
      }

      linjer.push(
        `  Total skattemessig formue:     ${formaterKr(totalSkattemessig).padStart(12)}`,
        `  Nettoformue:                   ${formaterKr(nettoformue).padStart(12)}`,
        `  − Bunnfradrag:                 ${formaterKr(bunnfradrag).padStart(12)}`,
        `  Skattegrunnlag:                ${formaterKr(Math.max(0, nettoformue - bunnfradrag)).padStart(12)}`,
        ``,
        `Formuesskatt:`,
        `  Kommunal (0,525 %):            ${formaterKrDesimal(kommunal).padStart(12)}`,
        `  Statlig trinn 1 (0,475 %):     ${formaterKrDesimal(statligTrinn1).padStart(12)}`
      );

      if (statligTrinn2 > 0) {
        linjer.push(
          `  Statlig trinn 2 (0,575 %):     ${formaterKrDesimal(statligTrinn2).padStart(12)}`
        );
      }

      linjer.push(
        `  ──────────────────────────────────────`,
        `  Total formuesskatt:            ${formaterKr(totalFormuesskatt).padStart(12)}`
      );

      linjer.push(paragrafBlokk(PARAGRAFER_FORMUE));

      return {
        content: [{ type: "text", text: linjer.join("\n") }],
      };
    }
  );
}
