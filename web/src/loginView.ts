import * as Array from 'effect/Array'
import * as Redacted from 'effect/Redacted'
import { HtmlBuilder } from 'foldkit/html'

import * as Button from '@foldkit/ui/button'
import * as Input from '@foldkit/ui/input'

import { Login } from './login'
import type { Model } from './main'
import { Message } from './message'

const fieldClass =
  'w-full rounded-xl border border-white/15 bg-[#14141a] px-4 py-3 text-[16px] text-white outline-none placeholder:text-[#8d8d9a]'

const primaryClass =
  'w-full rounded-full bg-[#8774e1] px-4 py-3 text-[15px] font-medium text-white disabled:opacity-50'

const linkClass =
  'w-full rounded-full px-4 py-3 text-[13px] font-medium uppercase tracking-wide text-[#8774e1] disabled:opacity-50'

const plane =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="white" d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z"/></svg>',
  )

const logo = (h: HtmlBuilder<Message>) =>
  h.div(
    [
      h.Class(
        'flex size-24 items-center justify-center rounded-full bg-[#8774e1] shadow-lg shadow-[#8774e1]/30',
      ),
    ],
    [h.img([h.Src(plane), h.Alt(''), h.AriaHidden(true), h.Class('size-11')])],
  )

const textField = (
  model: Model,
  h: HtmlBuilder<Message>,
  field: {
    readonly id: string
    readonly label: string
    readonly value: string
    readonly placeholder: string
    readonly type?: 'password' | 'tel'
    readonly onInput: (value: string) => Message
  },
) =>
  Input.view(
    {
      id: field.id,
      onInput: field.onInput,
      isDisabled: model.status === 'Busy',
      value: field.value,
      placeholder: field.placeholder,
      ...(field.type === undefined ? {} : { type: field.type }),
      toView: attributes =>
        h.input([
          ...attributes.input,
          h.Class(fieldClass),
          h.AriaLabel(field.label),
        ]),
    },
    h,
  )

const action = (
  label: string,
  message: Message,
  disabled: boolean,
  className: string,
  h: HtmlBuilder<Message>,
) =>
  Button.view(
    {
      onClick: message,
      isDisabled: disabled,
      toView: attributes =>
        h.button([...attributes.button, h.Class(className)], [label]),
    },
    h,
  )

const suppliedApplicationNote = (h: HtmlBuilder<Message>) =>
  h.p(
    [h.Class('text-center text-[14px] text-[#b7b7c4]')],
    [
      'Application credentials are supplied for this run. They are not part of the page.',
    ],
  )

const manualApplicationFields = (model: Model, h: HtmlBuilder<Message>) =>
  h.div(
    [h.Class('flex flex-col gap-3')],
    [
      h.p(
        [h.Class('text-center text-[14px] leading-5 text-[#b7b7c4]')],
        [
          'Use your application credentials from my.telegram.org. Accounts remain connected for this tab; reloading signs this shell out.',
        ],
      ),
      textField(model, h, {
        id: 'telegram-api-id',
        label: 'API ID',
        value: model.apiId,
        placeholder: 'API ID',
        onInput: value => Message.UpdatedApiId({ value }),
      }),
      textField(model, h, {
        id: 'telegram-api-hash',
        label: 'API hash',
        value: Redacted.value(model.apiHash),
        placeholder: 'API hash',
        type: 'password',
        onInput: value =>
          Message.UpdatedApiHash({ value: Redacted.make(value) }),
      }),
    ],
  )

const credentialsView = (model: Model, h: HtmlBuilder<Message>) =>
  h.div(
    [h.Class('flex w-full flex-col gap-4')],
    [
      h.p(
        [h.Class('text-center text-[15px] leading-6 text-[#b7b7c4]')],
        ['Please confirm your country code and enter your phone number.'],
      ),
      model.appCredentials === 'Supplied'
        ? suppliedApplicationNote(h)
        : manualApplicationFields(model, h),
      textField(model, h, {
        id: 'telegram-phone',
        label: 'Phone number',
        value: Redacted.value(model.phone),
        placeholder: 'Phone number',
        type: 'tel',
        onInput: value => Message.UpdatedPhone({ value: Redacted.make(value) }),
      }),
      action(
        'Log in with phone',
        Message.ClickedPhoneLogin(),
        model.status === 'Busy',
        primaryClass,
        h,
      ),
      action(
        'Log in with QR',
        Message.ClickedQrLogin(),
        model.status === 'Busy',
        linkClass,
        h,
      ),
    ],
  )

const answerView = (model: Model, password: boolean, h: HtmlBuilder<Message>) =>
  h.div(
    [h.Class('flex w-full flex-col gap-4')],
    [
      h.p(
        [h.Class('text-center text-[15px] leading-6 text-[#b7b7c4]')],
        [
          password
            ? 'Enter your Telegram two-step verification password.'
            : 'Enter the login code Telegram sent to your app or phone.',
        ],
      ),
      textField(model, h, {
        id: 'telegram-answer',
        label: password ? '2FA password' : 'Login code',
        value: Redacted.value(model.answer),
        placeholder: password ? 'Password' : 'Code',
        type: 'password',
        onInput: value =>
          Message.UpdatedAnswer({ value: Redacted.make(value) }),
      }),
      action(
        'Continue',
        Message.SubmittedAnswer(),
        model.status === 'Busy',
        primaryClass,
        h,
      ),
    ],
  )

const headingFor = (login: Login): string => {
  if (login._tag === 'Code') {
    return 'Enter code'
  }
  if (login._tag === 'Password') {
    return 'Two-step verification'
  }
  if (login._tag === 'Qr') {
    return 'Log in by QR code'
  }
  return 'Sign in to Telegram'
}

export const loginScreen = (model: Model, h: HtmlBuilder<Message>) => {
  const disabled = model.status === 'Busy'
  return h.div(
    [h.Class('flex min-h-screen items-center justify-center px-4 py-10')],
    [
      h.section(
        [
          h.Class(
            'flex w-full max-w-[420px] flex-col items-center gap-5 rounded-[28px] bg-[#1c1c22]/95 px-8 py-10 shadow-2xl',
          ),
          h.AriaLabel('Telegram login'),
        ],
        [
          logo(h),
          h.h1(
            [h.Class('text-center text-[28px] font-semibold tracking-tight')],
            [headingFor(model.login)],
          ),
          Login.match(model.login, {
            Closed: () => h.empty,
            Editing: () => credentialsView(model, h),
            Code: () => answerView(model, false, h),
            Password: () => answerView(model, true, h),
            Qr: ({ image }) =>
              h.div(
                [h.Class('flex w-full flex-col items-center gap-4')],
                [
                  h.p(
                    [
                      h.Class(
                        'text-center text-[15px] leading-6 text-[#b7b7c4]',
                      ),
                    ],
                    [
                      'In Telegram on your phone, open Settings → Devices → Link Desktop Device and scan this code.',
                    ],
                  ),
                  h.img([
                    h.Src(image),
                    h.Alt('Telegram login QR code'),
                    h.Class('w-64 rounded-2xl bg-white p-3'),
                  ]),
                ],
              ),
          }),
          model.login._tag !== 'Editing' ||
          Array.isReadonlyArrayNonEmpty(model.accounts)
            ? action('Cancel', Message.ClickedCancel(), disabled, linkClass, h)
            : h.empty,
          disabled
            ? h.p(
                [h.Role('status'), h.Class('text-sm text-[#b7b7c4]')],
                ['Connecting to Telegram…'],
              )
            : h.empty,
        ],
      ),
    ],
  )
}
