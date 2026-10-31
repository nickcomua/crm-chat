import * as Option from 'effect/Option'
import * as DragAndDrop from '@foldkit/ui/dragAndDrop'
import {
  Command,
  Subscription,
  all,
  expect,
  expectAll,
  given,
  keydown,
  pointerDown,
  role,
  scene,
} from 'foldkit/scene'
import { test } from 'vitest'

import { Message, init, update, view } from './kanban'

const got = (child: DragAndDrop.Message) =>
  Message.GotDragAndDropMessage({ message: child })

test('board exposes status columns, draggable cases, and a live region', () => {
  scene(
    { update, view },
    given(init().model),
    expect(role('region', { name: 'Case pipeline' })).toExist(),
    expect(role('listbox', { name: 'New' })).toExist(),
    expect(role('listbox', { name: 'Active' })).toExist(),
    expect(role('listbox', { name: 'Waiting' })).toExist(),
    expect(role('listbox', { name: 'Done' })).toExist(),
    expectAll(all.role('option')).toHaveCount(4),
    expect(role('option', { name: 'Ada · billing' })).toHaveAttr(
      'aria-roledescription',
      'draggable',
    ),
    expect(role('option', { name: 'Ada · billing' })).toHaveAttr(
      'aria-grabbed',
      'false',
    ),
    expect(role('option', { name: 'Ada · billing' })).toHaveAccessibleDescription(
      /Space or Enter/,
    ),
    expect(role('status')).toExist(),
  )
})

test('keyboard pickup, move, and drop announce the new status', () => {
  scene(
    { update, view },
    given(init().model),
    keydown(role('option', { name: 'Ada · billing' }), ' '),
    expect(role('option', { name: 'Ada · billing' })).toHaveAttr(
      'aria-grabbed',
      'true',
    ),
    expect(role('status')).toContainText('Picked up Ada · billing'),
    Subscription.emit(
      got(DragAndDrop.Message.PressedArrowKey({ direction: 'NextContainer' })),
    ),
    Command.resolve(
      DragAndDrop.ResolveKeyboardMove,
      DragAndDrop.Message.CompletedResolveKeyboardMove({
        targetContainerId: 'Active',
        targetIndex: 0,
      }),
    ),
    Command.resolve(
      DragAndDrop.FocusItem,
      DragAndDrop.Message.CompletedFocusItem(),
    ),
    expect(role('status')).toContainText('Ada · billing over Active'),
    Subscription.emit(got(DragAndDrop.Message.ConfirmedKeyboardDrop())),
    Command.resolve(
      DragAndDrop.FocusItem,
      DragAndDrop.Message.CompletedFocusItem(),
    ),
    expect(role('status')).toHaveText('Moved Ada · billing to Active, slot 1.'),
    expect(role('listbox', { name: 'Active' })).toContainText('Ada · billing'),
    expect(role('listbox', { name: 'New' })).not.toContainText('Ada · billing'),
  )
})

test('touch drag moves a case between columns', () => {
  scene(
    { update, view },
    given(init().model),
    pointerDown(role('option', { name: 'Lin · onboarding' }), {
      pointerType: 'touch',
      button: 0,
      screenX: 0,
      screenY: 0,
    }),
    Subscription.emit(
      got(
        DragAndDrop.Message.MovedPointer({
          screenX: 0,
          screenY: 20,
          clientX: 12,
          clientY: 20,
          maybeDropTarget: Option.some({ containerId: 'Done', index: 1 }),
        }),
      ),
    ),
    expect(role('status')).toContainText('Dragging Lin · onboarding'),
    Subscription.emit(got(DragAndDrop.Message.ReleasedPointer())),
    expect(role('status')).toHaveText(
      'Moved Lin · onboarding to Done, slot 2.',
    ),
    expect(role('listbox', { name: 'Done' })).toContainText('Lin · onboarding'),
  )
})

test('mouse drag reorders within a column when two cases share a status', () => {
  scene(
    { update, view },
    given(
      init({
        cases: [
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
        ],
      }).model,
    ),
    pointerDown(role('option', { name: 'Alpha' }), {
      pointerType: 'mouse',
      button: 0,
      screenX: 0,
      screenY: 0,
    }),
    Subscription.emit(
      got(
        DragAndDrop.Message.MovedPointer({
          screenX: 0,
          screenY: 30,
          clientX: 0,
          clientY: 30,
          maybeDropTarget: Option.some({ containerId: 'New', index: 2 }),
        }),
      ),
    ),
    Subscription.emit(got(DragAndDrop.Message.ReleasedPointer())),
    expect(role('status')).toHaveText('Moved Alpha to New, slot 2.'),
    expect(role('listbox', { name: 'New' })).toContainText('Beta'),
  )
})

test('escape cancels a keyboard drag and announces it', () => {
  scene(
    { update, view },
    given(init().model),
    keydown(role('option', { name: 'Sam · access' }), 'Enter'),
    expect(role('status')).toContainText('Picked up Sam · access'),
    Subscription.emit(got(DragAndDrop.Message.CancelledDrag())),
    Command.resolve(
      DragAndDrop.FocusItem,
      DragAndDrop.Message.CompletedFocusItem(),
    ),
    expect(role('status')).toHaveText('Cancelled moving Sam · access.'),
    expect(role('listbox', { name: 'Waiting' })).toContainText('Sam · access'),
    expect(role('option', { name: 'Sam · access' })).toHaveAttr(
      'aria-grabbed',
      'false',
    ),
  )
})
