# Ableton RC Suite — Visual Design System Contract (THEME_CONTRACT.md)

## 1. Overview & Aesthetics Policy
The Ableton RC Suite enforces a cohesive, premium Dark Glassmorphism design system tailored for live performance environments and studio controls. Default themes prioritize high-contrast legibility in low-light environments, smooth 60fps CSS transitions, zero unstyled Flash of Unstyled Content (FOUC), and responsive layouts for mobile, tablet, and desktop interfaces.

---

## 2. Color Palette & Design Tokens

| Token | Hex / HSL | Application |
|---|---|---|
| `--bg-base` | `#0d0f12` | Main page background |
| `--bg-surface` | `rgba(22, 26, 33, 0.85)` | Cards, panels, modal dialogs |
| `--bg-surface-elevated` | `rgba(32, 38, 48, 0.90)` | Dropdowns, tooltips, active overlays |
| `--border-subtle` | `rgba(255, 255, 255, 0.08)` | Outer component borders, dividers |
| `--border-focus` | `#ff7700` (Ableton Amber) | Focus rings, active mapping targets |
| `--text-primary` | `#f0f3f7` | Headings, primary labels |
| `--text-secondary` | `#94a3b8` | Subtitles, metadata, inactive labels |
| `--accent-amber` | `#ff7700` | Primary Ableton brand accent |
| `--accent-cyan` | `#00d2ff` | Modulators, LFO, active sync indicators |
| `--accent-green` | `#00e676` | Playhead active, track arm, success state |
| `--accent-red` | `#ff5252` | Track mute, panic mode, destructive actions |

---

## 3. Typography
- **Primary Font Family**: `'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`
- **Monospace Font Family**: `'JetBrains Mono', 'Fira Code', Consolas, monospace` (for timecode, BPM, locators, JSON)
- **Font Scale**:
  - Heading 1: `1.5rem / 600 weight`
  - Heading 2: `1.25rem / 600 weight`
  - Body / Controls: `0.875rem / 400-500 weight`
  - Captions / Metadata: `0.75rem / 400 weight`

---

## 4. Glassmorphism & Micro-animations
- `backdrop-filter: blur(12px) saturate(180%)` for floating overlays.
- Transition duration: `150ms cubic-bezier(0.4, 0, 0.2, 1)` for interactive states (`hover`, `active`, `focus`).
- Touch target minimum: `44px x 44px` for phone UI elements to guarantee live performance reliability.
