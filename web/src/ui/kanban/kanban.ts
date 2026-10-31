import * as Array from 'effect/Array'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as DragAndDrop from '@foldkit/ui/dragAndDrop'
import { Subscription, Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import {
  view as cardView,
  content,
  description,
  footer,
  header,
  title,
} from '../card/card'

import './kanban.css'

// MODEL
export const CaseStatus = Schema.Literals([
  'New',
  'Active',
  'Waiting',
  'Done',
])
export type CaseStatus = typeof CaseStatus.Type

export const caseStatuses: ReadonlyArray<CaseStatus> = [
  'New',
  'Active',
  'Waiting',
  'Done',
]

const CaseCard = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  summary: Schema.String,
  status: CaseStatus,
})
export type CaseCard = typeof CaseCard.Type

const DropIndexSpace = Schema.Literals(['Pointer', 'Keyboard', 'None'])
type DropIndexSpace = typeof DropIndexSpace.Type

const isCaseStatus = Schema.is(CaseStatus)

export const Model = Schema.Struct({
  cases: Schema.Array(CaseCard),
  statuses: Schema.Array(CaseStatus),
  drag: DragAndDrop.Model,
  announcement: Schema.String,
  dropIndexSpace: DropIndexSpace,
  maybeGrabbedCaseId: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type

// MESSAGE
export const Message = defineMessageUnion({
  GotDragAndDropMessage: { message: DragAndDrop.Message },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
  MovedCase: {
    caseId: Schema.String,
    fromStatus: CaseStatus,
    toStatus: CaseStatus,
    toIndex: Schema.Number,
  },
})
export type OutMessage = typeof OutMessage.Type

export type InitConfig = Readonly<{
  id?: string
  cases?: ReadonlyArray<CaseCard>
}>

const demoCases: ReadonlyArray<CaseCard> = [
  {
    id: 'case-ada',
    title: 'Ada · billing',
    summary: 'Invoice 1042 does not match the chat.',
    status: 'New',
  },
  {
    id: 'case-lin',
    title: 'Lin · onboarding',
    summary: 'Waiting for the workspace name.',
    status: 'Active',
  },
  {
    id: 'case-sam',
    title: 'Sam · access',
    summary: 'Asked a manager to approve the invite.',
    status: 'Waiting',
  },
  {
    id: 'case-noor',
    title: 'Noor · welcome',
    summary: 'Sent the channel links.',
    status: 'Done',
  },
]

const columnCases = (
  cases: ReadonlyArray<CaseCard>,
  status: CaseStatus,
): ReadonlyArray<CaseCard> => cases.filter(caseCard => caseCard.status === status)

const titleFor = (cases: ReadonlyArray<CaseCard>, caseId: string): string =>
  Option.match(
    Array.findFirst(cases, caseCard => caseCard.id === caseId),
    {
      onNone: () => 'Case',
      onSome: caseCard => caseCard.title,
    },
  )

const replaceColumn = (
  cases: ReadonlyArray<CaseCard>,
  statuses: ReadonlyArray<CaseStatus>,
  status: CaseStatus,
  nextColumn: ReadonlyArray<CaseCard>,
): ReadonlyArray<CaseCard> =>
  Array.flatMap(statuses, columnStatus =>
    columnStatus === status ? nextColumn : columnCases(cases, columnStatus),
  )

const insertCase = (
  items: ReadonlyArray<CaseCard>,
  index: number,
  item: CaseCard,
): ReadonlyArray<CaseCard> => {
  const bounded = Math.min(Math.max(index, 0), items.length)
  return Option.getOrElse(Array.insertAt(items, bounded, item), () => items)
}

// NOTE: Pointer drop indexes still count the dragged case. Keyboard indexes
// count the column with that case already removed.
const insertionIndex = (
  space: DropIndexSpace,
  fromIndex: number,
  toIndex: number,
  sameColumn: boolean,
): number => {
  if (sameColumn && space === 'Pointer' && toIndex > fromIndex) {
    return toIndex - 1
  }
  return toIndex
}

const reorderCases = (
  model: Model,
  move: typeof DragAndDrop.OutMessage.Reordered.Type,
): ReadonlyArray<CaseCard> => {
  if (!isCaseStatus(move.fromContainerId) || !isCaseStatus(move.toContainerId)) {
    return model.cases
  }
  const fromStatus = move.fromContainerId
  const toStatus = move.toContainerId
  const source = columnCases(model.cases, fromStatus)
  const item = source[move.fromIndex]
  if (item === undefined) {
    return model.cases
  }
  const moved = modifyFields(item, { status: () => toStatus })
  const removed = Array.remove(source, move.fromIndex)
  const slot = insertionIndex(
    model.dropIndexSpace,
    move.fromIndex,
    move.toIndex,
    fromStatus === toStatus,
  )
  if (fromStatus === toStatus) {
    return replaceColumn(
      model.cases,
      model.statuses,
      toStatus,
      insertCase(removed, slot, moved),
    )
  }
  const withoutSource = replaceColumn(
    model.cases,
    model.statuses,
    fromStatus,
    removed,
  )
  const destination = columnCases(withoutSource, toStatus)
  return replaceColumn(
    withoutSource,
    model.statuses,
    toStatus,
    insertCase(destination, slot, moved),
  )
}

const sameBoard = (
  left: ReadonlyArray<CaseCard>,
  right: ReadonlyArray<CaseCard>,
): boolean =>
  left.length === right.length &&
  left.every(
    (caseCard, index) =>
      caseCard.id === right[index]?.id && caseCard.status === right[index]?.status,
  )

const slotLabel = (
  cases: ReadonlyArray<CaseCard>,
  caseId: string,
  status: CaseStatus,
): string => {
  const index = Option.getOrElse(
    Array.findFirstIndex(
      columnCases(cases, status),
      caseCard => caseCard.id === caseId,
    ),
    () => 0,
  )
  return String(index + 1)
}

const dropIndexSpaceFor = (drag: DragAndDrop.Model): DropIndexSpace => {
  if (drag.dragState._tag === 'KeyboardDragging') {
    return 'Keyboard'
  }
  if (drag.dragState._tag === 'Dragging' || drag.dragState._tag === 'Pending') {
    return 'Pointer'
  }
  return 'None'
}

const rememberDropIndexSpace = (model: Model): { model: Model } => {
  if (model.drag.dragState._tag === 'Idle') {
    return { model }
  }
  const grabbed = DragAndDrop.maybeDraggedItemId(model.drag)
  return {
    model: modifyFields(model, {
      dropIndexSpace: () => dropIndexSpaceFor(model.drag),
      maybeGrabbedCaseId: () =>
        Option.match(grabbed, {
          onNone: () => model.maybeGrabbedCaseId,
          onSome: caseId => Option.some(caseId),
        }),
    }),
  }
}

const placed = (
  stepModel: Model,
  move: typeof DragAndDrop.OutMessage.Reordered.Type,
): Update.ReturnWithOutMessage<Model, Message, OutMessage> => {
  const nextCases = reorderCases(stepModel, move)
  const title = titleFor(stepModel.cases, move.itemId)
  const changed = !sameBoard(stepModel.cases, nextCases)
  const statusName = move.toContainerId
  const slot = isCaseStatus(move.toContainerId)
    ? slotLabel(nextCases, move.itemId, move.toContainerId)
    : '1'
  const announcement = changed
    ? `Moved ${title} to ${statusName}, slot ${slot}.`
    : `Left ${title} in ${statusName}.`
  const nextModel = modifyFields(stepModel, {
    cases: () => nextCases,
    announcement: () => announcement,
  })
  if (
    !changed ||
    !isCaseStatus(move.fromContainerId) ||
    !isCaseStatus(move.toContainerId)
  ) {
    return { model: nextModel }
  }
  return {
    model: nextModel,
    outMessage: OutMessage.MovedCase({
      caseId: move.itemId,
      fromStatus: move.fromContainerId,
      toStatus: move.toContainerId,
      toIndex: move.toIndex,
    }),
  }
}

const cancelled = (
  stepModel: Model,
): Update.Return<Model, Message> => ({
  model: modifyFields(stepModel, {
    announcement: () => {
      const title = Option.match(stepModel.maybeGrabbedCaseId, {
        onNone: () => 'the case',
        onSome: caseId => titleFor(stepModel.cases, caseId),
      })
      return `Cancelled moving ${title}.`
    },
  }),
})

const foldDrag = Update.foldChild({
  update: DragAndDrop.update,
  read: (model: Model) => Option.some(model.drag),
  write: (model, nextDrag) => modifyFields(model, { drag: () => nextDrag }),
  toParentMessage: message => Message.GotDragAndDropMessage({ message }),
  foldOutMessage: outMessage => stepModel =>
    DragAndDrop.OutMessage.match(outMessage, {
      Reordered: move => placed(stepModel, move),
      Cancelled: () => cancelled(stepModel),
    }),
})

const liveAnnouncement = (before: Model, after: Model): string => {
  const previous = before.drag.dragState
  const next = after.drag.dragState
  if (previous._tag !== 'KeyboardDragging' && next._tag === 'KeyboardDragging') {
    const title = titleFor(after.cases, next.itemId)
    return `Picked up ${title} from ${next.sourceContainerId}, slot ${String(next.targetIndex + 1)}. Arrow up and arrow down move within the column. Tab and shift tab move between columns. Enter drops the case. Escape cancels.`
  }
  if (
    previous._tag === 'KeyboardDragging' &&
    next._tag === 'KeyboardDragging' &&
    (previous.targetContainerId !== next.targetContainerId ||
      previous.targetIndex !== next.targetIndex)
  ) {
    const title = titleFor(after.cases, next.itemId)
    return `${title} over ${next.targetContainerId}, slot ${String(next.targetIndex + 1)}.`
  }
  if (previous._tag !== 'Dragging' && next._tag === 'Dragging') {
    return `Dragging ${titleFor(after.cases, next.itemId)}.`
  }
  return ''
}

const settleDragChrome = (before: Model) => (stepModel: Model) => {
  const announced =
    stepModel.announcement === before.announcement
      ? modifyFields(stepModel, {
          announcement: current => {
            const text = liveAnnouncement(before, stepModel)
            return text === '' ? current : text
          },
        })
      : stepModel
  if (announced.drag.dragState._tag !== 'Idle') {
    return announced
  }
  return modifyFields(announced, {
    dropIndexSpace: () => 'None',
    maybeGrabbedCaseId: () => Option.none(),
  })
}

const finish = (
  model: Model,
  folded: Update.ReturnWithOutMessage<Model, Message, OutMessage>,
): Update.ReturnWithOutMessage<Model, Message, OutMessage> => {
  if (folded.commands !== undefined && folded.outMessage !== undefined) {
    return {
      model,
      commands: folded.commands,
      outMessage: folded.outMessage,
    }
  }
  if (folded.commands !== undefined) {
    return { model, commands: folded.commands }
  }
  if (folded.outMessage !== undefined) {
    return { model, outMessage: folded.outMessage }
  }
  return { model }
}

// INIT
export const init = (config: InitConfig = {}): { model: Model } => ({
  model: {
    cases: config.cases ?? demoCases,
    statuses: caseStatuses,
    drag: DragAndDrop.init({
      id: config.id ?? 'case-pipeline',
      orientation: 'Vertical',
    }),
    announcement: '',
    dropIndexSpace: 'None',
    maybeGrabbedCaseId: Option.none(),
  },
})

// UPDATE
export const update = (
  model: Model,
  message: Message,
): Update.ReturnWithOutMessage<Model, Message, OutMessage> =>
  Message.match(message, {
    GotDragAndDropMessage: ({ message: childMessage }) => {
      const prepared = rememberDropIndexSpace(model)
      const folded = foldDrag(prepared.model, childMessage)
      return finish(settleDragChrome(model)(folded.model), folded)
    },
  })

// SUBSCRIPTION
export const subscriptions = Subscription.lift(DragAndDrop.subscriptions)<
  Model,
  Message
>({
  read: model => Option.some(model.drag),
  toParentMessage: message => Message.GotDragAndDropMessage({ message }),
})

// VIEW
const instructions =
  'Press Space or Enter to pick up a case. Arrow up and arrow down move within the column. Tab and shift tab move between columns. Enter drops the case. Escape cancels.'

const placeholder = (h: HtmlBuilder<Message>): Html =>
  h.div([h.Class('ui-kanban-placeholder'), h.AriaHidden(true)])

const emptyColumn = (h: HtmlBuilder<Message>): Html =>
  h.p([h.Class('ui-kanban-empty')], ['No cases'])

const caseCardView = (
  model: Model,
  caseCard: CaseCard,
  status: CaseStatus,
  index: number,
  h: HtmlBuilder<Message>,
): Html => {
  const dragged = DragAndDrop.maybeDraggedItemId(model.drag)
  const lifted = Option.match(dragged, {
    onNone: () => false,
    onSome: caseId => caseId === caseCard.id,
  })
  const cardClass = lifted
    ? 'ui-kanban-card ui-kanban-card-lifted'
    : 'ui-kanban-card'
  return h.keyed('div')(
    caseCard.id,
    [
      h.Class(cardClass),
      h.AriaLabel(caseCard.title),
      h.AriaDescribedBy(`${model.drag.id}-instructions`),
      h.Attribute('aria-grabbed', lifted ? 'true' : 'false'),
      ...DragAndDrop.draggable(
        {
          model: model.drag,
          toParentMessage: message => Message.GotDragAndDropMessage({ message }),
          itemId: caseCard.id,
          containerId: status,
          index,
        },
        h,
      ),
    ],
    [
      cardView(
        {},
        [
          header(
            {},
            [
              title({}, [caseCard.title], h),
              description({}, [caseCard.summary], h),
            ],
            h,
          ),
          content({}, [caseCard.summary], h),
          footer({}, [status], h),
        ],
        h,
      ),
    ],
  )
}

const columnBody = (
  model: Model,
  status: CaseStatus,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => {
  const cards = columnCases(model.cases, status)
  const placeholderAt = Option.flatMap(DragAndDrop.maybeDropTarget(model.drag), target =>
    target.containerId === status ? Option.some(target.index) : Option.none(),
  )
  const rows = Array.flatMap(cards, (caseCard, index) => {
    const before = Option.match(placeholderAt, {
      onNone: () => Array.empty<Html>(),
      onSome: slot => (slot === index ? [placeholder(h)] : Array.empty<Html>()),
    })
    return Array.append(before, caseCardView(model, caseCard, status, index, h))
  })
  const withEnd = Option.match(placeholderAt, {
    onNone: () => rows,
    onSome: slot =>
      slot >= cards.length ? Array.append(rows, placeholder(h)) : rows,
  })
  if (Array.isArrayEmpty(withEnd)) {
    return [emptyColumn(h)]
  }
  return withEnd
}

const columnView = (
  model: Model,
  status: CaseStatus,
  h: HtmlBuilder<Message>,
): Html => {
  const count = columnCases(model.cases, status).length
  return h.keyed('section')(
    status,
    [
      h.Class('ui-kanban-column'),
      ...DragAndDrop.droppable(status, status),
    ],
    [
      h.header(
        [h.Class('ui-kanban-column-header')],
        [
          h.h3([h.Class('ui-kanban-column-title')], [status]),
          h.span([h.Class('ui-kanban-count')], [String(count)]),
        ],
      ),
      ...columnBody(model, status, h),
    ],
  )
}

const ghost = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(DragAndDrop.ghostStyle(model.drag), {
    onNone: () => h.empty,
    onSome: style =>
      Option.match(DragAndDrop.maybeDraggedItemId(model.drag), {
        onNone: () => h.empty,
        onSome: caseId =>
          h.div(
            [
              h.Class('ui-kanban-ghost'),
              h.AriaHidden(true),
              h.Style(style),
            ],
            [titleFor(model.cases, caseId)],
          ),
      }),
  })

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class('ui-kanban'), h.AriaLabel('Case pipeline')],
    [
      h.h2([h.Class('ui-sr-only')], ['Case pipeline']),
      h.div(
        [h.Class('ui-kanban-columns')],
        Array.map(model.statuses, status => columnView(model, status, h)),
      ),
      ghost(model, h),
      h.div(
        [
          h.Id(`${model.drag.id}-status`),
          h.Class('ui-sr-only'),
          h.Role('status'),
          h.AriaLive('polite'),
          h.AriaAtomic(true),
        ],
        [model.announcement],
      ),
      h.p(
        [h.Id(`${model.drag.id}-instructions`), h.Class('ui-sr-only')],
        [instructions],
      ),
    ],
  )

/** Static gallery snapshot. Mount init, update, view, and subscriptions for drag and keyboard. */
export const demo = (h: HtmlBuilder<Message>): Html => view(init().model, h)
