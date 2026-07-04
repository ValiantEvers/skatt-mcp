// Delte hjelpere for kalkulator-verktøyene. Ekstrahert fra tidligere
// copy-paste i tool-filene — implementasjonene er uendret, så output er
// byte-identisk med de gamle lokale variantene (identity-testene i scripts/
// er beviset).
import type { ParagrafRef } from "./lovdata.js";
import satser2025 from "../data/satser/2025.json" with { type: "json" };
import satser2026 from "../data/satser/2026.json" with { type: "json" };

export type Satser = typeof satser2025;

export function hentSatser(år: number): Satser {
  if (år === 2025) return satser2025;
  if (år === 2026) return satser2026;
  throw new Error(`Satser for ${år} er ikke implementert ennå`);
}

export function formaterKr(n: number): string {
  return Math.round(n).toLocaleString("nb-NO");
}

// Brukes for skattekomponenter der halv-krone er vanlig (f.eks. formuesskatt).
// Vis maks 2 desimaler, men bare om nødvendig (18 322,50 → ikke 18 322,5000).
export function formaterKrDesimal(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  const harDesimaler = rounded % 1 !== 0;
  return rounded.toLocaleString("nb-NO", {
    minimumFractionDigits: harDesimaler ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

export function paragrafBlokk(refs: ParagrafRef[]): string {
  return ["", "Relevante paragrafer:",
    ...refs.map(r => `  ${r.refID.padEnd(28)} (${r.tittel})`),
  ].join("\n");
}

// Forbehold for år der enkelte satser ennå ikke er endelig fastsatt.
// Returnerer null for år uten forbehold — kall-sites pusher betinget,
// slik at 2025-output forblir byte-identisk.
export function satsForbehold(år: number): string | null {
  if (år === 2026) {
    return (
      "FORBEHOLD: skjermingsrenten for 2026 er FORELØPIG (proxy = 2025-renten, 3,6 %) " +
      "— den fastsettes av Skattedirektoratet først i januar 2027."
    );
  }
  return null;
}
