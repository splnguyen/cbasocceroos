# Design System

## Output specs

| Property | Value |
|---|---|
| Output resolution | **1080 × 1920** (portrait) |
| Figma design scale | **2×** (designed at 2160 × 3840) |
| Font family | CBABeaconSans (weights 400/700/800/900) |

## The 2× rule

**Every value pulled from Figma must be divided by 2 for CSS px.**

Examples:
- Figma `300px` score number → CSS `150px`
- Figma `48px` H3 label → CSS `24px`
- Figma `82px` possession bar height → CSS `41px`

This applies to: font sizes, line heights, padding, margin, width, height, border-radius, gap — everything.

## Figma source

- **File key:** `eBWaSO7mwm2Ja5NiEFDHAo`
- **Page:** 2026 Mens World Cup – Schematics
- **Access:** Figma MCP via `Figma:get_design_context`

To use Figma MCP tools in Claude Code, call `tool_search` first to load them.

## Design tokens

Tokens live in `css/tokens.css`. Always reference tokens, never hardcoded hex values.

### Key colours

| Token | Value | Use |
|---|---|---|
| `--dark-grey` | `#727272` | Wide vertical separators in centre column |
| `--purple-bright` | `#6951ff` | Away team accent (possession bar, etc.) |

## Typography

Lives in `css/typography.css`. Fonts are embedded as **base64** to eliminate FOUT/FOIT on first paint — critical for broadcast displays where any flicker is visible.

Weights available:
- 400 (regular)
- 700 (bold)
- 800 (extrabold)
- 900 (black)

## Matchlive screen — current spec

The matchlive screen (Figma node `2016:3326`) recently changed:

- **Meta dividers:** thick white bars `h-16px` (was 3px thin lines)
- **Centre column separators:** wide solid grey rectangles `20×165px`, bg `--dark-grey` (was thin vertical lines)
- **POSSESSION:** H3 24px label above bar; bar height **41px** (much taller than old 12px); percentages 30px; away colour `--purple-bright`
- **Stat cards:** H6 12px label, 42px values, home left-aligned + away right-aligned via `justify-between`
- **Events feed:** minute col 110px wide, player col 216px, top line 30px ExtraBold, desc 24px Bold 700; tracking 1.5px on top, 1.2px on desc; desc indent matches minute width

### Compression decisions (to fit 1920px)

At full Figma scale the matchlive screen is ~2057px tall — overflows portrait by 137px. Compressions made:

| Element | Figma | Built |
|---|---|---|
| Section gap | 79px | 40px |
| Score numbers | 300px | 240px |
| Flag circles | 150px | 120px |
| Possession bar | 82px | 50px |

Feed card flex-grows into the remaining ~606px. All typography otherwise matches Figma exactly.
