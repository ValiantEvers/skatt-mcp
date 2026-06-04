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

function parseDato(s: string): Date {
  const [år, mnd, dag] = s.split("-").map(Number);
  return new Date(Date.UTC(år, mnd - 1, dag));
}

function dagsDiff(fra: Date, til: Date): number {
  return Math.round((til.getTime() - fra.getTime()) / 86_400_000);
}

function trekkFraDager(dato: Date, dager: number): Date {
  return new Date(dato.getTime() - dager * 86_400_000);
}

function maxDato(a: Date, b: Date): Date {
  return a.getTime() > b.getTime() ? a : b;
}

function minDato(a: Date, b: Date): Date {
  return a.getTime() < b.getTime() ? a : b;
}

function formaterVarighet(dager: number): string {
  if (dager <= 0) return `0 dager`;
  const år = Math.floor(dager / 365);
  const gjenstående = dager % 365;
  const måneder = Math.floor(gjenstående / 30);
  const dagerStr = `(${dager.toLocaleString("nb-NO")} dager)`;
  if (år > 0 && måneder > 0) return `${år} år ${måneder} mnd  ${dagerStr}`;
  if (år > 0) return `${år} år  ${dagerStr}`;
  if (måneder > 0) return `${måneder} mnd  ${dagerStr}`;
  return `${dager} dager`;
}

const DATO_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const ET_ÅR = 365;
const TO_ÅR = 730;
const FEM_ÅR = 1825;
const ÅTTE_ÅR = 2920;

function paragrafBlokk(refs: ParagrafRef[]): string {
  return ["", "Relevante paragrafer:",
    ...refs.map(r => `  ${r.refID.padEnd(28)} (${r.tittel})`),
  ].join("\n");
}

function boligParagrafRefs(skattefri: boolean, gevinst: number): ParagrafRef[] {
  const refs: ParagrafRef[] = [
    { refID: "lov/1999-03-26-14/§9-3", tittel: "Skattefritak for visse realisasjonsgevinster" },
  ];
  if (!skattefri) {
    refs.push({ refID: "lov/1999-03-26-14/§5-1", tittel: "Hovedregel om inntekt" });
    if (gevinst < 0) {
      refs.push({ refID: "lov/1999-03-26-14/§9-4", tittel: "Fradragsrett for tap" });
    }
  }
  return refs;
}

export function registerBoligVerktøy(server: McpServer): void {
  server.registerTool(
    "calculate_boliggevinst",
    {
      title: "Beregn skatt på boliggevinst",
      description:
        "Beregner skattepliktig gevinst eller fradragsberettiget tap ved salg av bolig. " +
        "Håndterer primærbolig (skattefri ved ≥ 1 år eiertid og ≥ 1 år botid siste 2 år), " +
        "sekundærbolig (alltid skattepliktig), og fritidsbolig " +
        "(skattefri ved ≥ 5 år eiertid og ≥ 5 år brukstid siste 8 år). " +
        "Skattesats 22 % alminnelig inntekt — ingen oppjustering for bolig. " +
        "Asymmetri: skattefritt salg gir hverken gevinst-skatt eller tap-fradrag.",
      inputSchema: {
        boligtype: z
          .enum(["primærbolig", "sekundærbolig", "fritidsbolig"])
          .describe("Type bolig som selges"),
        kjoepspris: z
          .number()
          .nonnegative()
          .describe("Inngangsverdi inkl. dokumentavgift og kjøpsomkostninger"),
        salgspris: z
          .number()
          .nonnegative()
          .describe("Salgssum etter meglerprovisjon og salgsomkostninger"),
        paakostninger: z
          .number()
          .nonnegative()
          .default(0)
          .describe("Dokumenterte påkostninger som øker boligens verdi"),
        kjoepsdato: z
          .string()
          .regex(DATO_REGEX)
          .describe("Dato boligen ble kjøpt (YYYY-MM-DD)"),
        salgsdato: z
          .string()
          .regex(DATO_REGEX)
          .describe("Dato boligen ble solgt (YYYY-MM-DD)"),
        innflyttingsdato: z
          .string()
          .regex(DATO_REGEX)
          .optional()
          .describe(
            "Dato eier flyttet inn. Kun relevant for primærbolig og fritidsbolig. " +
            "Settes til kjøpsdato hvis utelatt."
          ),
        fraflyttingsdato: z
          .string()
          .regex(DATO_REGEX)
          .optional()
          .describe(
            "Dato eier flyttet ut. Kun relevant for primærbolig og fritidsbolig. " +
            "Settes til salgsdato hvis utelatt."
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
      boligtype,
      kjoepspris,
      salgspris,
      paakostninger,
      kjoepsdato,
      salgsdato,
      innflyttingsdato,
      fraflyttingsdato,
      rapporteringsaar,
    }) => {
      const s = hentSatser(rapporteringsaar);
      const alminneligSats = s.alminnelig_inntektsskatt.sats;

      const kjøp = parseDato(kjoepsdato);
      const salg = parseDato(salgsdato);

      const gevinst = salgspris - kjoepspris - paakostninger;
      const eiertid = dagsDiff(kjøp, salg);

      // Tidsanalyse for primær og fritid
      let eiertidOppfylt = false;
      let tidsbrukOppfylt = false;
      let brukstidTotal = 0;
      let botid_vindu = 0;       // primær: botid siste 2 år
      let brukstid_vindu = 0;    // fritid: brukstid siste 8 år
      let skattefri = false;

      if (boligtype === "sekundærbolig") {
        skattefri = false;
      } else {
        const effInnflytting = innflyttingsdato
          ? maxDato(parseDato(innflyttingsdato), kjøp)
          : kjøp;
        const effFraflytting = fraflyttingsdato
          ? minDato(parseDato(fraflyttingsdato), salg)
          : salg;
        brukstidTotal = Math.max(0, dagsDiff(effInnflytting, effFraflytting));

        if (boligtype === "primærbolig") {
          eiertidOppfylt = eiertid >= ET_ÅR;
          const vindusstart = trekkFraDager(salg, TO_ÅR);
          botid_vindu = Math.max(
            0,
            dagsDiff(
              maxDato(effInnflytting, vindusstart),
              minDato(effFraflytting, salg)
            )
          );
          tidsbrukOppfylt = botid_vindu >= ET_ÅR;
        } else {
          // fritidsbolig
          eiertidOppfylt = eiertid >= FEM_ÅR;
          const vindusstart = trekkFraDager(salg, ÅTTE_ÅR);
          brukstid_vindu = Math.max(
            0,
            dagsDiff(
              maxDato(effInnflytting, vindusstart),
              minDato(effFraflytting, salg)
            )
          );
          tidsbrukOppfylt = brukstid_vindu >= FEM_ÅR;
        }
        skattefri = eiertidOppfylt && tidsbrukOppfylt;
      }

      const totalSkatt = skattefri ? 0 : gevinst * alminneligSats;

      const linjer: string[] = [
        `Boliggevinst — rapporteringsår ${rapporteringsaar}`,
        `Boligtype: ${boligtype}`,
        ``,
        `Posisjon:`,
        `  Kjøpspris (${kjoepsdato}):            ${formaterKr(kjoepspris).padStart(12)}`,
        ...( paakostninger > 0
          ? [`  Påkostninger:                     ${formaterKr(paakostninger).padStart(12)}`]
          : []
        ),
        `  Salgspris (${salgsdato}):            ${formaterKr(salgspris).padStart(12)}`,
        gevinst >= 0
          ? `  Gevinst:                          ${formaterKr(gevinst).padStart(12)}`
          : `  Tap:                              ${formaterKr(-gevinst).padStart(12)}`,
        ``,
        `Tidsanalyse:`,
        `  Eiertid:                          ${formaterVarighet(eiertid).padStart(12)}`,
      ];

      if (boligtype === "primærbolig") {
        linjer.push(
          `  Brukstid totalt:                  ${formaterVarighet(brukstidTotal).padStart(12)}`,
          `  Botid siste 2 år:                 ${formaterVarighet(botid_vindu).padStart(12)}`
        );
      } else if (boligtype === "fritidsbolig") {
        linjer.push(
          `  Brukstid totalt:                  ${formaterVarighet(brukstidTotal).padStart(12)}`,
          `  Brukstid siste 8 år:              ${formaterVarighet(brukstid_vindu).padStart(12)}`
        );
      }

      linjer.push(``, `Skattefri-test:`);

      if (boligtype === "sekundærbolig") {
        linjer.push(
          `  Sekundærbolig — alltid skattepliktig`,
          `  → Skattepliktig salg`
        );
      } else if (boligtype === "primærbolig") {
        linjer.push(
          `  ${eiertidOppfylt ? "✓" : "✗"} Eiertid ≥ 1 år:                    ${formaterVarighet(eiertid)}`,
          `  ${tidsbrukOppfylt ? "✓" : "✗"} Botid siste 2 år ≥ 1 år:          ${formaterVarighet(botid_vindu)}`,
          `  → ${skattefri ? "Skattefritt salg" : "Skattepliktig salg (vilkår ikke oppfylt)"}`
        );
      } else {
        linjer.push(
          `  ${eiertidOppfylt ? "✓" : "✗"} Eiertid ≥ 5 år:                    ${formaterVarighet(eiertid)}`,
          `  ${tidsbrukOppfylt ? "✓" : "✗"} Brukstid siste 8 år ≥ 5 år:       ${formaterVarighet(brukstid_vindu)}`,
          `  → ${skattefri ? "Skattefritt salg" : "Skattepliktig salg (vilkår ikke oppfylt)"}`
        );
      }

      linjer.push(``, `Skatteberegning:`);

      if (skattefri) {
        if (gevinst >= 0) {
          linjer.push(
            `  Gevinst:                          ${formaterKr(gevinst).padStart(12)}`,
            `  Skatt:                            ${formaterKr(0).padStart(12)}  (skattefritt salg — ikke skattepliktig)`,
          );
        } else {
          linjer.push(
            `  Tap:                              ${formaterKr(-gevinst).padStart(12)}`,
            `  Skattefradrag:                    ${formaterKr(0).padStart(12)}  (skattefritt salg — tap er ikke fradragsberettiget)`
          );
        }
      } else {
        if (gevinst >= 0) {
          linjer.push(
            `  Gevinst:                          ${formaterKr(gevinst).padStart(12)}`,
            `  Skatt (22 % alminnelig inntekt):  ${formaterKr(totalSkatt).padStart(12)}  (ingen oppjustering for bolig)`
          );
        } else {
          linjer.push(
            `  Tap:                              ${formaterKr(-gevinst).padStart(12)}`,
            `  Skattefradrag (22 %):             ${formaterKr(totalSkatt).padStart(12)}`
          );
        }
      }

      linjer.push(paragrafBlokk(boligParagrafRefs(skattefri, gevinst)));

      return {
        content: [{ type: "text" as const, text: linjer.join("\n") }],
      };
    }
  );
}
