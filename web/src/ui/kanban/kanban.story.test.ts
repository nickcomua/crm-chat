import * as Option from 'effect/Option'
import * as DragAndDrop from '@foldkit/ui/dragAndDrop'
import { given, message, model, story } from 'foldkit/story'
import { expect, test } from 'vitest'

import { type CaseCard, Message, init, update } from './kanban'

const pipeline: ReadonlyArray<CaseCard> = [
  {
    id: 'case-a',
    title: 'Alpha',
    summary: 'First',
    status: 'New',
  },
  {
    id: 'case-b',
    title: 'Beta',
    summary: 'Second',
    status: 'New',
  },
  {
    id: 'case-c',
    title: 'Gamma',
    summary: 'Third',
    status: 'Active',
  },
]

const got = (child: DragAndDrop.Message) =>
  Message.GotDragAndDropMessage({ message: child })

test('pointer drag reorders a case inside its status column', () => {
  story(
    update,
    given(init({ cases: pipeline }).model),
    message(
      got(
        DragAndDrop.Message.PressedDraggable({
          itemId: 'case-a',
          containerId: 'New',
          index: 0,
          screenX: 0,
          screenY: 0,
        }),
      ),
    ),
    message(
      got(
        DragAndDrop.Message.MovedPointer({
          screenX: 0,
          screenY: 24,
          clientX: 0,
          clientY: 24,
          maybeDropTarget: Option.some({ containerId: 'New', index: 2 }),
        }),
      ),
    ),
    model(current => {
      expect(current.announcement).toBe('Dragging Alpha.')
    }),
    message(got(DragAndDrop.Message.ReleasedPointer())),
    model(current => {
      expect(current.cases.map(caseCard => caseCard.id)).toEqual([
        'case-b',
        'case-a',
        'case-c',
      ])
      expect(current.cases[1]?.status).toBe('New')
      expect(current.announcement).toBe('Moved Alpha to New, slot 2.')
    }),
  )
})

test('pointer drag moves a case into another status', () => {
  story(
    update,
    given(init({ cases: pipeline }).model),
    message(
      got(
        DragAndDrop.Message.PressedDraggable({
          itemId: 'case-a',
          containerId: 'New',
          index: 0,
          screenX: 0,
          screenY: 0,
        }),
      ),
    ),
    message(
      got(
        DragAndDrop.Message.MovedPointer({
          screenX: 40,
          screenY: 0,
          clientX: 40,
          clientY: 0,
          maybeDropTarget: Option.some({ containerId: 'Active', index: 1 }),
        }),
      ),
    ),
    message(got(DragAndDrop.Message.ReleasedPointer())),
    model(current => {
      const alpha = current.cases.find(caseCard => caseCard.id === 'case-a')
      expect(alpha?.status).toBe('Active')
      expect(
        current.cases
          .filter(caseCard => caseCard.status === 'Active')
          .map(caseCard => caseCard.id),
      ).toEqual(['case-c', 'case-a'])
      expect(current.announcement).toBe('Moved Alpha to Active, slot 2.')
    }),
  )
})

test('keyboard drag moves between columns and can be cancelled', () => {
  const started = init({ cases: pipeline }).model
  story(
    update,
    given(started),
    message(
      got(
        DragAndDrop.Message.ActivatedKeyboardDrag({
          itemId: 'case-b',
          containerId: 'New',
          index: 1,
        }),
      ),
    ),
    model(current => {
      expect(current.announcement).toContain('Picked up Beta')
      expect(current.announcement).toContain('Escape cancels')
    }),
    message(
      got(DragAndDrop.Message.PressedArrowKey({ direction: 'NextContainer' })),
    ),
    DragAndDrop.test.resolveKeyboardMove({
      itemId: 'case-b',
      targetContainerId: 'Active',
      targetIndex: 0,
    }),
    model(current => {
      expect(current.announcement).toBe('Beta over Active, slot 1.')
      expect(current.cases.find(caseCard => caseCard.id === 'case-b')?.status).toBe(
        'New',
      )
    }),
    message(got(DragAndDrop.Message.ConfirmedKeyboardDrop())),
    DragAndDrop.test.settleFocus({ itemId: 'case-b' }),
    model(current => {
      expect(current.cases.find(caseCard => caseCard.id === 'case-b')?.status).toBe(
        'Active',
      )
      expect(current.announcement).toBe('Moved Beta to Active, slot 1.')
    }),
  )

  story(
    update,
    given(started),
    message(
      got(
        DragAndDrop.Message.ActivatedKeyboardDrag({
          itemId: 'case-b',
          containerId: 'New',
          index: 1,
        }),
      ),
    ),
    message(got(DragAndDrop.Message.CancelledDrag())),
    DragAndDrop.test.settleFocus({ itemId: 'case-b' }),
    model(current => {
      expect(current.announcement).toBe('Cancelled moving Beta.')
      expect(current.cases.find(caseCard => caseCard.id === 'case-b')?.status).toBe(
        'New',
      )
    }),
  )
})

test('keyboard drag reorders within a column', () => {
  story(
    update,
    given(init({ cases: pipeline }).model),
    message(
      got(
        DragAndDrop.Message.ActivatedKeyboardDrag({
          itemId: 'case-a',
          containerId: 'New',
          index: 0,
        }),
      ),
    ),
    message(got(DragAndDrop.Message.PressedArrowKey({ direction: 'Down' }))),
    DragAndDrop.test.resolveKeyboardMove({
      itemId: 'case-a',
      targetContainerId: 'New',
      targetIndex: 1,
    }),
    message(got(DragAndDrop.Message.ConfirmedKeyboardDrop())),
    DragAndDrop.test.settleFocus({ itemId: 'case-a' }),
    model(current => {
      expect(
        current.cases
          .filter(caseCard => caseCard.status === 'New')
          .map(caseCard => caseCard.id),
      ).toEqual(['case-b', 'case-a'])
      expect(current.announcement).toBe('Moved Alpha to New, slot 2.')
    }),
  )
})
