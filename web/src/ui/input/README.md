# Input

Controlled text field. The parent owns `value` and handles `onInput`.

```ts
import { demo, view } from './input'

view(
  {
    id: 'display-name',
    value: model.name,
    placeholder: 'Your name',
    isInvalid: true,
    describedBy: 'display-name-error',
    errorId: 'display-name-error',
    onInput: value => Message.UpdatedName({ value }),
  },
  h,
)

const program = demo()
```

`type` is `text`, `password`, `email`, `tel`, `url`, `search`, or `number`. Disabled and read-only inputs stay associated with their label. Focus uses `--ring` (`#3390ec`). Invalid fields use `--destructive`.
