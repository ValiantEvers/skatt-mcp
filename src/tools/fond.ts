import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import satser2025 from "../data/satser/2025.json" with { type: "json" };
import fondKlassRaw from "../data/fond-klassifisering.json" with { type: "json" };
import type { ParagrafRef } from "./lovdata.js";
import {
  kjørFifo,
  IkkeNokBeholdningFeil,
  type FifoTransaksjon,
  type FifoSalgsResultat,
  type Lot,
} from "../lib/fifo.js";

// § 10-20 (2): aksjeandel ≥ 80 % → aksjefond
// § 10-20 (2): aksjeandel ≤ 20 % → rentefond
// (Mellom: kombinasjonsfond, proporsjonal splitt.)
const AKSJEFOND_GRENSE = 0.8;
const RENTEFOND_GRENSE = 0.2;

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
  return [
    "",
    "Relevante paragrafer:",
    ...refs.map((r) => `  ${r.refID.padEnd(28)} (${r.tittel})`),
  ].join("\n");
}

const PARAGRAFER_FOND: ParagrafRef[] = [
  {
    refID: "lov/1999-03-26-14/§10-20",
    tittel: "Skattlegging av verdipapirfond og andelseiere",
  },
  {
    refID: "lov/1999-03-26-14/§10-31",
    tittel: "Skatteplikt for gevinst og fradragsrett for tap",
  },
  { refID: "lov/1999-03-26-14/§10-12", tittel: "Fradrag for skjerming" },
];

function aar(dato: string): number {
  return parseInt(dato.substring(0, 4), 10);
}

function hentKlass(isin: string): FondKlassifiseringEntry {
  const k = klassifisering[isin];
  if (!k) {
    throw new Error(
      `ISIN ${isin} mangler i src/data/fond-klassifisering.json. ` +
        `Legg til entry med type (aksjefond/rentefond/kombinasjonsfond) ` +
        `og evt. aksjeandel_per_år før verktøyet kjøres.`
    );
  }
  return k;
}

function hentAksjeandel(
  k: FondKlassifiseringEntry,
  isin: string,
  år: number
): number {
  if (k.aksjeandel_per_år && k.aksjeandel_per_år[String(år)] !== undefined) {
    return k.aksjeandel_per_år[String(år)];
  }
  if (k.type === "aksjefond") return 1.0;
  if (k.type === "rentefond") return 0.0;
  if (k.type === "kombinasjonsfond") {
    throw new Error(
      `ISIN ${isin} (${k.navn}) er kombinasjonsfond men mangler ` +
        `aksjeandel_per_år["${år}"]. Fyll inn faktisk aksjeandel pr 1.1.${år} ` +
        `i src/data/fond-klassifisering.json.`
    );
  }
  throw new Error(
    `Uventet fondstype "${k.type}" for ISIN ${isin}. ` +
      `Aksje- og ukjent-type skal håndteres før dette punktet.`
  );
}

// Klassifisering av snittsaksjeandel for label (per § 10-20 (2)).
function fondsLabel(snitt: number): "aksjefond" | "rentefond" | "kombinasjonsfond" {
  if (snitt >= AKSJEFOND_GRENSE) return "aksjefond";
  if (snitt <= RENTEFOND_GRENSE) return "rentefond";
  return "kombinasjonsfond";
}

interface KanoniskFondTransaksjon {
  isin: string;
  type: "kjøp" | "salg";
  dato: string;
  antall: number;
  pris_per_andel: number;
  tegnings_innloesningsgebyr: number;
}

// Per-salg detalj i rapporteringsåret.
interface SalgIRapporteringsår {
  dato: string;
  antall: number;
  pris_per_enhet: number;
  salgssum_netto: number;
  kostbase: number;
  gevinst: number;
  // Vektet over delsalg per lot:
  aksjedel: number;
  rentedel: number;
  snittsaksjeandel_vektet: number;
  // Skjerming og oppjustering (kun aksjedel ved positiv gevinst):
  brukt_skjerming: number;
  aksjedel_etter_skjerming: number;
  oppjustert_aksjedel: number;
  skatt_aksjedel: number;
  skatt_rentedel: number;
}

interface IsinBeregning {
  isin: string;
  navn: string;
  config_type: FondKlassifiseringEntry["type"];
  fondslabel: "aksjefond" | "rentefond" | "kombinasjonsfond"; // basert på salg-snitt
  salg_i_år: SalgIRapporteringsår[];
  salg_utenfor_år: FifoSalgsResultat[];
  gjenstående_lots: Lot[];
  inngangs_carry: number;
  årets_skjerming_beregnet: number;
  brukt_skjerming_total: number;
  bortfalt_skjerming: number;
  utgangs_carry: number;
}

// Splitt transaksjoner i pre-rapporteringsår og fra-og-med-rapporteringsår.
// Sortert kronologisk innen hver del.
function splittPrePost(
  trans: KanoniskFondTransaksjon[],
  rapporteringsår: number
): { pre: KanoniskFondTransaksjon[]; full: KanoniskFondTransaksjon[] } {
  const sortert = [...trans].sort((a, b) => a.dato.localeCompare(b.dato));
  const grense = `${rapporteringsår}-01-01`;
  const pre = sortert.filter((t) => t.dato < grense);
  return { pre, full: sortert };
}

function tilFifo(t: KanoniskFondTransaksjon): FifoTransaksjon {
  return {
    type: t.type,
    dato: t.dato,
    antall: t.antall,
    pris_per_enhet: t.pris_per_andel,
    transaksjonsgebyr: t.tegnings_innloesningsgebyr,
  };
}

interface BeregnArgs {
  isin: string;
  trans: KanoniskFondTransaksjon[];
  inngangs_carry: number;
  rapporteringsår: number;
  skjermingsrente: number;
  oppjusteringsfaktor: number;
  // Valgfri override av klassifisering for testbarhet — produksjonskode lar
  // den være udefinert, da brukes konfigfilen.
  override_klass?: FondKlassifiseringEntry;
}

function beregnPerIsin(args: BeregnArgs): IsinBeregning {
  const { isin, trans, inngangs_carry, rapporteringsår, skjermingsrente, oppjusteringsfaktor } =
    args;
  const klass = args.override_klass ?? hentKlass(isin);

  // 1. Lots 1.1 rapporteringsåret = lots etter alle pre-transaksjoner.
  const { pre, full } = splittPrePost(trans, rapporteringsår);
  const preRes = kjørFifo(pre.map(tilFifo), `${isin} pre`);
  const lotsVedÅrsstart = preRes.lots.map((l) => ({
    ...l,
    antall_gjenstående: l.antall_gjenstående,
  }));

  // 2. Årets skjerming = sum over hver lot aktiv 1.1.året:
  //    skjermingsgrunnlag_lot = lot.kostbase_total × aksjeandel_kjøpsår
  //    årets_skjerming_lot   = skjermingsgrunnlag_lot × skjermingsrente
  let årets_skjerming = 0;
  for (const lot of lotsVedÅrsstart) {
    const kjøpsår = aar(lot.dato);
    const aksjeandel_kjøpsår = hentAksjeandel(klass, isin, kjøpsår);
    const grunnlag = lot.antall_gjenstående * lot.kostpris_per_enhet * aksjeandel_kjøpsår;
    årets_skjerming += grunnlag * skjermingsrente;
  }

  // 3. Full FIFO med delsalg → alle salgs-resultater inkl. lot-breakdown.
  let fullRes;
  try {
    fullRes = kjørFifo(full.map(tilFifo), isin, /* inkluder_delsalg */ true);
  } catch (e) {
    if (e instanceof IkkeNokBeholdningFeil) {
      throw new Error(
        `Ikke nok andeler for salg — ISIN ${isin} (${klass.navn}), ` +
          `dato ${e.dato}: forsøkt ${e.forsøkt}, tilgjengelig ${e.tilgjengelig}`
      );
    }
    throw e;
  }

  // 4. Filtrer salg per rapporteringsår.
  const salgRapportert = fullRes.salg.filter((s) => aar(s.dato) === rapporteringsår);
  const salgUtenfor = fullRes.salg.filter((s) => aar(s.dato) !== rapporteringsår);

  // 5. Per salg: beregn aksjedel/rentedel per delsalg (snittsaksjeandel per lot).
  let tilgjengelig_skjerming = inngangs_carry + årets_skjerming;
  let brukt_skjerming_total = 0;
  const salg_i_år: SalgIRapporteringsår[] = [];

  for (const s of salgRapportert) {
    const salgsår = aar(s.dato);
    const aksjeandel_salgsår = hentAksjeandel(klass, isin, salgsår);
    let aksjedel = 0;
    let rentedel = 0;
    // delsalg er garantert satt fordi vi kalte kjørFifo med inkluder_delsalg=true.
    for (const d of s.delsalg ?? []) {
      const kjøpsår = aar(d.fra_lot_dato);
      const aksjeandel_kjøpsår = hentAksjeandel(klass, isin, kjøpsår);
      const snitt = (aksjeandel_kjøpsår + aksjeandel_salgsår) / 2;
      const aksjedel_del = d.gevinst_del * snitt;
      const rentedel_del = d.gevinst_del - aksjedel_del;
      aksjedel += aksjedel_del;
      rentedel += rentedel_del;
    }

    // Vektet snittsaksjeandel for rapporten (rene-aksjefond-fixture: 1.0).
    const snittsaksjeandel_vektet =
      s.gevinst !== 0 ? aksjedel / s.gevinst : aksjeandel_salgsår;

    // Skjerming brukes kun mot positiv aksjedel av gevinst.
    let brukt = 0;
    if (aksjedel > 0) {
      brukt = Math.min(aksjedel, tilgjengelig_skjerming);
      tilgjengelig_skjerming -= brukt;
      brukt_skjerming_total += brukt;
    }
    const aksjedel_etter_skjerming = aksjedel - brukt;
    const oppjustert_aksjedel = aksjedel_etter_skjerming * oppjusteringsfaktor;
    const skatt_aksjedel = oppjustert_aksjedel * 0.22;
    const skatt_rentedel = rentedel * 0.22;

    salg_i_år.push({
      dato: s.dato,
      antall: s.antall,
      pris_per_enhet: s.pris_per_enhet,
      salgssum_netto: s.salgssum_netto,
      kostbase: s.kostbase,
      gevinst: s.gevinst,
      aksjedel,
      rentedel,
      snittsaksjeandel_vektet,
      brukt_skjerming: brukt,
      aksjedel_etter_skjerming,
      oppjustert_aksjedel,
      skatt_aksjedel,
      skatt_rentedel,
    });
  }

  // 6. Bortfall: hvis sluttbeholdning = 0 etter rapporteringsåret, bortfaller
  //    gjenværende akkumulering (§ 10-12 / § 10-21).
  const sluttsaldo = fullRes.lots.reduce(
    (sum, l) => sum + l.antall_gjenstående,
    0
  );
  let bortfalt = 0;
  let utgangs_carry = tilgjengelig_skjerming;
  if (sluttsaldo === 0) {
    bortfalt = utgangs_carry;
    utgangs_carry = 0;
  }

  // 7. Label fra vektet snitt over alle salg i rapporteringsåret
  //    (eller fra config hvis ingen salg).
  const totalGevinst = salg_i_år.reduce((s, x) => s + x.gevinst, 0);
  let labelSnitt: number;
  if (salg_i_år.length === 0) {
    // Bruk salgsårets aksjeandel som proxy når ingen salg.
    labelSnitt = hentAksjeandel(klass, isin, rapporteringsår);
  } else if (totalGevinst !== 0) {
    const totalAksjedel = salg_i_år.reduce((s, x) => s + x.aksjedel, 0);
    labelSnitt = totalAksjedel / totalGevinst;
  } else {
    // Gevinst = 0 (kostpris = salgssum). Bruk gjennomsnitt av salgsårets aksjeandel.
    labelSnitt = hentAksjeandel(klass, isin, rapporteringsår);
  }

  return {
    isin,
    navn: klass.navn,
    config_type: klass.type,
    fondslabel: fondsLabel(labelSnitt),
    salg_i_år,
    salg_utenfor_år: salgUtenfor,
    gjenstående_lots: fullRes.lots,
    inngangs_carry,
    årets_skjerming_beregnet: årets_skjerming,
    brukt_skjerming_total,
    bortfalt_skjerming: bortfalt,
    utgangs_carry,
  };
}

// ── MCP tool ──────────────────────────────────────────────────────────────

export function registerFondVerktøy(server: McpServer): void {
  const transaksjonSchema = z.object({
    isin: z
      .string()
      .regex(/^[A-Z]{2}[A-Z0-9]{9}\d$/)
      .describe("ISIN, 12 tegn. Brukes som nøkkel mot fond-klassifisering.json"),
    type: z.enum(["kjøp", "salg"]),
    dato: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    antall: z.number().positive(),
    pris_per_andel: z.number().nonnegative(),
    tegnings_innloesningsgebyr: z.number().nonnegative().default(0),
  });

  const carrySchema = z.object({
    isin: z.string(),
    akkumulert_ubrukt_skjerming_inngaaende: z
      .number()
      .nonnegative()
      .describe(
        "Akkumulert ubrukt skjerming pr 31.12 forrige år (carry inn til rapporteringsåret)"
      ),
  });

  server.registerTool(
    "calculate_aksjefond",
    {
      title: "Beregn skatt for verdipapirfond (FIFO)",
      description:
        "Beregner skatt for verdipapirfond med transaksjons-array som input. " +
        "FIFO per ISIN. Bruker fond-klassifisering.json for type og aksjeandel. " +
        "Oppjustering ×1,72 kun på aksjedel av gevinst (per § 10-20 (6)). " +
        "Skjerming-grunnlag = lot.kostbase × aksjeandel_kjøpsår (per § 10-20 (4)). " +
        "Inngangs-carry per ISIN aksepteres for kontinuitet over år.",
      inputSchema: {
        transaksjoner: z.array(transaksjonSchema).min(1),
        inngangs_carry_per_isin: z
          .array(carrySchema)
          .default([])
          .describe(
            "Valgfri carry inn til rapporteringsåret per ISIN (default: ingen)"
          ),
        rapporteringsaar: z.number().int().min(2020).max(2025).default(2025),
      },
    },
    async ({ transaksjoner, inngangs_carry_per_isin, rapporteringsaar }) => {
      const skjermingsrente = satser2025.skjermingsrente.personlige_aksjonærer;
      const oppjusteringsfaktor = satser2025.aksjeoppjustering.faktor;
      const skjermingsrenteProsent = (skjermingsrente * 100)
        .toFixed(1)
        .replace(".", ",");

      // 1. Sjekk at alle ISIN-er finnes og at ingen er av type "aksje"/"ukjent".
      const uniqueIsiner = new Set(transaksjoner.map((t) => t.isin));
      for (const isin of uniqueIsiner) {
        let k: FondKlassifiseringEntry;
        try {
          k = hentKlass(isin);
        } catch (e) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: (e as Error).message }],
          };
        }
        if (k.type === "aksje") {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text:
                  `ISIN ${isin} (${k.navn}) er klassifisert som ren aksje i ` +
                  `fond-klassifisering.json. Bruk calculate_aksjegevinst i ` +
                  `stedet for fond-spesifikke aksjer.`,
              },
            ],
          };
        }
        if (k.type === "ukjent") {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text:
                  `ISIN ${isin} (${k.navn}) har type "ukjent" i ` +
                  `fond-klassifisering.json. Klassifiser entry til ` +
                  `aksjefond/rentefond/kombinasjonsfond før kall.`,
              },
            ],
          };
        }
      }

      // 2. Carry-map
      const carryMap = new Map<string, number>();
      for (const c of inngangs_carry_per_isin) {
        carryMap.set(c.isin, c.akkumulert_ubrukt_skjerming_inngaaende);
      }

      // 3. Per-ISIN gruppering og beregning
      const perIsin = new Map<string, KanoniskFondTransaksjon[]>();
      for (const t of transaksjoner) {
        const liste = perIsin.get(t.isin) ?? [];
        liste.push(t);
        perIsin.set(t.isin, liste);
      }

      const resultater: IsinBeregning[] = [];
      for (const [isin, tList] of perIsin) {
        try {
          resultater.push(
            beregnPerIsin({
              isin,
              trans: tList,
              inngangs_carry: carryMap.get(isin) ?? 0,
              rapporteringsår: rapporteringsaar,
              skjermingsrente,
              oppjusteringsfaktor,
            })
          );
        } catch (e) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: (e as Error).message }],
          };
        }
      }

      // 4. Output-bygging — én blokk per ISIN med kronologisk salg-tabell.
      const linjer: string[] = [
        `Verdipapirfond — rapporteringsår ${rapporteringsaar}`,
        `Skjermingsrente: ${skjermingsrenteProsent} %, oppjusteringsfaktor: ${oppjusteringsfaktor}`,
        ``,
      ];

      let sumGevinst = 0;
      let sumTap = 0;
      let sumAksjedelEtterSkjerming = 0;
      let sumOppjustert = 0;
      let sumSkattAksje = 0;
      let sumSkattRente = 0;
      let sumBruktSkjerming = 0;
      let sumBortfaltSkjerming = 0;

      for (const r of resultater) {
        linjer.push(`── ${r.isin}  ${r.navn}`);
        linjer.push(
          `   Config-type: ${r.config_type}   ` +
            `Salgs-label: ${r.fondslabel}`
        );

        if (r.salg_i_år.length === 0) {
          linjer.push(`   Ingen realiserte salg i ${rapporteringsaar}.`);
          if (r.salg_utenfor_år.length > 0) {
            linjer.push(
              `   Salg utenfor rapporteringsår: ${r.salg_utenfor_år.length}`
            );
          }
        } else {
          linjer.push(``);
          linjer.push(
            `   Salg i ${rapporteringsaar}:`
          );
          for (const s of r.salg_i_år) {
            const tegn = s.gevinst >= 0 ? "gevinst" : "tap";
            linjer.push(
              `     ${s.dato}  ${formaterKrDesimal(s.antall)} andeler @ ${formaterKr(s.pris_per_enhet)}  ` +
                `→ netto ${formaterKr(s.salgssum_netto)}, kostbase ${formaterKr(s.kostbase)}, ${tegn} ${formaterKr(Math.abs(s.gevinst))}`
            );
            const snittPst = (s.snittsaksjeandel_vektet * 100).toFixed(0);
            linjer.push(
              `       Snittsaksjeandel (vektet): ${snittPst} %  →  ` +
                `aksjedel ${formaterKrDesimal(s.aksjedel)}, rentedel ${formaterKrDesimal(s.rentedel)}`
            );
            if (s.brukt_skjerming > 0) {
              linjer.push(
                `       Brukt skjerming: ${formaterKrDesimal(s.brukt_skjerming)}  ` +
                  `→ aksjedel etter skjerming: ${formaterKrDesimal(s.aksjedel_etter_skjerming)}`
              );
            }
            linjer.push(
              `       Oppjustert aksjedel (×${oppjusteringsfaktor}): ${formaterKrDesimal(s.oppjustert_aksjedel)}  ` +
                `→ skatt aksje ${formaterKrDesimal(s.skatt_aksjedel)}, skatt rente ${formaterKrDesimal(s.skatt_rentedel)}`
            );
          }
        }

        // Skjerming-blokk for rapporteringsåret
        if (r.config_type !== "rentefond" || r.inngangs_carry > 0) {
          linjer.push(``);
          linjer.push(`   Skjerming-rekneskap ${rapporteringsaar}:`);
          linjer.push(
            `     Inngangs-carry (31.12 forrige år):       ${formaterKrDesimal(r.inngangs_carry).padStart(12)}`
          );
          linjer.push(
            `     Beregnet årets skjerming:                ${formaterKrDesimal(r.årets_skjerming_beregnet).padStart(12)}`
          );
          linjer.push(
            `     Brukt mot salg:                          ${formaterKrDesimal(r.brukt_skjerming_total).padStart(12)}`
          );
          if (r.bortfalt_skjerming > 0) {
            linjer.push(
              `     Bortfalt ved 100 % avhending:            ${formaterKrDesimal(r.bortfalt_skjerming).padStart(12)}`
            );
          }
          linjer.push(
            `     Utgangs-carry (31.12 ${rapporteringsaar}):              ${formaterKrDesimal(r.utgangs_carry).padStart(12)}`
          );
        }

        // Aggreger
        for (const s of r.salg_i_år) {
          if (s.gevinst >= 0) sumGevinst += s.gevinst;
          else sumTap += s.gevinst;
          sumAksjedelEtterSkjerming += s.aksjedel_etter_skjerming;
          sumOppjustert += s.oppjustert_aksjedel;
          sumSkattAksje += s.skatt_aksjedel;
          sumSkattRente += s.skatt_rentedel;
        }
        sumBruktSkjerming += r.brukt_skjerming_total;
        sumBortfaltSkjerming += r.bortfalt_skjerming;

        linjer.push(``);
      }

      // Aggregert
      const nettoGevinst = sumGevinst + sumTap;
      const totalSkatt = sumSkattAksje + sumSkattRente;

      linjer.push(`Aggregert (alle ISIN-er):`);
      linjer.push(
        `  Sum gevinst:                            ${formaterKr(sumGevinst).padStart(12)}`
      );
      linjer.push(
        `  Sum tap:                                ${formaterKr(sumTap).padStart(12)}`
      );
      linjer.push(
        `  Netto realisert:                        ${formaterKr(nettoGevinst).padStart(12)}`
      );
      linjer.push(
        `  Aksjedel etter skjerming (sum):         ${formaterKr(sumAksjedelEtterSkjerming).padStart(12)}`
      );
      linjer.push(
        `  Oppjustert aksjedel (×${oppjusteringsfaktor}):              ${formaterKr(sumOppjustert).padStart(12)}`
      );
      linjer.push(
        `  Skatt aksjedel (22 %):                  ${formaterKr(sumSkattAksje).padStart(12)}`
      );
      linjer.push(
        `  Skatt rentedel (22 %):                  ${formaterKr(sumSkattRente).padStart(12)}`
      );
      linjer.push(
        `  ${totalSkatt >= 0 ? "Total skatt" : "Total skattefradrag"}:                            ${formaterKr(totalSkatt).padStart(12)}`
      );
      linjer.push(
        `  Brukt skjerming (sum):                  ${formaterKr(sumBruktSkjerming).padStart(12)}`
      );
      if (sumBortfaltSkjerming > 0) {
        linjer.push(
          `  Bortfalt skjerming (sum):               ${formaterKr(sumBortfaltSkjerming).padStart(12)}`
        );
      }

      linjer.push(paragrafBlokk(PARAGRAFER_FOND));

      return {
        content: [{ type: "text" as const, text: linjer.join("\n") }],
      };
    }
  );
}

// Eksportert for testbarhet (identitetstest mot dagens fond.ts).
export { beregnPerIsin };
export type { IsinBeregning, KanoniskFondTransaksjon };
