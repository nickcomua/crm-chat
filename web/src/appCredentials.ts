export type AppCredentials = {
  readonly apiId: string
  readonly apiHash: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export const parseAppCredentials = (
  value: unknown,
): AppCredentials | undefined => {
  if (!isRecord(value)) {
    return undefined
  }
  const apiId = value['apiId']
  const apiHash = value['apiHash']
  if (typeof apiId !== 'string' || typeof apiHash !== 'string') {
    return undefined
  }
  if (!/^[1-9]\d*$/.test(apiId) || !/^[a-f\d]{32}$/i.test(apiHash)) {
    return undefined
  }
  return { apiId, apiHash }
}

const tauriInvoke = (
  value: object,
): ((command: string) => Promise<unknown>) | undefined => {
  const internals: unknown = Reflect.get(value, '__TAURI_INTERNALS__')
  if (!isRecord(internals)) {
    return undefined
  }
  const invoke: unknown = Reflect.get(internals, 'invoke')
  if (typeof invoke !== 'function') {
    return undefined
  }
  return (command: string) => Promise.resolve(invoke(command))
}

export const readAppCredentials = async (): Promise<
  AppCredentials | undefined
> => {
  const invoke = tauriInvoke(globalThis)
  if (invoke !== undefined) {
    return parseAppCredentials(await invoke('telegram_app_credentials'))
  }
  const response = await fetch('/runtime/telegram-app')
  if (!response.ok) {
    return undefined
  }
  return parseAppCredentials(await response.json())
}
