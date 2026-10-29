# Form field

Label, control, optional description, and error text. `error` is an `Option`: `Some` sets `data-invalid`, `aria-invalid`, and `aria-describedby` (description id, then error id). The error paragraph is `role="alert"`.

```ts
import * as Option from 'effect/Option'
import { demo, view } from './formField'
import { view as inputView } from '../input/input'

view(
  {
    id: 'display-name',
    label: 'Display name',
    description: 'Shown on your profile',
    error: model.error,
    control: field =>
      inputView(
        {
          id: field.id,
          value: model.value,
          isInvalid: field.isInvalid,
          onInput: value => Message.UpdatedName({ value }),
          ...(Option.isSome(field.describedBy)
            ? { describedBy: field.describedBy.value }
            : {}),
          ...(field.isInvalid ? { errorId: field.errorId } : {}),
        },
        h,
      ),
  },
  h,
)

const program = demo()
```

`control` runs during `view` and must build its element with the same `h`.
