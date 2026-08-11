# Andera Color Palette (extracted from andera.ai)

Source: CSS custom properties in https://www.andera.ai/ stylesheets
(`/_next/static/css/bee5e7a3ebfb31f0.css`, `362293a83eb0c962.css`, `529578d8231225fa.css`), fetched 2026-08-11.

## Brand anchor

- `--theme: var(--purple300)` → **#A9A1E6** — the site's primary theme color.

## Purple scale

| Token | Value |
|---|---|
| `--purple50` | `rgba(119,110,203,0.08)` |
| `--purple200` | `#CBC3F8` |
| `--purple300` | `#A9A1E6` ← theme |
| `--purple400` | `#AEA4FF` |
| `--purple600` | `#786ECB` |
| `--purple700` | `#4C41A9` |
| `--fw-purple` | `#6D5EB7` |

## Ink / dark indigo

| Token | Value | Notes |
|---|---|---|
| `--exc-ink` | `#302951` | dark ink purple, heavily used for text |
| `--w0` | `#1D1A3B` | darkest indigo, dark-surface base |
| `--exc-muted` | `rgba(48,41,81,0.5)` | muted text |
| `--exc-line` | `rgba(48,41,81,0.06)` | hairlines |

## Indigo-tinted neutral scale (`w`)

`--w50 #F9F9FB · --w100 #EEEEF7 · --w200 #E2E2F1 · --w300 #C8C8E3 · --w400 #D9D5F1 · --w500 #7D7993 · --w600 #716B8D · --w700 #4D4878 · --w800 #312A52 · --w900 #201B38`

## Accent pinks

- `--pink500 #D38AFF`, `--pink600 #B350F0`

## Semantic

- Green (success): `#107C41` / `#00892B`
- Red (error): `#DC2626` / `#FF2116`
- Blue: `--blue600 #185ABD`

## Background (light)

- `--bg: oklch(99.55% 0.0026 297.32)` (near-white with a faint violet cast), `--bg100`, `--bg200` slightly darker.

## Fonts (for reference, not TUI-applicable)

- System: Inter; Custom: Manrope; Mono: **Geist Mono**.

## TUI mapping suggestion (truecolor ANSI)

Terminals have a dark or light background we don't control; the theme applies to *foreground* accents:

- Primary accent / spinner / `✻` glyph: `#A9A1E6` (purple300)
- Active emphasis (evidence `◆`, selected items): `#AEA4FF` (purple400) or `#CBC3F8` (purple200) on dark terminals
- Secondary/muted text (metadata line `↳ 12.4k tokens · 18s`): `#7D7993` (w500)
- Tool-activity `●` lines: `#786ECB` (purple600)
- Success/completion `✓`: `#00892B` or keep purple with `✻`
- Errors: `#DC2626`
- Fall back to nearest ANSI-256 colors when truecolor is unavailable (Ink/chalk handles downsampling automatically).
