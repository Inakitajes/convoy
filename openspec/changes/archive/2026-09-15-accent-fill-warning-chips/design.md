## Context

The Home TUI paints colored surfaces by wrapping `TextChunk`s in a background:

- `highlighted()` in `src/home-tui.ts` wraps every chunk that does **not** already carry a background with the accent fill, and leaves chunks that do (the state rail/dot) untouched.
- `filledLines()` in `src/home-tui.ts` wraps every chunk with a fill **unconditionally**; it backs the detail's identity zone (accent) and the new-worktree input well.

Facts are built with foreground-only chunks. Both the fold's `fact()` and the zone's `zoneFact()` colour a warning value with `theme.yellow`. On an accent fill that ink measures ~1.26:1 (dark), ~1.21:1 (light), ~1.03:1 (neutral) — unreadable — whereas the same yellow as ink on the canvas is 9.63:1. Palette definitions live in `src/tui-theme.ts`; `chipText` is documented as "text drawn on top of colored chips". Motivation is in `proposal.md`.

The two fill paths disagree on one rule: `highlighted` already lets a chunk keep its own background, `filledLines` does not. A chip that must survive a fill therefore only works in the fold today.

## Goals / Non-Goals

**Goals:**

- Warnings on filled surfaces render as a filled chip (fill + contrasting ink), preserving the warning signal while making the value legible.
- A dedicated warning fill/ink pair per palette that guarantees the ink contrasts with the fill, and the fill stays distinguishable from the accent fill.
- One shared mechanism so the fold and the detail zone render warnings identically.

**Non-Goals:**

- Changing which conditions raise a warning, or the independence of the underlying observations.
- Changing warnings on plain surfaces (the detail's remaining facts keep yellow ink).
- Introducing chips in TUI surfaces that have no warn-on-fill today (`runs-browser`, `specs-browser`).
- Reworking the accent fill, the palette at large, or the selected-row highlight design.

## Decisions

### D1: Warnings are context-sensitive — ink on plain surfaces, fill on filled surfaces

A warning keeps `yellow` **ink** where the surface is transparent (yellow on canvas is 9.63:1). Where the surface is a fill, the warning becomes a **chip**: `warning` fill + `warningInk` text. This keeps the existing "warning = yellow" vocabulary while removing the illegible combination, instead of abandoning yellow or dimming the accent.

*Alternative considered:* keep yellow ink but lighten/darken it per surface — rejected because no single ink clears 4.5:1 against both the blue accent and the canvas across palettes.

### D2: A dedicated palette pair, not the palette's `yellow`

The palette's `yellow` is tuned as ink on the canvas; as a fill on light it is a dark olive that clears contrast with nothing reasonable:

| fill | ink | ink/fill | fill/accent | verdict |
|---|---|---|---|---|
| `#E0AF68` (dark yellow) | `#0A0E1A` | 9.63 | 2.01 | satisfies both, on dark and light |
| `#8C6C3E` (light yellow) | `#000000` | 4.33 | 1.21 | fails ink/fill on light |
| `#8C6C3E` | `#E1E2E7` (`chipText` on light) | 3.75 | 1.21 | fails ink/fill on light |

So the change adds two palette fields, a warning fill and a warning ink, and chooses values per palette so the ink clears 4.5:1 against the fill and the fill stays distinguishable from the accent fill. The dark and light palettes use the amber fill `#E0AF68` with near-black ink `#0A0E1A`; neutral already passes with `#B59B3A` + `#000000` and may keep it or adopt the same pair. Because the chip's ink is **not** `chipText` (near-white on light), the new ink field is excluded from `PaletteColor` alongside `chipText` so it is never treated as a fill target.

*Alternative considered:* reuse `chipText` as the chip ink — rejected, it fails on light (3.75). *Alternative considered:* brighten the light palette's `yellow` in place — rejected, it is also used as ink elsewhere on light surfaces and would regress those.

### D3: One chip over the whole value, not per token

The whole warning value renders as one chip (the current yellow already spans the whole value: `pipeline · live · 1m 53s`). No attempt to chip only the `live`/`uncertain` token; a per-token chip would split one observation into mixed surfaces and complicate truncation.

### D4: Share the "preserve an existing background" rule between both fillers

`highlighted` already preserves a chunk's own background; `filledLines` does not. Extract that rule into one shared helper and apply it in both, so a chip survives either filler. This is additive for `filledLines`: the detail zone's rows and the input wall's rows currently carry no chunk-level backgrounds, so only the new chips change behaviour.

### D5: A single `warnChip` helper produces the chunk

One helper builds `bg(warning)(fg(warningInk)(value))` and is used by the fold's `fact()` (writer, unknown dirt, unknown changes) and the detail zone's `zoneFact()` (non-known linked PR). The plain detail facts keep passing `theme.yellow` to their existing colour parameter.

## Risks / Trade-offs

- **A saturated chip can overpower the row** → chip the value only, keep its label in the ordinary chip text, and keep the chip hue far from the accent blue; a single value per row is chipped.
- **A long `unknown (reason)` value becomes a long amber bar** → the value is already truncated to the fact column; the chip follows the truncated text and its length, so it never exceeds the row.
- **The shared escape could let unrelated backgrounds survive a fill** → verified that the only chunks in filled rows today carry foreground only, so the escape changes nothing until a chip exists.
- **The chip reverses a deliberate, test-locked contract** → the change is intentional and recorded in the spec; the affected test is updated as part of the work rather than worked around.
- **Light/neutral aesthetics** → the pair is chosen against measured contrast, not by eye, and is covered by a palette test.

## Migration Plan

None required: the change is presentation-only with no persisted data, public API, or configuration surface. Rollback restores the palette fields and the two call sites.

## Open Questions

- Whether other TUI surfaces (runs/specs browsers) should later adopt the warning chip if a warn-on-fill appears there. Deferrable; adding it there would not change this spec or approach.
