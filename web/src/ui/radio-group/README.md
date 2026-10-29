# Radio group

Single-choice group with a roving tabindex. Arrow keys on either axis move the selection and call `OnKeyDownFocus` so DOM focus follows the option. Home and End jump to the first and last enabled option. Disabled options are skipped. Space selects the focused option. Enter is left for a surrounding form.

Read-only groups still move focus, store that cursor on the model, and do not change the selection.

```ts
import { demo, init, update, view } from './radioGroup'

const model = init({ id: 'theme' })

view(
  model,
  {
    options,
    ariaLabel: 'Theme',
    orientation: 'Vertical',
    isDisabled: false,
    isReadOnly: false,
    name: Option.some('theme'),
  },
  h,
)

const program = demo()
```

`update` writes `selectedValue` and emits `OutMessage.Selected`. A parent that stores this model can read the selection there. `id` must be a CSS identifier; option ids are `${id}-option-${index}`.
