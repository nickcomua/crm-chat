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

const fieldClass = 'tg-input'

const primaryClass = 'tg-primary'

const linkClass = 'tg-link'

const logo = (h: HtmlBuilder<Message>) =>
  h.svg(
    [h.ViewBox('0 0 64 64'), h.Class('tg-logo'), h.AriaHidden(true)],
    [
      h.circle([h.Cx('32'), h.Cy('32'), h.R('32'), h.Class('tg-logo-badge')]),
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
          h.Class('tg-country'),
          h.AriaLabel('Country'),
          h.AriaExpanded(model.countryOpen),
          h.Disabled(model.status === 'Busy'),
          h.OnClick(Message.ClickedCountry()),
        ],
        [
          countryFlag(h, country),
          h.span([h.Class('min-w-0 flex-1 truncate text-left')], [country.name]),
          h.span([h.Class('tg-muted'), h.AriaHidden(true)], ['▾']),
        ],
      ),
      model.countryOpen
        ? h.div(
            [h.Class('tg-menu tg-country-menu'), h.Role('listbox'), h.AriaLabel('Country')],
            countries.map(item =>
              h.keyed('button')(
                item.iso,
                [
                  h.Class('tg-menu-item'),
                  h.AriaLabel(item.name),
                  h.OnClick(Message.SelectedCountry({ iso: item.iso })),
                ],
                [
                  countryFlag(h, item),
                  h.span([h.Class('min-w-0 flex-1 truncate')], [item.name]),
                  h.span([h.Class('tg-muted')], [item.dial]),
                ],
              ),
            ),
          )
        : h.empty,
    ],
  )
}

const manualApplicationFields = (model: Model, h: HtmlBuilder<Message>) =>
  model.appCredentials === 'Manual'
    ? h.div(
        [h.Class('flex w-full flex-col gap-3')],
        [
          h.p(
            [h.Class('tg-muted text-center text-[14px] leading-5')],
            [
              'Use your application credentials from my.telegram.org. A signed-in account stays in this browser.',
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
    : h.empty

const passkeyNote = (model: Model, h: HtmlBuilder<Message>) =>
  model.passkeyNote
    ? h.p(
        [h.Role('status'), h.Class('tg-muted text-center text-[14px] leading-5')],
        [
          'Passkey login is not available in this client. Use the QR code or your phone number.',
        ],
      )
    : h.empty

const textLink = (
  label: string,
  message: Message,
  disabled: boolean,
  h: HtmlBuilder<Message>,
) => action(label, message, disabled, 'tg-text-link', h)

const qrSteps = (h: HtmlBuilder<Message>) =>
  h.ol(
    [h.Class('tg-steps')],
    [
      h.li([], ['Open Telegram on your phone']),
      h.li([], ['Go to Settings → Devices → Link Desktop Device']),
      h.li([], ['Point your phone at this screen to confirm login']),
    ],
  )

const credentialsView = (model: Model, h: HtmlBuilder<Message>) =>
  h.div(
    [h.Class('flex w-full flex-col gap-4')],
    [
      textLink('Back', Message.ClickedQrForm(), model.status === 'Busy', h),
      h.p(
        [h.Class('tg-muted text-center text-[15px] leading-6')],
        ['Please confirm your country code and enter your phone number.'],
      ),
      manualApplicationFields(model, h),
      countryPicker(model, h),
      h.div(
        [h.Class('tg-phone')],
        [
          h.span([h.Class('tg-dial'), h.AriaHidden(true)], [dialFor(model.countryIso)]),
          textField(model, h, {
            id: 'telegram-phone',
            label: 'Phone number',
            value: Redacted.value(model.phone),
            placeholder: 'Phone number',
            type: 'tel',
            className: 'tg-input tg-input-inline',
            onInput: value =>
              Message.UpdatedPhone({ value: Redacted.make(value) }),
          }),
        ],
      ),
      action(
        'Next',
        Message.ClickedPhoneLogin(),
        model.status === 'Busy',
        primaryClass,
        h,
      ),
      textLink(
        'Log in by QR code',
        Message.ClickedQrLogin(),
        model.status === 'Busy',
        h,
      ),
      textLink(
        'Log in by passkey',
        Message.ClickedPasskey(),
        model.status === 'Busy',
        h,
      ),
      passkeyNote(model, h),
    ],
  )

const qrEntry = (model: Model, h: HtmlBuilder<Message>) =>
  h.div(
    [h.Class('flex w-full flex-col items-center gap-4')],
    [
      h.p(
        [h.Class('tg-muted text-center text-[15px] leading-6')],
        ['Scan with Telegram app on your phone'],
      ),
      qrSteps(h),
      manualApplicationFields(model, h),
      action(
        'Log in by QR code',
        Message.ClickedQrLogin(),
        model.status === 'Busy',
        primaryClass,
        h,
      ),
      textLink(
        'Log in by phone number',
        Message.ClickedPhoneForm(),
        model.status === 'Busy',
        h,
      ),
      textLink(
        'Log in by passkey',
        Message.ClickedPasskey(),
        model.status === 'Busy',
        h,
      ),
      passkeyNote(model, h),
    ],
  )

const answerView = (model: Model, password: boolean, h: HtmlBuilder<Message>) =>
  h.div(
    [h.Class('flex w-full flex-col gap-4')],
    [
      h.p(
        [h.Class('tg-muted text-center text-[15px] leading-6')],
        [
          password
            ? 'Your account is protected with an additional cloud password.'
            : 'Enter the login code Telegram sent to your app or phone.',
        ],
      ),
      password &&
      model.login._tag === 'Password' &&
      model.login.hint !== undefined &&
      model.login.hint !== ''
        ? h.p(
            [h.Class('tg-muted text-center text-[15px] leading-6')],
            [`Hint: ${model.login.hint}`],
          )
        : h.empty,
      textField(model, h, {
        id: 'telegram-answer',
        label: password ? 'Cloud password' : 'Login code',
        value: Redacted.value(model.answer),
        placeholder: password ? 'Password' : 'Code',
        type: 'password',
        onInput: value =>
          Message.UpdatedAnswer({ value: Redacted.make(value) }),
      }),
      action(
        'Next',
        Message.SubmittedAnswer(),
        model.status === 'Busy',
        primaryClass,
        h,
      ),
    ],
  )

const headingFor = (model: Model): string => {
  if (model.login._tag === 'Code') {
    return 'Enter Code'
  }
  if (model.login._tag === 'Password') {
    return 'Enter Password'
  }
  if (model.login._tag === 'Qr' || model.authEntry === 'Qr') {
    return 'Log in to Telegram by QR Code'
  }
  return 'Sign in to Telegram'
}

export const loginScreen = (model: Model, h: HtmlBuilder<Message>) => {
  const disabled = model.status === 'Busy'
  const showLogo = model.login._tag !== 'Qr'
  return h.div(
    [h.Class('flex min-h-screen items-center justify-center px-6 py-10')],
    [
      h.section(
        [h.Class('login-card'), h.AriaLabel('Telegram login')],
        [
          showLogo ? logo(h) : h.empty,
          model.login._tag === 'Qr'
            ? h.empty
            : h.h1([h.Class('tg-login-title')], [headingFor(model)]),
          Login.match(model.login, {
            Closed: () => h.empty,
            Editing: () =>
              model.authEntry === 'Phone'
                ? credentialsView(model, h)
                : qrEntry(model, h),
            Code: () => answerView(model, false, h),
            Password: () => answerView(model, true, h),
            Qr: ({ image }) =>
              h.div(
                [h.Class('flex w-full flex-col items-center gap-4')],
                [
                  h.img([
                    h.Src(image),
                    h.Alt('Telegram login QR code'),
                    h.Class('tg-qr'),
                  ]),
                  h.h1(
                    [h.Class('tg-login-title')],
                    ['Log in to Telegram by QR Code'],
                  ),
                  h.p(
                    [h.Class('tg-muted text-center text-[15px] leading-6')],
                    ['Scan with Telegram app on your phone'],
                  ),
                  qrSteps(h),
                  action(
                    'Log in by phone number',
                    Message.ClickedPhoneForm(),
                    disabled,
                    primaryClass,
                    h,
                  ),
                  textLink(
                    'Log in by passkey',
                    Message.ClickedPasskey(),
                    disabled,
                    h,
                  ),
                  passkeyNote(model, h),
                ],
              ),
          }),
          model.login._tag === 'Code' || model.login._tag === 'Password'
            ? action('Back', Message.ClickedCancel(), disabled, linkClass, h)
            : (model.login._tag === 'Qr' || model.login._tag === 'Editing') &&
                Array.isReadonlyArrayNonEmpty(model.accounts)
              ? action(
                  'Cancel',
                  Message.ClickedCancel(),
                  disabled,
                  linkClass,
                  h,
                )
              : h.empty,
          disabled
            ? h.p(
                [h.Role('status'), h.Class('tg-muted text-sm')],
                ['Connecting to Telegram…'],
              )
            : h.empty,
        ],
      ),
    ],
  )
}
