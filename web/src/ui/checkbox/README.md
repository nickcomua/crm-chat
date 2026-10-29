# Checkbox

Button with `role="checkbox"`. The parent owns `isChecked`. `onToggle` receives the next boolean. Space and Enter toggle and call `preventDefault` so the key does not also activate the button. Indeterminate renders `aria-checked="mixed"` and the next toggle is checked. Disabled uses the native `disabled` attribute. Read-only keeps focus, sets `aria-readonly`, and does not toggle.

```ts
import { demo, view } from './checkbox'

view(
  {
    id: 'accept-terms',
    label: 'Accept terms',
    isChecked: model.accepted,
    name: 'terms',
    onToggle: isChecked => Message.ToggledAccepted({ isChecked }),
  },
  h,
)

const program = demo()
```

When `name` is set and the box is checked, a hidden input submits `value` (default `on`).
