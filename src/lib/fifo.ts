// Domene-nøytral FIFO-engine for kjøp/salg av en homogen beholdning (aksjer, krypto, etc.).
// Transaksjonsgebyr legges til kostbase ved kjøp og trekkes fra salgsinntekten ved salg.
// Ingen oppjustering, ingen skjermingsfradrag, ingen rapporteringsår-filtrering — det er kallers ansvar.

export interface Lot {
  dato: string;
  antall_gjenstående: number;
  kostpris_per_enhet: number;
}

export interface FifoTransaksjon {
  type: "kjøp" | "salg";
  dato: string;
  antall: number;
  pris_per_enhet: number;
  transaksjonsgebyr: number;
}

export interface FifoSalgsResultat {
  dato: string;
  antall: number;
  pris_per_enhet: number;
  transaksjonsgebyr: number;
  salgssum_netto: number;
  kostbase: number;
  gevinst: number;
  // Valgfritt per-lot-breakdown. Kun satt når kjørFifo kalles med inkluder_delsalg=true.
  // Sum av delsalg-felter = aggregert salg-felt (modulo float-runding).
  delsalg?: DelSalg[];
}

export interface DelSalg {
  fra_lot_dato: string;
  antall: number;
  kostpris_per_enhet: number;
  salgssum_del: number;
  kostbase_del: number;
  gevinst_del: number;
}

export class IkkeNokBeholdningFeil extends Error {
  constructor(
    public readonly identifikator: string,
    public readonly dato: string,
    public readonly forsøkt: number,
    public readonly tilgjengelig: number
  ) {
    super(
      `Ikke nok beholdning for salg — ${identifikator}, ${dato}: ` +
      `forsøkt ${forsøkt}, tilgjengelig ${tilgjengelig}`
    );
    this.name = "IkkeNokBeholdningFeil";
  }
}

export function kjørFifo(
  transaksjoner: FifoTransaksjon[],
  identifikator: string,
  inkluder_delsalg = false
): { lots: Lot[]; salg: FifoSalgsResultat[] } {
  const sortert = [...transaksjoner].sort((a, b) => a.dato.localeCompare(b.dato));
  const lots: Lot[] = [];
  const salg: FifoSalgsResultat[] = [];

  for (const t of sortert) {
    if (t.type === "kjøp") {
      const kostpris_per_enhet =
        (t.antall * t.pris_per_enhet + t.transaksjonsgebyr) / t.antall;
      lots.push({
        dato: t.dato,
        antall_gjenstående: t.antall,
        kostpris_per_enhet,
      });
    } else {
      const tilgjengelig = lots.reduce(
        (sum, lot) => sum + lot.antall_gjenstående,
        0
      );
      if (t.antall > tilgjengelig) {
        throw new IkkeNokBeholdningFeil(
          identifikator,
          t.dato,
          t.antall,
          tilgjengelig
        );
      }

      const salgssumNetto = t.antall * t.pris_per_enhet - t.transaksjonsgebyr;
      const deler: DelSalg[] = [];

      let gjenstående = t.antall;
      let kostbase = 0;
      while (gjenstående > 0) {
        const lot = lots[0];
        const fraLot = Math.min(gjenstående, lot.antall_gjenstående);
        const kostbase_del = fraLot * lot.kostpris_per_enhet;
        kostbase += kostbase_del;
        if (inkluder_delsalg) {
          const salgssum_del = (fraLot / t.antall) * salgssumNetto;
          deler.push({
            fra_lot_dato: lot.dato,
            antall: fraLot,
            kostpris_per_enhet: lot.kostpris_per_enhet,
            salgssum_del,
            kostbase_del,
            gevinst_del: salgssum_del - kostbase_del,
          });
        }
        lot.antall_gjenstående -= fraLot;
        gjenstående -= fraLot;
        if (lot.antall_gjenstående === 0) lots.shift();
      }

      const salgResultat: FifoSalgsResultat = {
        dato: t.dato,
        antall: t.antall,
        pris_per_enhet: t.pris_per_enhet,
        transaksjonsgebyr: t.transaksjonsgebyr,
        salgssum_netto: salgssumNetto,
        kostbase,
        gevinst: salgssumNetto - kostbase,
      };
      if (inkluder_delsalg) {
        salgResultat.delsalg = deler;
      }
      salg.push(salgResultat);
    }
  }

  return { lots, salg };
}
