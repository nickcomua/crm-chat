# Card

Stateless shadcn-style card for Foldkit. Sections are `view`, `header`, `title`, `description`, `action`, `content`, and `footer`. Pass the Foldkit `HtmlBuilder` last.

Styles live in `card.css` (imported by `card.ts`). Tokens use shadcn names (`--card`, `--primary`, `--muted`, `--border`, `--ring`, `--radius`) and Telegram Web K colors. `--primary` is `#3390ec`. Add `dark`, `night`, or `data-theme="dark"` on an ancestor for the dark palette.

```ts
import { action, content, description, footer, header, title, view } from './card'

view(
  { label: 'Billing question' },
  [
    header({}, [title({}, ['Billing question'], h), description({}, ['Ada asked about invoice 1042.'], h)], h),
    content({}, ['Opened from the saved chat.'], h),
    footer({}, ['New'], h),
  ],
  h,
)
```

`demo(h)` renders the sample. `demoInit`, `demoUpdate`, and `demoView` are the interactive Foldkit program (the Note button sets the footer to Noted).
