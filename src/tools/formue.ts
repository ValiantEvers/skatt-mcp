import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ParagrafRef } from "./lovdata.js";
import {
  hentSatser,
  formaterKr,
  formaterKrDesimal,
  paragrafBlokk,
  type Satser,
} from "./felles.js";

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

function beregnSkattemessigVerdi(
  type: FormuespostType,
  markedsverdi: number,
  r: Rabatter
): number {
  switch (type) {
    case "primærbolig": {
      // Terskelen er ÅRSAVHENGIG og leses derfor fra satsfila. Den var hardkodet til
      // 10 000 000 her fram til 2026-08-16, og 2026-satsfila påsto samtidig «uendret
      // 2025→2026» — begge deler feil: terskelen ble hevet til 14 M f.o.m. 2026.
      // En hardkodet grense i en satsdrevet kalkulator er nettopp feilklassen
      // satsfilene finnes for å utelukke.
      const terskel = r.primærbolig.terskel;
      const del1 =
        Math.min(markedsverdi, terskel) * r.primærbolig.verdsetting_under_terskel;
      const del2 =
        Math.max(0, markedsverdi - terskel) * r.primærbolig.verdsetting_over_terskel;
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

// Satsen som prosentstreng, hentet fra satsfila i stedet for hardkodet i etiketten.
// 2025 gir «0,525»/«0,475»/«0,575» — byte-identisk med de tidligere hardkodede tekstene —
// og et nytt satsår kan ikke lenger gi en etikett som lyver om tallet ved siden av.
function formaterSats(sats: number): string {
  return (sats * 100)
    .toFixed(3)
    .replace(/0+$/, "")
    .replace(/\.$/, "")
    .replace(".", ",");
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
          .describe(
            "Hvis true, lignes ektefellene under ett for felles formue (sktl. § 2-10) — " +
            "da dobles BÅDE bunnfradraget og innslagspunktet for statlig trinn 2"
          ),
        aar: z
          .number()
          .int()
          .min(2025)
          .max(2026)
          .default(2025)
          .describe("Inntektsår (2025–2026 støttet)"),
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

      // 5. Bunnfradrag og trinn 2-innslag
      // Ektefeller som lignes under ett for felles formue (sktl. § 2-10) har DOBLE beløps-
      // grenser — ikke bare bunnfradraget, men også innslagspunktet for statlig trinn 2.
      // Stortingets skattevedtak for 2025 § 2-1: enslig 1 760 000 / 0,475 % opp til
      // 20 700 000 / 0,575 % over; ektefeller 3 520 000 / 0,475 % opp til 41 400 000 /
      // 0,575 % over. Samme port som skatt-optimizer formue.py (83873ba, 2026-07-12) —
      // ikke synk tilbake til den gamle oppførselen.
      const bunnfradrag = ektefeller
        ? s.formuesskatt.bunnfradrag_ektefeller
        : s.formuesskatt.bunnfradrag_enslig;
      const trinn2Innslag =
        s.formuesskatt.statlig_trinn2_innslag * (ektefeller ? 2 : 1);

      // 6. Formuesskatt
      let kommunal = 0;
      let statligTrinn1 = 0;
      let statligTrinn2 = 0;

      if (nettoformue > bunnfradrag) {
        kommunal = (nettoformue - bunnfradrag) * s.formuesskatt.kommunal_sats;
        const st1Grunnlag = Math.min(nettoformue, trinn2Innslag) - bunnfradrag;
        statligTrinn1 =
          Math.max(0, st1Grunnlag) * s.formuesskatt.statlig_trinn1_sats;
        statligTrinn2 =
          Math.max(0, nettoformue - trinn2Innslag) *
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
        `  Innslag statlig trinn 2:       ${formaterKr(trinn2Innslag).padStart(12)}${ektefeller ? "  (dobbelt — ektefeller lignes under ett)" : ""}`,
        ``,
        `Formuesskatt:`,
        `  Kommunal (${formaterSats(s.formuesskatt.kommunal_sats)} %):            ${formaterKrDesimal(kommunal).padStart(12)}`,
        `  Statlig trinn 1 (${formaterSats(s.formuesskatt.statlig_trinn1_sats)} %):     ${formaterKrDesimal(statligTrinn1).padStart(12)}`
      );

      if (statligTrinn2 > 0) {
        linjer.push(
          `  Statlig trinn 2 (${formaterSats(s.formuesskatt.statlig_trinn2_sats)} %):     ${formaterKrDesimal(statligTrinn2).padStart(12)}`
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
