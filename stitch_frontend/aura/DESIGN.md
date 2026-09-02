---
name: AURA
colors:
  surface: '#10131a'
  surface-dim: '#10131a'
  surface-bright: '#363941'
  surface-container-lowest: '#0b0e15'
  surface-container-low: '#191b23'
  surface-container: '#1d2027'
  surface-container-high: '#272a31'
  surface-container-highest: '#32353c'
  on-surface: '#e1e2ec'
  on-surface-variant: '#c2c6d6'
  inverse-surface: '#e1e2ec'
  inverse-on-surface: '#2e3038'
  outline: '#8c909f'
  outline-variant: '#424754'
  surface-tint: '#adc6ff'
  primary: '#adc6ff'
  on-primary: '#002e6a'
  primary-container: '#4d8eff'
  on-primary-container: '#00285d'
  inverse-primary: '#005ac2'
  secondary: '#4edea3'
  on-secondary: '#003824'
  secondary-container: '#00a572'
  on-secondary-container: '#00311f'
  tertiary: '#ffb786'
  on-tertiary: '#502400'
  tertiary-container: '#df7412'
  on-tertiary-container: '#461f00'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#d8e2ff'
  primary-fixed-dim: '#adc6ff'
  on-primary-fixed: '#001a42'
  on-primary-fixed-variant: '#004395'
  secondary-fixed: '#6ffbbe'
  secondary-fixed-dim: '#4edea3'
  on-secondary-fixed: '#002113'
  on-secondary-fixed-variant: '#005236'
  tertiary-fixed: '#ffdcc6'
  tertiary-fixed-dim: '#ffb786'
  on-tertiary-fixed: '#311400'
  on-tertiary-fixed-variant: '#723600'
  background: '#10131a'
  on-background: '#e1e2ec'
  surface-variant: '#32353c'
typography:
  display-lg:
    fontFamily: Inter
    fontSize: 32px
    fontWeight: '600'
    lineHeight: 40px
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 28px
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  body-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
  label-caps:
    fontFamily: Inter
    fontSize: 10px
    fontWeight: '700'
    lineHeight: 12px
    letterSpacing: 0.05em
  data-mono:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: '500'
    lineHeight: 16px
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  unit: 4px
  container-padding: 1.5rem
  gutter: 1rem
  component-gap: 0.5rem
  sidebar-width: 280px
---

## Brand & Style

The design system is engineered for high-stakes, real-time transportation intelligence. The brand personality is authoritative, calm, and hyper-efficient, prioritizing cognitive clarity over decorative flair. It targets infrastructure operators and logistics engineers who require a "God-view" of complex networks.

The visual style is **Corporate / Modern** with a lean toward **Minimalism**. It avoids the tropes of "sci-fi" interfaces in favor of a sophisticated command dashboard aesthetic. Every pixel must justify its existence; whitespace is used strategically to group related data streams, while subtle borders provide structure without visual noise. The emotional response is one of total control and algorithmic reliability.

## Colors

The palette is anchored in a deep, non-reflective slate to minimize eye strain during long shifts in low-light control rooms. 

- **Core Neutrals:** The background uses a charcoal base (#0B0E14) with surfaces tiered using slightly lighter shades (#161B22) to indicate hierarchy.
- **Functional Color:** Color is reserved strictly for status and data visualization. 
    - **Blue (#3B82F6):** Used for active routes, primary navigation, and informational highlights.
    - **Green (#10B981):** Signals healthy flow and active systems.
    - **Amber (#F59E0B):** Indicates congestion or degraded performance.
    - **Red (#EF4444):** Reserved for system failures or complete stoppages.
- **Accents:** Borders use a low-contrast gray (#30363D) to define containers without creating a "boxed-in" feeling.

## Typography

This design system utilizes **Inter** for its exceptional legibility at small sizes and high-density environments. For technical telemetry and coordinate data, **JetBrains Mono** is introduced to ensure character distinction (e.g., distinguishing '0' from 'O').

- **Scale:** Typographic hierarchy is tight. We prioritize data density over large headers. 
- **Formatting:** Use `label-caps` for table headers and section metadata to distinguish them from actionable data.
- **Mobile:** On mobile views, `display-lg` scales down to `24px` to maintain screen real estate for map-based interfaces.

## Layout & Spacing

The layout follows a **Fixed-Fluid Hybrid** model. Navigation and telemetry sidebars are fixed-width to ensure tool consistency, while the central viewport (typically a map or network graph) is fluid.

- **Grid:** A 12-column system is used for dashboard layouts, but individual modules inside sidebars utilize a 4px base-unit spacing for micro-adjustments.
- **Density:** High. Margins between data points are kept to a minimum (8px to 12px) to allow for maximum information visibility without scrolling.
- **Breakpoints:** 
    - **Desktop (1440px+):** Full 3-column view (Nav + Map + Telemetry).
    - **Tablet (768px - 1439px):** Collapsible sidebars; focus on map.
    - **Mobile (Below 768px):** Single column; bottom-sheet based data overlays.

## Elevation & Depth

Depth is conveyed through **Tonal Layers** and **Low-Contrast Outlines** rather than traditional shadows. 

- **Z-Axis:** The map is the lowest layer (z-0). Control panels and cards sit at z-1, distinguished by their #161B22 surface color and #30363D border.
- **Modals:** High-priority alerts use a slight ambient glow of the primary color (Blue) or semantic color (Red/Amber) to draw immediate attention, but standard overlays use a 40% opacity black backdrop blur to maintain context of the underlying network.
- **Interactive States:** Hovering over a card or list item should subtly brighten the background (from #161B22 to #1C2128) rather than lifting it with a shadow.

## Shapes

The shape language is disciplined and geometric. 

- **Primary Radius:** A consistent 8px (`rounded-lg`) is used for cards, input fields, and containers. This provides a modern, professional feel without the playfulness of fully rounded "pill" shapes.
- **Small Elements:** Tooltips and tags use a 4px (`rounded-md`) radius.
- **Icons:** Use linear, 2px stroke icons with square terminals to match the professional tone. Avoid rounded or filled icon sets.

## Components

- **Buttons:** Primary buttons are solid Blue (#3B82F6) with white text. Secondary buttons are outlined with #30363D. Use "Compact" sizing (32px height) by default.
- **Data Cards:** Containers with a 1px border (#30363D). Headers should include a small leading icon and the `label-caps` typography style.
- **Status Chips:** Small, non-intrusive indicators. Use a "Dot + Label" pattern (e.g., a 6px green circle next to "System Active").
- **Inputs:** Dark backgrounds (#0B0E14) with a 1px border. Focus state should change the border color to Blue (#3B82F6) with no outer glow.
- **Network Map:** The core component. Routes are 2px lines. Active traffic should be indicated by animated directional pulses in the semantic color representing the flow speed.
- **Telemetry Lists:** Monospaced data tables with zebra-striping (alternate #161B22 and #11161D) for high readability of complex numerical rows.