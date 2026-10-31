# Kanban

Case pipeline board. Columns are the case statuses `New`, `Active`, `Waiting`, and `Done`. Each case is a Card. Pointer, touch, and keyboard drags reorder a case inside a column or move it to another status.

Drag-and-drop comes from `@foldkit/ui/dragAndDrop` (pointer threshold, touch via `touch-action: none`, and a keyboard drag). Space or Enter picks up the focused case. Arrow up and arrow down move inside the column. Tab and shift tab move across columns. Enter drops. Escape cancels. A polite live region announces pickup, the current slot, the drop, and cancellation.

`kanban.css` uses the same shadcn tokens as Card (`--background`, `--foreground`, `--primary`, `--muted`, `--border`, `--ring`, `--radius`). `--primary` is Telegram blue `#3390ec`. Dark theme: `dark`, `night`, or `data-theme="dark"` on an ancestor.

```ts
import { demo, init, subscriptions, update, view } from './kanban'

const started = init({
  id: 'case-pipeline',
  cases: [
    { id: 'case-ada', title: 'Ada · billing', summary: 'Invoice 1042 does not match the chat.', status: 'New' },
  ],
})

// Gallery snapshot:
demo(h)

// Interactive program: init, update, view, subscriptions.
// OutMessage.MovedCase reports a real status or order change.
```

Mount `subscriptions` with the page subscriptions (`Subscription.aggregate`) so pointer-move, touch-end, and keyboard events reach the board while a drag is active.
