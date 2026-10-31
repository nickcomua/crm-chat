import * as Option from 'effect/Option'
import { Runtime } from 'foldkit'
import { modifyFields } from 'foldkit/struct'

import { fixtureChats, fixtureFaces } from './fixture'
import { Login } from './login'
import { type Model, initialModel } from './main'
import type { Message } from './message'

const previewQrImage =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" shape-rendering="crispEdges"><rect width="100" height="100" fill="white"/><rect x="8" y="8" width="28" height="28" fill="#212121"/><rect x="14" y="14" width="16" height="16" fill="white"/><rect x="18" y="18" width="8" height="8" fill="#212121"/><rect x="64" y="8" width="28" height="28" fill="#212121"/><rect x="70" y="14" width="16" height="16" fill="white"/><rect x="74" y="18" width="8" height="8" fill="#212121"/><rect x="8" y="64" width="28" height="28" fill="#212121"/><rect x="14" y="70" width="16" height="16" fill="white"/><rect x="18" y="74" width="8" height="8" fill="#212121"/><rect x="44" y="44" width="6" height="6" fill="#212121"/><rect x="54" y="44" width="6" height="6" fill="#212121"/><rect x="44" y="54" width="6" height="6" fill="#212121"/><rect x="64" y="64" width="6" height="6" fill="#212121"/><rect x="76" y="52" width="6" height="6" fill="#212121"/><rect x="52" y="76" width="6" height="6" fill="#212121"/><rect x="84" y="84" width="6" height="6" fill="#212121"/></svg>',
  )

const previewAccount = {
  id: 'preview',
  title: 'You',
  chats: [...fixtureChats],
}

const shell = (model: Model): Model =>
  modifyFields(model, {
    login: () => Login.Closed(),
    accounts: () => [previewAccount],
    selectedAccountId: () => previewAccount.id,
    faces: () => fixtureFaces(),
    fixturePreview: () => true,
  })

const readScreen = (): string => {
  if (typeof window === 'undefined') {
    return 'login'
  }
  return new URLSearchParams(window.location.search).get('screen') ?? 'login'
}

const previewModel = (screen: string): Model => {
  const manual = screen === 'login-manual'
  const base = modifyFields(initialModel, {
    fixturePreview: () => true,
    appCredentials: () => (manual ? 'Manual' : 'Supplied'),
    apiId: () => (manual ? '' : '1'),
  })
  if (screen === 'code') {
    return modifyFields(base, {
      login: () => Login.Code({ id: 'preview' }),
    })
  }
  if (screen === 'password') {
    return modifyFields(base, {
      login: () => Login.Password({ id: 'preview', hint: 'birthday' }),
    })
  }
  if (screen === 'qr') {
    return modifyFields(base, {
      authEntry: () => 'Qr',
      login: () => Login.Qr({ id: 'preview', image: previewQrImage }),
    })
  }
  if (screen === 'phone') {
    return modifyFields(base, {
      authEntry: () => 'Phone',
    })
  }
  if (screen === 'thread') {
    return modifyFields(shell(base), {
      maybeOpenChatId: () => Option.some('ada'),
    })
  }
  if (screen === 'menu') {
    return modifyFields(shell(base), {
      menuOpen: () => true,
      moreOpen: () => true,
    })
  }
  if (screen === 'chat-menu') {
    return modifyFields(shell(base), {
      maybeOpenChatId: () => Option.some('ada'),
      headerMenuOpen: () => true,
      autoDeleteOpen: () => true,
    })
  }
  if (screen === 'chats') {
    return shell(base)
  }
  if (screen === 'empty') {
    return modifyFields(shell(base), {
      accounts: () => [{ id: 'preview', title: 'You', chats: [] }],
    })
  }
  return base
}

export const initPreview: Runtime.ApplicationInit<Model, Message> = () => ({
  model: previewModel(readScreen()),
})
