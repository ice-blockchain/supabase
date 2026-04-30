import { AuthClient, navigatorLock, User } from '@supabase/auth-js'

const isBrowser = typeof window !== 'undefined'

export const STORAGE_KEY = process.env.NEXT_PUBLIC_STORAGE_KEY || 'supabase.dashboard.auth.token'
export const AUTH_DEBUG_KEY =
  process.env.NEXT_PUBLIC_AUTH_DEBUG_KEY || 'supabase.dashboard.auth.debug'
export const AUTH_DEBUG_PERSISTED_KEY =
  process.env.NEXT_PUBLIC_AUTH_DEBUG_PERSISTED_KEY || 'supabase.dashboard.auth.debug.persist'
export const AUTH_NAVIGATOR_LOCK_DISABLED_KEY =
  process.env.NEXT_PUBLIC_AUTH_NAVIGATOR_LOCK_KEY ||
  'supabase.dashboard.auth.navigatorLock.disabled'

function safeGetLocalStorage(key: string) {
  try {
    return globalThis?.localStorage?.getItem(key)
  } catch {
    return null
  }
}

const debug =
  process.env.NEXT_PUBLIC_IS_PLATFORM === 'true' && safeGetLocalStorage(AUTH_DEBUG_KEY) === 'true'

const persistedDebug =
  process.env.NEXT_PUBLIC_IS_PLATFORM === 'true' &&
  safeGetLocalStorage(AUTH_DEBUG_PERSISTED_KEY) === 'true'

const shouldEnableNavigatorLock =
  process.env.NEXT_PUBLIC_IS_PLATFORM === 'true' &&
  !(safeGetLocalStorage(AUTH_NAVIGATOR_LOCK_DISABLED_KEY) === 'true')

const shouldDetectSessionInUrl = process.env.NEXT_PUBLIC_AUTH_DETECT_SESSION_IN_URL
  ? process.env.NEXT_PUBLIC_AUTH_DETECT_SESSION_IN_URL === 'true'
  : true

const navigatorLockEnabled = !!(shouldEnableNavigatorLock && globalThis?.navigator?.locks)

if (isBrowser && shouldEnableNavigatorLock && !globalThis?.navigator?.locks) {
  console.warn('This browser does not support the Navigator Locks API. Please update it.')
}

const gotrueUrl = isBrowser
  ? process.env.NEXT_PUBLIC_GOTRUE_URL
  : (process.env.SUPABASE_URL
    ? process.env.SUPABASE_URL + '/auth/v1'
    : process.env.NEXT_PUBLIC_GOTRUE_URL)

export const gotrueClient = new AuthClient({
  url: gotrueUrl,
  storageKey: STORAGE_KEY,
  detectSessionInUrl: shouldDetectSessionInUrl,
  debug: debug ? (persistedDebug ? undefined : true) : false,
  lock: navigatorLockEnabled ? navigatorLock : undefined,
  ...('localStorage' in globalThis
    ? { storage: globalThis.localStorage, userStorage: globalThis.localStorage }
    : null),
})

export type { User }
