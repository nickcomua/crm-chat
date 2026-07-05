# CRM Chat UI Contract

## Product Surface

CRM Chat is an operational messaging workspace. Screens optimize for scan speed, repeated use, and dense contact context rather than marketing impact.

## Layout

Primary work areas use full-height flex layouts with bordered headers, compact tabs, and scrollable content regions. Side sheets are reserved for contact detail management and should keep controls stacked with narrow spacing.

## Components

Use existing `ui/*` primitives for buttons, inputs, textareas, badges, tabs, sheets, dropdowns, and separators. Use Lucide icons for compact actions and status affordances.

## Density

Contact-management UI should use small headings, `text-xs` metadata, stable row heights where practical, and un-nested cards. Repeated items may use a single border/background surface with radius `8px` or less.

## States

Empty states are concise and local to the panel. Loading states use the existing small spinning border or Lucide loader pattern. Destructive actions use ghost/icon affordances unless they are primary workflow steps.

## Accessibility

Icon-only controls need `aria-label`. Form controls need labels. Interactive rows must use buttons, not clickable divs.
