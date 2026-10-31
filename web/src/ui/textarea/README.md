# Textarea

Controlled multiline field that grows with its text. A grid mirror (`data-value` on `.ui-textarea-grow`, including a trailing newline) sets the height, and the textarea caps at `12rem` then scrolls. `resize` stays off so the keyboard layout does not jump.

```ts
import { demo, view } from './textarea'

view(
  {
    id: 'message',
    value: model.message,
    placeholder: 'Write a message',
    onInput: value => Message.UpdatedMessage({ value }),
  },
  h,
)

const program = demo()
```

Pair it with `Label` (`htmlFor` = the textarea id) or pass `ariaLabel`. Invalid, disabled, and read-only flags match `Input`.
