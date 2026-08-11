# AGENTS.md

Instruksene for dette repoet ligger i **[`CLAUDE.md`](CLAUDE.md)** i samme mappe.
Filnavnet er historisk. Innholdet er verktøy-nøytral prosjektdokumentasjon —
les det først, uansett hvilken agent eller modell du er.

Kart over alle repoene: [`../CLAUDE.md`](../CLAUDE.md) ·
full katalog: [`../INDEX.md`](../INDEX.md)

## Ufravikelig — gjelder enhver agent

- **Push aldri uten eksplisitt godkjenning fra Valiant.**
- **Aldri `Co-Authored-By`-trailer i commits.** Commit-meldinger på norsk.
- **Ikke foreslå omorganisering** av mappestrukturen under `projects/`. Den flate
  rota er et bevisst valg (vurdert og forkastet to ganger) — scripts, manifester
  og deploy-stier hardkoder flate sibling-navn.
- Norsk i innhold, engelske identifikatorer i kode. Datoer ISO 8601.
- Tall fabrikkeres aldri: verifisert kilde, eller NULL + eksplisitt flagg.
  Usikre eller utdaterte data flagges i selve artefakten.

## Ved øktstart

1. Les `../hub/STATUS.md` — forsiden over hva som er på topp nå.
2. Les `../hub/projects/<navn>/notes.md` for prosjektet du jobber i.
3. Etter commits: logg i hub med `../hub/scripts/auto_entry.py` og oppdater
   `notes.md` i samme prosjektmappe. `auto.md` er maskin-eid — skriv aldri i den.
