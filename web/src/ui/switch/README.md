# Switch

Button with `role="switch"` and `aria-checked`. Space and Enter toggle. The parent owns `isChecked` and receives the next value from `onToggle`. The thumb slides to the Telegram blue (`--primary`, `#3390ec`) track. Reduced motion drops the thumb transition.

```ts
import { demo, view } from './switch'

view(
  {
    id: 'notifications',
    label: 'Notifications',
    isChecked: model.notifications,
    name: 'notifications',
    onToggle: isChecked => Message.ToggledNotifications({ isChecked }),
  },
  h,
)

const program = demo()
```

Disabled removes the switch from the tab order. Read-only stays focusable and ignores Space and Enter.
