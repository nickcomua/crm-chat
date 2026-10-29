import * as Array from 'effect/Array'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import { HtmlBuilder } from 'foldkit/html'

import * as Button from '@foldkit/ui/button'
import * as Input from '@foldkit/ui/input'

import { countries, countryByIso, defaultCountryIso, dialFor } from './countries'
import { countryFlag } from './flag'
import { Login } from './login'
import type { Model } from './main'
import { Message } from './message'

const fieldClass =
  'w-full rounded-xl border border-white/15 bg-transparent px-4 py-3 text-[16px] text-white outline-none placeholder:text-[#8d8d9a]'

const primaryClass =
  'w-full rounded-full bg-[#8774e1] px-4 py-3 text-[15px] font-medium uppercase tracking-wide text-white disabled:opacity-50'

const secondaryClass =
  'w-full rounded-full bg-[#2a2a32] px-4 py-3 text-[13px] font-medium uppercase tracking-wide text-[#a28cf0] disabled:opacity-50'

const linkClass =
  'w-full rounded-full px-4 py-3 text-[13px] font-medium uppercase tracking-wide text-[#a28cf0] disabled:opacity-50'

const logo = (h: HtmlBuilder<Message>) =>
  h.svg(
    [h.ViewBox('0 0 64 64'), h.Class('size-24'), h.AriaHidden(true)],
    [
      h.circle([h.Cx('32'), h.Cy('32'), h.R('32'), h.Fill('#8774e1')]),
      h.path([
        h.Fill('#FFFFFF'),
        h.D(
          'M16.8 32.4 46.2 19.4c1.3-.6 2.6.7 2.1 2.1L41.2 46c-.3 1.3-1.8 1.8-2.8 1l-7.6-4.8-4 3.8c-.5.4-1.2.2-1.3-.4l-.5-6.4 15-13.4-18.6 11.6-6.4-2.2c-1.4-.5-1.4-2.4.2-2.8z',
        ),
      ]),
    ],
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
    readonly className?: string
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
          h.Class(field.className ?? fieldClass),
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

const selectedCountry = (model: Model) =>
  Option.getOrElse(countryByIso(model.countryIso), () =>
    Option.getOrElse(countryByIso(defaultCountryIso), () => countries[0]!),
  )

const countryPicker = (model: Model, h: HtmlBuilder<Message>) => {
  const country = selectedCountry(model)
  return h.div(
    [h.Class('relative w-full')],
    [
      h.button(
        [
          h.Class(
            'flex w-full items-center gap-3 rounded-xl border border-white/15 px-3 py-3 text-left text-[16px]',
          ),
          h.AriaLabel('Country'),
          h.AriaExpanded(model.countryOpen),
          h.Disabled(model.status === 'Busy'),
          h.OnClick(Message.ClickedCountry()),
        ],
        [
          countryFlag(h, country),
          h.span([h.Class('min-w-0 flex-1 truncate')], [country.name]),
          h.span([h.Class('text-[#8d8d9a]'), h.AriaHidden(true)], ['▾']),
        ],
      ),
      model.countryOpen
        ? h.div(
            [
              h.Class(
                'absolute left-0 right-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-xl bg-[#2a2a32] py-1 shadow-2xl',
              ),
              h.Role('listbox'),
              h.AriaLabel('Country'),
            ],
            countries.map(item =>
              h.keyed('button')(
                item.iso,
                [
                  h.Class(
                    'flex w-full items-center gap-3 px-3 py-2 text-left text-[15px] hover:bg-white/10',
                  ),
                  h.AriaLabel(item.name),
                  h.OnClick(Message.SelectedCountry({ iso: item.iso })),
                ],
                [
                  countryFlag(h, item),
                  h.span([h.Class('min-w-0 flex-1 truncate')], [item.name]),
                  h.span([h.Class('text-[#8d8d9a]')], [item.dial]),
                ],
              ),
            ),
          )
        : h.empty,
    ],
  )
}

const keepSignedIn = (model: Model, h: HtmlBuilder<Message>) =>
  h.label(
    [
      h.Class(
        'flex w-full items-center gap-3 rounded-xl bg-white/5 px-3 py-3 text-[15px]',
      ),
    ],
    [
      h.input([
        h.Type('checkbox'),
        h.Class('size-4 accent-[#8774e1]'),
        h.Checked(model.keepSignedIn),
        h.AriaLabel('Keep me signed in'),
        h.Disabled(model.status === 'Busy'),
        h.OnClick(Message.ToggledKeepSignedIn()),
      ]),
      'Keep me signed in',
    ],
  )

const manualApplicationFields = (model: Model, h: HtmlBuilder<Message>) =>
  h.div(
    [h.Class('flex w-full flex-col gap-3')],
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
      model.appCredentials === 'Manual'
        ? manualApplicationFields(model, h)
        : h.empty,
      countryPicker(model, h),
      h.div(
        [
          h.Class(
            'flex w-full items-center gap-2 rounded-xl border border-[#8774e1]/80 px-3',
          ),
        ],
        [
          h.span(
            [h.Class('shrink-0 text-[16px] text-[#a28cf0]'), h.AriaHidden(true)],
            [dialFor(model.countryIso)],
          ),
          textField(model, h, {
            id: 'telegram-phone',
            label: 'Phone number',
            value: Redacted.value(model.phone),
            placeholder: 'Phone number',
            type: 'tel',
            className:
              'min-w-0 flex-1 bg-transparent py-3 text-[16px] text-white outline-none placeholder:text-[#8d8d9a]',
            onInput: value =>
              Message.UpdatedPhone({ value: Redacted.make(value) }),
          }),
        ],
      ),
      keepSignedIn(model, h),
      action(
        'Next',
        Message.ClickedPhoneLogin(),
        model.status === 'Busy',
        primaryClass,
        h,
      ),
      action(
        'Log in by QR code',
        Message.ClickedQrLogin(),
        model.status === 'Busy',
        secondaryClass,
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
    [h.Class('flex min-h-screen items-center justify-center px-6 py-10')],
    [
      h.section(
        [
          h.Class('flex w-full max-w-[392px] flex-col items-center gap-5 rounded-[28px] bg-[#212121] px-6 py-8 shadow-2xl'),
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
