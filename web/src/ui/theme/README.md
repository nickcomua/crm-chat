# Theme

Design tokens and a system / light / dark switcher for the crm-chat page. Tokens use shadcn/ui names and Telegram Web K day and night surfaces. The primary stays Telegram blue `#3390ec` in both themes.

Load the stylesheet once, from the page or from the gallery that mounts `demo`:

```html
<link href="/src/ui/theme/theme.css" rel="stylesheet" />
```

`demo` is the Foldkit program a gallery can mount. `switcherView` is the control on its own.

```ts
import { demo, switcherView } from './ui/theme/theme'

const theme = demo()
// Runtime.makeApplication({
//   Model: theme.Model,
//   init: theme.init,
//   update: theme.update,
//   view: theme.view,
//   subscriptions: theme.subscriptions,
//   container,
// })
```

Embed the control by folding `Model`, `update`, and `subscriptions` in the parent, then render `switcherView`. `init` reads `localStorage` key `crm-chat.theme` (`System`, `Light`, or `Dark`). The subscription listens to `(prefers-color-scheme: dark)`.

The document root receives:

- `data-preference` — `system`, `light`, or `dark`
- `data-theme` — `light` or `dark` for an explicit choice, or `system` while following the OS
- class `dark` when the resolved scheme is dark and the OS scheme is already known
- inline `color-scheme` for an explicit choice, or for system once the OS scheme is known

Until the OS scheme is known, system mode does not set `.dark` or an inline `color-scheme`. The media query in `theme.css` paints night tokens so a default of light cannot cover a dark OS.

The switcher is a `radiogroup` named Theme. Arrow keys, Home, and End move the checked option and the roving tabindex. The checked option is the only tab stop.

## shadcn token → Telegram Web K

Day and night values are from [telegram-tt `themes.json`](https://github.com/Ajaxy/telegram-tt/blob/master/src/styles/themes.json) unless the note says otherwise. Web K night sets `--color-primary` to `#8774e1`. This kit stores that at `--telegram-webk-night-primary` and keeps `--primary` / `--ring` on `#3390ec` so the page accent stays Telegram blue.

| Token                          | Light                                                 | Dark                   | Web K source                                                              |
| ------------------------------ | ----------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------- |
| `--background`                 | `#ffffff`                                             | `#212121`              | `--color-background`                                                      |
| `--foreground`                 | `#000000`                                             | `#ffffff`              | `--color-text`                                                            |
| `--card`                       | `#ffffff`                                             | `#212121`              | panel, same as background                                                 |
| `--card-foreground`            | `#000000`                                             | `#ffffff`              | `--color-text`                                                            |
| `--popover`                    | `#ffffff`                                             | `#212121`              | menu surface                                                              |
| `--popover-foreground`         | `#000000`                                             | `#ffffff`              | `--color-text`                                                            |
| `--primary`                    | `#3390ec`                                             | `#3390ec`              | day `--color-primary`. Night stays blue; Web K night primary is `#8774e1` |
| `--primary-foreground`         | `#ffffff`                                             | `#ffffff`              | text on the accent                                                        |
| `--secondary`                  | `#f4f4f5`                                             | `#0f0f0f`              | `--color-background-secondary`                                            |
| `--secondary-foreground`       | `#000000`                                             | `#ffffff`              | `--color-text`                                                            |
| `--muted`                      | `#f4f4f5`                                             | `#2c2c2c`              | day secondary; night `--color-background-selected`                        |
| `--muted-foreground`           | `#707579`                                             | `#aaaaaa`              | `--color-text-secondary`                                                  |
| `--accent`                     | `#3390ec1a`                                           | `#3390ec1a`            | `--color-primary-tint` (10% blue), the hover wash                         |
| `--accent-foreground`          | `#3390ec`                                             | `#8bc4f8`              | day accent text; night lightened blue on `#212121`                        |
| `--destructive`                | `#e53935`                                             | `#e53935`              | `$color-error`                                                            |
| `--destructive-foreground`     | `#ffffff`                                             | `#ffffff`              | text on error                                                             |
| `--border`                     | `#dadce0`                                             | `#303030`              | `--color-borders`                                                         |
| `--input`                      | `#dadce0`                                             | `#5b5b5a`              | `--color-borders-input`                                                   |
| `--ring`                       | `#3390ec`                                             | `#3390ec`              | focus, same as primary                                                    |
| `--chart-1` … `--chart-5`      | `#3390ec`, `#00c73e`, `#fb8c00`, `#8774e1`, `#eb6858` | same                   | blue, green, warning, Web K night purple, topic red                       |
| `--sidebar`                    | `#ffffff`                                             | `#212121`              | chat list panel                                                           |
| `--sidebar-foreground`         | `#000000`                                             | `#ffffff`              | `--color-text`                                                            |
| `--sidebar-primary`            | `#3390ec`                                             | `#3390ec`              | `--color-chat-active` day; night kept blue                                |
| `--sidebar-primary-foreground` | `#ffffff`                                             | `#ffffff`              | text on the active chat                                                   |
| `--sidebar-accent`             | `#f4f4f5`                                             | `#2c2c2c`              | `--color-chat-hover`                                                      |
| `--sidebar-accent-foreground`  | `#000000`                                             | `#ffffff`              | `--color-text`                                                            |
| `--sidebar-border`             | `#dadce0`                                             | `#303030`              | `--color-borders`                                                         |
| `--sidebar-ring`               | `#3390ec`                                             | `#3390ec`              | focus                                                                     |
| `--radius`                     | `0.75rem` (12px)                                      | same                   | menus and dialogs                                                         |
| `--radius-message`             | `0.9375rem` (15px)                                    | same                   | message bubbles                                                           |
| `--radius-full`                | `9999px`                                              | same                   | composer and the switcher                                                 |
| `--shadow`                     | `0 4px 16px #72727240`                                | `0 4px 16px #1010109c` | `--color-default-shadow`                                                  |
| `--shadow-xs`                  | `0 1px 2px #7272722b`                                 | `0 1px 2px #00000040`  | `--color-light-shadow`                                                    |

Telegram-only tokens:

| Token                               | Light     | Dark      | Note                                                                                                                                     |
| ----------------------------------- | --------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `--telegram-message-out`            | `#eeffde` | `#2b5278` | Day is `--color-background-own`. Night is the blue outgoing bubble, because this kit does not use Web K's purple night bubble `#766ac8`. |
| `--telegram-message-out-foreground` | `#000000` | `#ffffff` |                                                                                                                                          |
| `--telegram-message-in`             | `#ffffff` | `#212121` | Incoming bubble on the wallpaper                                                                                                         |
| `--telegram-message-in-foreground`  | `#000000` | `#ffffff` |                                                                                                                                          |
| `--telegram-wallpaper`              | `#d4ddd2` | `#0f0f0f` | Flat stand-in. Night is `--color-background-secondary`. Day Web K uses a pattern, not a flat fill.                                       |
| `--telegram-online`                 | `#00c73e` | `#00c73e` | `--color-green`                                                                                                                          |
| `--telegram-link`                   | `#3390ec` | `#3390ec` | `--color-links` day. Night links stay blue.                                                                                              |
| `--telegram-webk-night-primary`     | `#8774e1` | `#8774e1` | Recorded, not applied to `--primary`.                                                                                                    |

Typography is the Web K stack (Roboto, then the system UI fonts) at 16px body, 13px meta (`--font-size-sm`), weights 400 / 500 / 700. Spacing is a 4px grid from `--space-1` to `--space-10`.

To expose the colors as Tailwind utilities, add this to the page stylesheet that already imports Tailwind. This folder does not edit that file.

```css
@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-sidebar: var(--sidebar);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-ring: var(--sidebar-ring);
  --radius-sm: var(--radius-sm);
  --radius-md: var(--radius-md);
  --radius-lg: var(--radius);
  --radius-xl: var(--radius-xl);
}

@custom-variant dark (&:is(.dark *));
```

`font-family: var(--font-sans)` on the page body picks up the Telegram stack. `.ui-theme-demo` already sets it for the gallery.
