# Label

Associates visible text with a control. Pass `htmlFor` as the control id. Set `isDisabled` when the control cannot be used so the label picks up `data-disabled`.

```ts
import { demo, view } from './label'

view({ htmlFor: 'display-name', text: 'Display name' }, h)

const program = demo()
```

Colors come from shadcn-style variables (`--foreground`, `--muted-foreground`) with Telegram Web K defaults. Put `class="dark"` on an ancestor for the dark palette. Accent is `#3390ec`.
