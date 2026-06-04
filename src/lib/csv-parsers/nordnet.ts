// Parser for Nordnets CSV-eksport av transaksjoner.
// Format: UTF-16 LE BOM med tab-separator (decoding skjer i kallende lag).
// Returnerer kanonisk transaksjons-array klart for calculate_aksjegevinst,
// pluss klassifiseringshint og rapport over hoppet-over rader.

export class NordnetCsvFeil extends Error {
  constructor(
    public readonly grunn: string,
    public readonly linje?: number,
    public readonly kolonne?: string
  ) {
    const stedDel =
      linje !== undefined ? ` (linje ${linje}${kolonne ? `, ${kolonne}` : ""})` : "";
    super(`Nordnet CSV: ${grunn}${stedDel}`);
    this.name = "NordnetCsvFeil";
  }
}

export interface KanoniskTransaksjon {
  ticker: string;
  isin: string;
  type: "kjøp" | "salg";
  dato: string;
  antall: number;
  pris_per_aksje: number;
  kurtasje: number;
}

export type Klassifisering =
  | "aksje"
  | "fond_aksje_sannsynlig"
  | "fond_rente_sannsynlig"
  | "etf"
  | "ukjent";

export interface HoppetOverRad {
  rad_nr: number;
  transaksjonstype: string;
  verdipapir: string;
  grunn: string;
}

export interface NordnetParseResultat {
  transaksjoner: KanoniskTransaksjon[];
  klassifisering_hint: Record<string, Klassifisering>;
  hoppet_over: HoppetOverRad[];
  oppsummering: {
    antall_kjøp: number;
    antall_salg: number;
    antall_hoppet_over: number;
    periode: { fra: string; til: string };
    valutaer_native: string[];
    antall_unike_verdipapirer: number;
  };
}

const FORVENTET_HEADER = [
  "Id",
  "Bokføringsdag",
  "Handelsdag",
  "Oppgjørsdag",
  "Portefølje",
  "Transaksjonstype",
  "Verdipapir",
  "ISIN",
  "Antall",
  "Kurs",
  "Rente",
  "Totale Avgifter",
  "Valuta",
  "Beløp",
  "Valuta",
  "Kjøpsverdi",
  "Valuta",
  "Resultat",
  "Valuta",
  "Totalt antall",
  "Saldo",
  "Vekslingskurs",
  "Transaksjonstekst",
  "Makuleringsdato",
  "Sluttseddelnummer",
  "Verifikationsnummer",
  "Kurtasje",
  "Valuta",
  "Valutakurs",
  "Innledende rente",
];

// Kolonneindekser i header (0-indeksert)
const KOL = {
  HANDELSDAG: 2,
  TRANSAKSJONSTYPE: 5,
  VERDIPAPIR: 6,
  ISIN: 7,
  ANTALL: 8,
  TOTALE_AVGIFTER: 11,
  BELØP: 13,
  VALUTA_BELØP: 14,
  KJØPSVERDI: 15,
  VALUTA_KJØPSVERDI: 16,
  VALUTA_RESULTAT: 18,
  TRANSAKSJONSTEKST: 22,
  KURTASJE: 26,
} as const;

const ISO_DATO = /^\d{4}-\d{2}-\d{2}$/;

function parseTallNorsk(s: string): number {
  if (!s) return NaN;
  // Nordnet bruker komma som desimaltegn, mellomrom kan forekomme som tusen-skille
  const ren = s.replace(/\s/g, "").replace(",", ".");
  return parseFloat(ren);
}

function klassifiser(verdipapir: string): Klassifisering {
  // Rentefond — sjekkes først pga overlapp med andre fond-mønstre
  const rentefondMønstre = [
    /høyrente/i,
    /likviditet/i,
    /corporate bond/i,
    /high yield/i,
  ];
  if (rentefondMønstre.some((p) => p.test(verdipapir))) {
    return "fond_rente_sannsynlig";
  }

  // ETF — UCITS ETF eller kjente ETF-utstedere
  if (
    /\bucits etf\b/i.test(verdipapir) ||
    /^ishares\b/i.test(verdipapir) ||
    /^l&g\b/i.test(verdipapir)
  ) {
    return "etf";
  }

  // Aksjefond — indeksfond, kjente fondsmerker
  const aksjefondMønstre = [
    /\bindeks\b/i,
    /\bindex\b/i,
    /\bindeksi\b/i, // Finsk
    /\bfund\b/i,
    /^dnb (global|nuclear|usa)\b/i,
    /^klp\s/i,
    /^odin\s/i,
    /^alfred berg\s/i,
    /^handelsbanken\s/i,
    /^nordea\s/i,
    /^nordnet (danmark|emerging|global|norge|suomi|teknologi|usa)/i,
    /^storebrand renewable/i,
    /^ubs\s/i,
    /^bgf\s/i,
    /^ms invf\b/i,
    /^dws\s/i,
    /^jpm\s/i,
    /^sissener/i,
  ];
  if (aksjefondMønstre.some((p) => p.test(verdipapir))) {
    return "fond_aksje_sannsynlig";
  }

  return "aksje";
}

function strippBom(s: string): string {
  if (s.charCodeAt(0) === 0xfeff) return s.slice(1);
  return s;
}

function splittLinjer(innhold: string): string[] {
  const linjer = strippBom(innhold).split(/\r?\n/);
  while (linjer.length > 0 && linjer[linjer.length - 1] === "") linjer.pop();
  return linjer;
}

function validerHeader(linje: string): string[] {
  const celler = linje.split("\t");
  if (celler.length !== FORVENTET_HEADER.length) {
    throw new NordnetCsvFeil(
      `Forventet ${FORVENTET_HEADER.length} kolonner i header, fant ${celler.length}. ` +
        `Sjekk at dette er en Nordnet transaksjons-eksport.`,
      1
    );
  }
  for (let i = 0; i < FORVENTET_HEADER.length; i++) {
    if (celler[i] !== FORVENTET_HEADER[i]) {
      throw new NordnetCsvFeil(
        `Header-kolonne ${i + 1} mismatch: forventet "${FORVENTET_HEADER[i]}", fant "${celler[i]}"`,
        1
      );
    }
  }
  return celler;
}

export function parseNordnetCsv(innhold: string): NordnetParseResultat {
  const linjer = splittLinjer(innhold);
  if (linjer.length === 0) {
    throw new NordnetCsvFeil("Tom fil");
  }

  validerHeader(linjer[0]);

  const transaksjoner: KanoniskTransaksjon[] = [];
  const hoppetOver: HoppetOverRad[] = [];
  const klassifiseringHint: Record<string, Klassifisering> = {};
  const valutaerNative = new Set<string>();
  const verdipapirSet = new Set<string>();

  for (let i = 1; i < linjer.length; i++) {
    const radNr = i + 1; // 1-indeksert i bruker-feedback (header er linje 1, første data er linje 2)
    const celler = linjer[i].split("\t");
    if (celler.length !== FORVENTET_HEADER.length) {
      throw new NordnetCsvFeil(
        `Forventet ${FORVENTET_HEADER.length} felt, fant ${celler.length}`,
        radNr
      );
    }

    const transaksjonstype = celler[KOL.TRANSAKSJONSTYPE];
    const verdipapir = celler[KOL.VERDIPAPIR].trim();
    const isin = (celler[KOL.ISIN] ?? "").trim();
    const handelsdag = celler[KOL.HANDELSDAG];

    // Klassifiser alle ikke-tomme verdipapirer (også hoppet-over rader gir hint)
    if (verdipapir && !(verdipapir in klassifiseringHint)) {
      klassifiseringHint[verdipapir] = klassifiser(verdipapir);
    }
    if (verdipapir) verdipapirSet.add(verdipapir);

    // Native valuta — fra Resultat-kolonnen, beste indikator for verdipapirets valuta
    const nativeValuta = celler[KOL.VALUTA_RESULTAT];
    if (
      (transaksjonstype === "KJØPT" || transaksjonstype === "SALG") &&
      nativeValuta
    ) {
      valutaerNative.add(nativeValuta);
    }

    if (transaksjonstype === "KJØPT" || transaksjonstype === "SALG") {
      const valutaBeløp = celler[KOL.VALUTA_BELØP];
      if (valutaBeløp !== "NOK") {
        hoppetOver.push({
          rad_nr: radNr,
          transaksjonstype,
          verdipapir,
          grunn: `Beløp i ${valutaBeløp || "(tom)"} — kun NOK Beløp støttes. Manuell konvertering eller utvidelse av parser nødvendig.`,
        });
        continue;
      }

      if (!ISO_DATO.test(handelsdag)) {
        throw new NordnetCsvFeil(
          `Ugyldig Handelsdag "${handelsdag}" for ${transaksjonstype} av ${verdipapir}`,
          radNr,
          "Handelsdag"
        );
      }

      const antall = parseTallNorsk(celler[KOL.ANTALL]);
      const beløp = parseTallNorsk(celler[KOL.BELØP]);
      const kurtasjeStr = celler[KOL.KURTASJE];
      const kurtasje = kurtasjeStr ? parseTallNorsk(kurtasjeStr) : 0;

      if (!isFinite(antall) || antall <= 0) {
        throw new NordnetCsvFeil(
          `Ugyldig Antall "${celler[KOL.ANTALL]}" for ${transaksjonstype} av ${verdipapir}`,
          radNr,
          "Antall"
        );
      }
      if (!isFinite(beløp)) {
        throw new NordnetCsvFeil(
          `Ugyldig Beløp "${celler[KOL.BELØP]}" for ${transaksjonstype} av ${verdipapir}`,
          radNr,
          "Beløp"
        );
      }
      if (!isFinite(kurtasje) || kurtasje < 0) {
        throw new NordnetCsvFeil(
          `Ugyldig Kurtasje "${kurtasjeStr}" for ${transaksjonstype} av ${verdipapir}`,
          radNr,
          "Kurtasje"
        );
      }

      // For KJØPT er Beløp negativt og inkluderer kurtasje (faktisk uttak fra konto).
      // For SALG er Beløp positivt og er netto av kurtasje (faktisk innskudd).
      // Brutto NOK-pris (eksl. kurtasje) per aksje:
      //   KJØPT: pris = (|Beløp| − kurtasje) / antall
      //   SALG:  pris = (Beløp + kurtasje) / antall
      let pris_per_aksje: number;
      if (transaksjonstype === "KJØPT") {
        pris_per_aksje = (Math.abs(beløp) - kurtasje) / antall;
      } else {
        pris_per_aksje = (beløp + kurtasje) / antall;
      }

      if (!isFinite(pris_per_aksje) || pris_per_aksje < 0) {
        throw new NordnetCsvFeil(
          `Beregnet pris_per_aksje (${pris_per_aksje}) ugyldig for ${verdipapir}`,
          radNr
        );
      }

      transaksjoner.push({
        ticker: verdipapir,
        isin,
        type: transaksjonstype === "KJØPT" ? "kjøp" : "salg",
        dato: handelsdag,
        antall,
        pris_per_aksje,
        kurtasje,
      });
      continue;
    }

    if (transaksjonstype === "INNLEGG OVERFØRING") {
      const valutaKjøpsverdi = celler[KOL.VALUTA_KJØPSVERDI];
      if (valutaKjøpsverdi !== "NOK") {
        hoppetOver.push({
          rad_nr: radNr,
          transaksjonstype,
          verdipapir,
          grunn: `INNLEGG OVERFØRING med Kjøpsverdi i ${valutaKjøpsverdi || "(tom)"} — valutakonvertering ikke implementert. Manuell oppfølging: legg til som syntetisk kjøp med NOK-konvertert kostbase før FIFO-kjøring.`,
        });
        continue;
      }

      if (!ISO_DATO.test(handelsdag)) {
        throw new NordnetCsvFeil(
          `Ugyldig Handelsdag "${handelsdag}" for INNLEGG OVERFØRING av ${verdipapir}`,
          radNr,
          "Handelsdag"
        );
      }

      const antall = parseTallNorsk(celler[KOL.ANTALL]);
      const kjøpsverdi = parseTallNorsk(celler[KOL.KJØPSVERDI]);

      if (!isFinite(antall) || antall <= 0) {
        throw new NordnetCsvFeil(
          `Ugyldig Antall "${celler[KOL.ANTALL]}" for INNLEGG OVERFØRING av ${verdipapir}`,
          radNr,
          "Antall"
        );
      }
      if (!isFinite(kjøpsverdi) || kjøpsverdi < 0) {
        throw new NordnetCsvFeil(
          `Ugyldig Kjøpsverdi "${celler[KOL.KJØPSVERDI]}" for INNLEGG OVERFØRING av ${verdipapir}`,
          radNr,
          "Kjøpsverdi"
        );
      }

      transaksjoner.push({
        ticker: verdipapir,
        isin,
        type: "kjøp",
        dato: handelsdag,
        antall,
        pris_per_aksje: kjøpsverdi / antall,
        kurtasje: 0,
      });
      continue;
    }

    // Spesielle skip-rad-typer med eksplisitt grunn
    const tekst = celler[KOL.TRANSAKSJONSTEKST];
    if (
      transaksjonstype === "BYTTE INNLEGG VP" ||
      transaksjonstype === "BYTTE UTTAK VP"
    ) {
      hoppetOver.push({
        rad_nr: radNr,
        transaksjonstype,
        verdipapir,
        grunn:
          `${transaksjonstype} av ${verdipapir} — fonds-/andelsklassebytte. ` +
          `Eksisterende lots i FIFO må manuelt justeres til ny ISIN/andelsklasse før verktøyet kjøres. ` +
          (tekst ? `Tekst: "${tekst}"` : ""),
      });
      continue;
    }
    if (
      transaksjonstype === "SPLITT INNLEGG VP" ||
      transaksjonstype === "SPLITT UTTAK VP"
    ) {
      hoppetOver.push({
        rad_nr: radNr,
        transaksjonstype,
        verdipapir,
        grunn:
          `${transaksjonstype} av ${verdipapir} — eksisterende lots i FIFO må justeres i samsvar med splitt-forholdet før verktøyet kjøres. ` +
          (tekst ? `Tekst: "${tekst}"` : ""),
      });
      continue;
    }
    if (transaksjonstype === "REINVESTERT UTBYTTE") {
      hoppetOver.push({
        rad_nr: radNr,
        transaksjonstype,
        verdipapir,
        grunn: `Reinvestert utbytte av ${verdipapir} — bør behandles som syntetisk kjøp med kostbase = utbytte-beløp. Manuell oppfølging nødvendig før FIFO-kjøring.`,
      });
      continue;
    }
    if (transaksjonstype === "DESIM. UT VP IKKE UT") {
      hoppetOver.push({
        rad_nr: radNr,
        transaksjonstype,
        verdipapir,
        grunn: "Desimal-rensing — ingen effekt på FIFO.",
      });
      continue;
    }

    // Generell fallback: alle andre typer (UTBYTTE, INNSKUDD, AVGIFT, KUPONGSKATT etc.)
    hoppetOver.push({
      rad_nr: radNr,
      transaksjonstype,
      verdipapir,
      grunn: `Ikke FIFO-relevant transaksjonstype: ${transaksjonstype}`,
    });
  }

  // Kalkuler periode fra transaksjonene
  const datoer = transaksjoner.map((t) => t.dato).sort();
  const periode =
    datoer.length > 0
      ? { fra: datoer[0], til: datoer[datoer.length - 1] }
      : { fra: "", til: "" };

  return {
    transaksjoner,
    klassifisering_hint: klassifiseringHint,
    hoppet_over: hoppetOver,
    oppsummering: {
      antall_kjøp: transaksjoner.filter((t) => t.type === "kjøp").length,
      antall_salg: transaksjoner.filter((t) => t.type === "salg").length,
      antall_hoppet_over: hoppetOver.length,
      periode,
      valutaer_native: [...valutaerNative].sort(),
      antall_unike_verdipapirer: verdipapirSet.size,
    },
  };
}
