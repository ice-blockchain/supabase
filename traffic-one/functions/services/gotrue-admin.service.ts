import type { Pool } from 'https://deno.land/x/postgres@v0.19.3/mod.ts'

import { fetchProjectJson, type ProjectBackend } from './project-backend.service.ts'

// ─────────────────────────────────────────────────────────────────────────────
//
// GoTrue admin proxy for self-hosted platform mode.
//
// GoTrue's own configuration is set via environment variables and requires a
// container restart to change. It has no live /admin/config JSON endpoint we
// can PATCH. So this module layers a userspace override table on top of the
// env-derived defaults:
//
//   effective config = defaults (from Deno.env.get("GOTRUE_*")) + overrides
//     (traffic.auth_config_overrides rows, JSONB values keyed by project_ref)
//
// PATCH writes upsert rows into the override table. Subsequent GETs merge
// defaults + overrides so Studio's save loop appears to work — it sees its
// own writes reflected back on reload.
//
// IMPORTANT: the live GoTrue container is NOT reconfigured by this module.
// Operators must restart GoTrue with updated GOTRUE_* env vars for changes
// to take effect at the auth layer (OAuth callbacks, SMTP delivery, hook
// invocations, etc.). Studio's UI reads from the override layer, which is
// the source of truth for the dashboard — not necessarily for the runtime.
//
// ─────────────────────────────────────────────────────────────────────────────

// Explicit secret fields that don't match the suffix regex below but must
// still be redacted on read.
const SECRET_FIELDS = new Set<string>([
  'SMTP_PASS',
  'SECURITY_CAPTCHA_SECRET',
  'SMS_TWILIO_AUTH_TOKEN',
  'SMS_TWILIO_VERIFY_AUTH_TOKEN',
  'SMS_MESSAGEBIRD_ACCESS_KEY',
  'SMS_VONAGE_API_KEY',
  'SMS_TEXTLOCAL_API_KEY',
])

const SECRET_SUFFIX_RE = /_(SECRET|SECRETS|PASS|PASSWORD)$/

export function isSecretField(key: string): boolean {
  return SECRET_FIELDS.has(key) || SECRET_SUFFIX_RE.test(key)
}

function redactValue(key: string, value: unknown): unknown {
  if (!isSecretField(key)) return value
  if (typeof value === 'string') return value.length > 0 ? '***' : ''
  if (value === null || value === undefined) return ''
  return '***'
}

function envStr(name: string, fallback = ''): string {
  return Deno.env.get(name) ?? fallback
}

function envBool(name: string, fallback = false): boolean {
  const raw = Deno.env.get(name)
  if (raw === undefined || raw === null || raw === '') return fallback
  return raw.toLowerCase() === 'true'
}

function envNum(name: string, fallback: number): number {
  const raw = Deno.env.get(name)
  if (raw === undefined || raw === null || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

// ── Default config ───────────────────────────────────────────────────────────
//
// Field set mirrors `GoTrueConfigResponse` in packages/api-types/types/platform.d.ts.
// Values prefer a matching GOTRUE_* env var when present, otherwise fall back
// to the GoTrue defaults documented at https://supabase.com/docs/guides/auth.
//
// Note: in the docker-compose.yml shipped with this repo, GOTRUE_* env vars
// are set only on the `auth` container, not on the `functions` container, so
// most lookups here will fall back to the hardcoded defaults. Operators can
// propagate GOTRUE_* into the functions service to seed runtime-accurate
// defaults; the override table still takes precedence.

export function getDefaultConfig(): Record<string, unknown> {
  const siteUrl = envStr('GOTRUE_SITE_URL', envStr('SITE_URL', 'http://localhost:3000'))
  const apiExternalUrl = envStr('API_EXTERNAL_URL', envStr('SUPABASE_PUBLIC_URL', ''))

  return {
    // Core
    SITE_URL: siteUrl,
    URI_ALLOW_LIST: envStr('GOTRUE_URI_ALLOW_LIST', envStr('ADDITIONAL_REDIRECT_URLS', '')),
    JWT_EXP: envNum('GOTRUE_JWT_EXP', envNum('JWT_EXPIRY', 3600)),
    DISABLE_SIGNUP: envBool('GOTRUE_DISABLE_SIGNUP', envBool('DISABLE_SIGNUP', false)),
    REFRESH_TOKEN_ROTATION_ENABLED: envBool('GOTRUE_REFRESH_TOKEN_ROTATION_ENABLED', true),
    API_MAX_REQUEST_DURATION: envNum('GOTRUE_API_MAX_REQUEST_DURATION', 10),
    AUDIT_LOG_DISABLE_POSTGRES: envBool('GOTRUE_AUDIT_LOG_DISABLE_POSTGRES', false),

    // Mailer / email
    MAILER_AUTOCONFIRM: envBool(
      'GOTRUE_MAILER_AUTOCONFIRM',
      envBool('ENABLE_EMAIL_AUTOCONFIRM', false),
    ),
    MAILER_ALLOW_UNVERIFIED_EMAIL_SIGN_INS: envBool(
      'GOTRUE_MAILER_ALLOW_UNVERIFIED_EMAIL_SIGN_INS',
      false,
    ),
    MAILER_SECURE_EMAIL_CHANGE_ENABLED: envBool('GOTRUE_MAILER_SECURE_EMAIL_CHANGE_ENABLED', true),
    MAILER_OTP_EXP: envNum('GOTRUE_MAILER_OTP_EXP', 3600),
    MAILER_OTP_LENGTH: envNum('GOTRUE_MAILER_OTP_LENGTH', 6),
    MAILER_NOTIFICATIONS_EMAIL_CHANGED_ENABLED: envBool(
      'GOTRUE_MAILER_NOTIFICATIONS_EMAIL_CHANGED_ENABLED',
      true,
    ),
    MAILER_NOTIFICATIONS_IDENTITY_LINKED_ENABLED: envBool(
      'GOTRUE_MAILER_NOTIFICATIONS_IDENTITY_LINKED_ENABLED',
      true,
    ),
    MAILER_NOTIFICATIONS_IDENTITY_UNLINKED_ENABLED: envBool(
      'GOTRUE_MAILER_NOTIFICATIONS_IDENTITY_UNLINKED_ENABLED',
      true,
    ),
    MAILER_NOTIFICATIONS_MFA_FACTOR_ENROLLED_ENABLED: envBool(
      'GOTRUE_MAILER_NOTIFICATIONS_MFA_FACTOR_ENROLLED_ENABLED',
      true,
    ),
    MAILER_NOTIFICATIONS_MFA_FACTOR_UNENROLLED_ENABLED: envBool(
      'GOTRUE_MAILER_NOTIFICATIONS_MFA_FACTOR_UNENROLLED_ENABLED',
      true,
    ),
    MAILER_NOTIFICATIONS_PASSWORD_CHANGED_ENABLED: envBool(
      'GOTRUE_MAILER_NOTIFICATIONS_PASSWORD_CHANGED_ENABLED',
      true,
    ),
    MAILER_NOTIFICATIONS_PHONE_CHANGED_ENABLED: envBool(
      'GOTRUE_MAILER_NOTIFICATIONS_PHONE_CHANGED_ENABLED',
      true,
    ),
    MAILER_SUBJECTS_CONFIRMATION: envStr(
      'GOTRUE_MAILER_SUBJECTS_CONFIRMATION',
      'Confirm your email',
    ),
    MAILER_SUBJECTS_EMAIL_CHANGE: envStr(
      'GOTRUE_MAILER_SUBJECTS_EMAIL_CHANGE',
      'Confirm your email change',
    ),
    MAILER_SUBJECTS_EMAIL_CHANGED_NOTIFICATION: envStr(
      'GOTRUE_MAILER_SUBJECTS_EMAIL_CHANGED_NOTIFICATION',
      '',
    ),
    MAILER_SUBJECTS_IDENTITY_LINKED_NOTIFICATION: envStr(
      'GOTRUE_MAILER_SUBJECTS_IDENTITY_LINKED_NOTIFICATION',
      '',
    ),
    MAILER_SUBJECTS_IDENTITY_UNLINKED_NOTIFICATION: envStr(
      'GOTRUE_MAILER_SUBJECTS_IDENTITY_UNLINKED_NOTIFICATION',
      '',
    ),
    MAILER_SUBJECTS_INVITE: envStr('GOTRUE_MAILER_SUBJECTS_INVITE', 'You have been invited'),
    MAILER_SUBJECTS_MAGIC_LINK: envStr('GOTRUE_MAILER_SUBJECTS_MAGIC_LINK', 'Your Magic Link'),
    MAILER_SUBJECTS_MFA_FACTOR_ENROLLED_NOTIFICATION: envStr(
      'GOTRUE_MAILER_SUBJECTS_MFA_FACTOR_ENROLLED_NOTIFICATION',
      '',
    ),
    MAILER_SUBJECTS_MFA_FACTOR_UNENROLLED_NOTIFICATION: envStr(
      'GOTRUE_MAILER_SUBJECTS_MFA_FACTOR_UNENROLLED_NOTIFICATION',
      '',
    ),
    MAILER_SUBJECTS_PASSWORD_CHANGED_NOTIFICATION: envStr(
      'GOTRUE_MAILER_SUBJECTS_PASSWORD_CHANGED_NOTIFICATION',
      '',
    ),
    MAILER_SUBJECTS_PHONE_CHANGED_NOTIFICATION: envStr(
      'GOTRUE_MAILER_SUBJECTS_PHONE_CHANGED_NOTIFICATION',
      '',
    ),
    MAILER_SUBJECTS_REAUTHENTICATION: envStr(
      'GOTRUE_MAILER_SUBJECTS_REAUTHENTICATION',
      'Confirm reauthentication',
    ),
    MAILER_SUBJECTS_RECOVERY: envStr('GOTRUE_MAILER_SUBJECTS_RECOVERY', 'Reset Your Password'),
    MAILER_TEMPLATES_CONFIRMATION_CONTENT: envStr(
      'GOTRUE_MAILER_TEMPLATES_CONFIRMATION_CONTENT',
      '',
    ),
    MAILER_TEMPLATES_EMAIL_CHANGE_CONTENT: envStr(
      'GOTRUE_MAILER_TEMPLATES_EMAIL_CHANGE_CONTENT',
      '',
    ),
    MAILER_TEMPLATES_EMAIL_CHANGED_NOTIFICATION_CONTENT: envStr(
      'GOTRUE_MAILER_TEMPLATES_EMAIL_CHANGED_NOTIFICATION_CONTENT',
      '',
    ),
    MAILER_TEMPLATES_IDENTITY_LINKED_NOTIFICATION_CONTENT: envStr(
      'GOTRUE_MAILER_TEMPLATES_IDENTITY_LINKED_NOTIFICATION_CONTENT',
      '',
    ),
    MAILER_TEMPLATES_IDENTITY_UNLINKED_NOTIFICATION_CONTENT: envStr(
      'GOTRUE_MAILER_TEMPLATES_IDENTITY_UNLINKED_NOTIFICATION_CONTENT',
      '',
    ),
    MAILER_TEMPLATES_INVITE_CONTENT: envStr('GOTRUE_MAILER_TEMPLATES_INVITE_CONTENT', ''),
    MAILER_TEMPLATES_MAGIC_LINK_CONTENT: envStr('GOTRUE_MAILER_TEMPLATES_MAGIC_LINK_CONTENT', ''),
    MAILER_TEMPLATES_MFA_FACTOR_ENROLLED_NOTIFICATION_CONTENT: envStr(
      'GOTRUE_MAILER_TEMPLATES_MFA_FACTOR_ENROLLED_NOTIFICATION_CONTENT',
      '',
    ),
    MAILER_TEMPLATES_MFA_FACTOR_UNENROLLED_NOTIFICATION_CONTENT: envStr(
      'GOTRUE_MAILER_TEMPLATES_MFA_FACTOR_UNENROLLED_NOTIFICATION_CONTENT',
      '',
    ),
    MAILER_TEMPLATES_PASSWORD_CHANGED_NOTIFICATION_CONTENT: envStr(
      'GOTRUE_MAILER_TEMPLATES_PASSWORD_CHANGED_NOTIFICATION_CONTENT',
      '',
    ),
    MAILER_TEMPLATES_PHONE_CHANGED_NOTIFICATION_CONTENT: envStr(
      'GOTRUE_MAILER_TEMPLATES_PHONE_CHANGED_NOTIFICATION_CONTENT',
      '',
    ),
    MAILER_TEMPLATES_REAUTHENTICATION_CONTENT: envStr(
      'GOTRUE_MAILER_TEMPLATES_REAUTHENTICATION_CONTENT',
      '',
    ),
    MAILER_TEMPLATES_RECOVERY_CONTENT: envStr('GOTRUE_MAILER_TEMPLATES_RECOVERY_CONTENT', ''),

    // SMTP
    SMTP_ADMIN_EMAIL: envStr('GOTRUE_SMTP_ADMIN_EMAIL', envStr('SMTP_ADMIN_EMAIL', '')),
    SMTP_HOST: envStr('GOTRUE_SMTP_HOST', envStr('SMTP_HOST', '')),
    SMTP_PORT: envStr('GOTRUE_SMTP_PORT', envStr('SMTP_PORT', '')),
    SMTP_USER: envStr('GOTRUE_SMTP_USER', envStr('SMTP_USER', '')),
    SMTP_PASS: envStr('GOTRUE_SMTP_PASS', envStr('SMTP_PASS', '')),
    SMTP_SENDER_NAME: envStr('GOTRUE_SMTP_SENDER_NAME', envStr('SMTP_SENDER_NAME', '')),
    SMTP_MAX_FREQUENCY: envNum('GOTRUE_SMTP_MAX_FREQUENCY', 60),

    // External providers — enabled flags
    EXTERNAL_EMAIL_ENABLED: envBool(
      'GOTRUE_EXTERNAL_EMAIL_ENABLED',
      envBool('ENABLE_EMAIL_SIGNUP', true),
    ),
    EXTERNAL_PHONE_ENABLED: envBool(
      'GOTRUE_EXTERNAL_PHONE_ENABLED',
      envBool('ENABLE_PHONE_SIGNUP', false),
    ),
    EXTERNAL_ANONYMOUS_USERS_ENABLED: envBool(
      'GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED',
      envBool('ENABLE_ANONYMOUS_USERS', false),
    ),
    EXTERNAL_APPLE_ENABLED: envBool('GOTRUE_EXTERNAL_APPLE_ENABLED', false),
    EXTERNAL_APPLE_CLIENT_ID: envStr('GOTRUE_EXTERNAL_APPLE_CLIENT_ID', ''),
    EXTERNAL_APPLE_SECRET: envStr('GOTRUE_EXTERNAL_APPLE_SECRET', ''),
    EXTERNAL_APPLE_ADDITIONAL_CLIENT_IDS: envStr('GOTRUE_EXTERNAL_APPLE_ADDITIONAL_CLIENT_IDS', ''),
    EXTERNAL_APPLE_EMAIL_OPTIONAL: envBool('GOTRUE_EXTERNAL_APPLE_EMAIL_OPTIONAL', false),
    EXTERNAL_AZURE_ENABLED: envBool('GOTRUE_EXTERNAL_AZURE_ENABLED', false),
    EXTERNAL_AZURE_CLIENT_ID: envStr('GOTRUE_EXTERNAL_AZURE_CLIENT_ID', ''),
    EXTERNAL_AZURE_SECRET: envStr('GOTRUE_EXTERNAL_AZURE_SECRET', ''),
    EXTERNAL_AZURE_URL: envStr('GOTRUE_EXTERNAL_AZURE_URL', ''),
    EXTERNAL_AZURE_EMAIL_OPTIONAL: envBool('GOTRUE_EXTERNAL_AZURE_EMAIL_OPTIONAL', false),
    EXTERNAL_BITBUCKET_ENABLED: envBool('GOTRUE_EXTERNAL_BITBUCKET_ENABLED', false),
    EXTERNAL_BITBUCKET_CLIENT_ID: envStr('GOTRUE_EXTERNAL_BITBUCKET_CLIENT_ID', ''),
    EXTERNAL_BITBUCKET_SECRET: envStr('GOTRUE_EXTERNAL_BITBUCKET_SECRET', ''),
    EXTERNAL_BITBUCKET_EMAIL_OPTIONAL: envBool('GOTRUE_EXTERNAL_BITBUCKET_EMAIL_OPTIONAL', false),
    EXTERNAL_DISCORD_ENABLED: envBool('GOTRUE_EXTERNAL_DISCORD_ENABLED', false),
    EXTERNAL_DISCORD_CLIENT_ID: envStr('GOTRUE_EXTERNAL_DISCORD_CLIENT_ID', ''),
    EXTERNAL_DISCORD_SECRET: envStr('GOTRUE_EXTERNAL_DISCORD_SECRET', ''),
    EXTERNAL_DISCORD_EMAIL_OPTIONAL: envBool('GOTRUE_EXTERNAL_DISCORD_EMAIL_OPTIONAL', false),
    EXTERNAL_FACEBOOK_ENABLED: envBool('GOTRUE_EXTERNAL_FACEBOOK_ENABLED', false),
    EXTERNAL_FACEBOOK_CLIENT_ID: envStr('GOTRUE_EXTERNAL_FACEBOOK_CLIENT_ID', ''),
    EXTERNAL_FACEBOOK_SECRET: envStr('GOTRUE_EXTERNAL_FACEBOOK_SECRET', ''),
    EXTERNAL_FACEBOOK_EMAIL_OPTIONAL: envBool('GOTRUE_EXTERNAL_FACEBOOK_EMAIL_OPTIONAL', false),
    EXTERNAL_FIGMA_ENABLED: envBool('GOTRUE_EXTERNAL_FIGMA_ENABLED', false),
    EXTERNAL_FIGMA_CLIENT_ID: envStr('GOTRUE_EXTERNAL_FIGMA_CLIENT_ID', ''),
    EXTERNAL_FIGMA_SECRET: envStr('GOTRUE_EXTERNAL_FIGMA_SECRET', ''),
    EXTERNAL_FIGMA_EMAIL_OPTIONAL: envBool('GOTRUE_EXTERNAL_FIGMA_EMAIL_OPTIONAL', false),
    EXTERNAL_GITHUB_ENABLED: envBool('GOTRUE_EXTERNAL_GITHUB_ENABLED', false),
    EXTERNAL_GITHUB_CLIENT_ID: envStr('GOTRUE_EXTERNAL_GITHUB_CLIENT_ID', ''),
    EXTERNAL_GITHUB_SECRET: envStr('GOTRUE_EXTERNAL_GITHUB_SECRET', ''),
    EXTERNAL_GITHUB_EMAIL_OPTIONAL: envBool('GOTRUE_EXTERNAL_GITHUB_EMAIL_OPTIONAL', false),
    EXTERNAL_GITLAB_ENABLED: envBool('GOTRUE_EXTERNAL_GITLAB_ENABLED', false),
    EXTERNAL_GITLAB_CLIENT_ID: envStr('GOTRUE_EXTERNAL_GITLAB_CLIENT_ID', ''),
    EXTERNAL_GITLAB_SECRET: envStr('GOTRUE_EXTERNAL_GITLAB_SECRET', ''),
    EXTERNAL_GITLAB_URL: envStr('GOTRUE_EXTERNAL_GITLAB_URL', ''),
    EXTERNAL_GITLAB_EMAIL_OPTIONAL: envBool('GOTRUE_EXTERNAL_GITLAB_EMAIL_OPTIONAL', false),
    EXTERNAL_GOOGLE_ENABLED: envBool('GOTRUE_EXTERNAL_GOOGLE_ENABLED', false),
    EXTERNAL_GOOGLE_CLIENT_ID: envStr('GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID', ''),
    EXTERNAL_GOOGLE_SECRET: envStr('GOTRUE_EXTERNAL_GOOGLE_SECRET', ''),
    EXTERNAL_GOOGLE_ADDITIONAL_CLIENT_IDS: envStr(
      'GOTRUE_EXTERNAL_GOOGLE_ADDITIONAL_CLIENT_IDS',
      '',
    ),
    EXTERNAL_GOOGLE_EMAIL_OPTIONAL: envBool('GOTRUE_EXTERNAL_GOOGLE_EMAIL_OPTIONAL', false),
    EXTERNAL_GOOGLE_SKIP_NONCE_CHECK: envBool('GOTRUE_EXTERNAL_GOOGLE_SKIP_NONCE_CHECK', false),
    EXTERNAL_KAKAO_ENABLED: envBool('GOTRUE_EXTERNAL_KAKAO_ENABLED', false),
    EXTERNAL_KAKAO_CLIENT_ID: envStr('GOTRUE_EXTERNAL_KAKAO_CLIENT_ID', ''),
    EXTERNAL_KAKAO_SECRET: envStr('GOTRUE_EXTERNAL_KAKAO_SECRET', ''),
    EXTERNAL_KAKAO_EMAIL_OPTIONAL: envBool('GOTRUE_EXTERNAL_KAKAO_EMAIL_OPTIONAL', false),
    EXTERNAL_KEYCLOAK_ENABLED: envBool('GOTRUE_EXTERNAL_KEYCLOAK_ENABLED', false),
    EXTERNAL_KEYCLOAK_CLIENT_ID: envStr('GOTRUE_EXTERNAL_KEYCLOAK_CLIENT_ID', ''),
    EXTERNAL_KEYCLOAK_SECRET: envStr('GOTRUE_EXTERNAL_KEYCLOAK_SECRET', ''),
    EXTERNAL_KEYCLOAK_URL: envStr('GOTRUE_EXTERNAL_KEYCLOAK_URL', ''),
    EXTERNAL_KEYCLOAK_EMAIL_OPTIONAL: envBool('GOTRUE_EXTERNAL_KEYCLOAK_EMAIL_OPTIONAL', false),
    EXTERNAL_LINKEDIN_OIDC_ENABLED: envBool('GOTRUE_EXTERNAL_LINKEDIN_OIDC_ENABLED', false),
    EXTERNAL_LINKEDIN_OIDC_CLIENT_ID: envStr('GOTRUE_EXTERNAL_LINKEDIN_OIDC_CLIENT_ID', ''),
    EXTERNAL_LINKEDIN_OIDC_SECRET: envStr('GOTRUE_EXTERNAL_LINKEDIN_OIDC_SECRET', ''),
    EXTERNAL_LINKEDIN_OIDC_EMAIL_OPTIONAL: envBool(
      'GOTRUE_EXTERNAL_LINKEDIN_OIDC_EMAIL_OPTIONAL',
      false,
    ),
    EXTERNAL_NOTION_ENABLED: envBool('GOTRUE_EXTERNAL_NOTION_ENABLED', false),
    EXTERNAL_NOTION_CLIENT_ID: envStr('GOTRUE_EXTERNAL_NOTION_CLIENT_ID', ''),
    EXTERNAL_NOTION_SECRET: envStr('GOTRUE_EXTERNAL_NOTION_SECRET', ''),
    EXTERNAL_NOTION_EMAIL_OPTIONAL: envBool('GOTRUE_EXTERNAL_NOTION_EMAIL_OPTIONAL', false),
    EXTERNAL_SLACK_ENABLED: envBool('GOTRUE_EXTERNAL_SLACK_ENABLED', false),
    EXTERNAL_SLACK_CLIENT_ID: envStr('GOTRUE_EXTERNAL_SLACK_CLIENT_ID', ''),
    EXTERNAL_SLACK_SECRET: envStr('GOTRUE_EXTERNAL_SLACK_SECRET', ''),
    EXTERNAL_SLACK_EMAIL_OPTIONAL: envBool('GOTRUE_EXTERNAL_SLACK_EMAIL_OPTIONAL', false),
    EXTERNAL_SLACK_OIDC_ENABLED: envBool('GOTRUE_EXTERNAL_SLACK_OIDC_ENABLED', false),
    EXTERNAL_SLACK_OIDC_CLIENT_ID: envStr('GOTRUE_EXTERNAL_SLACK_OIDC_CLIENT_ID', ''),
    EXTERNAL_SLACK_OIDC_SECRET: envStr('GOTRUE_EXTERNAL_SLACK_OIDC_SECRET', ''),
    EXTERNAL_SLACK_OIDC_EMAIL_OPTIONAL: envBool('GOTRUE_EXTERNAL_SLACK_OIDC_EMAIL_OPTIONAL', false),
    EXTERNAL_SPOTIFY_ENABLED: envBool('GOTRUE_EXTERNAL_SPOTIFY_ENABLED', false),
    EXTERNAL_SPOTIFY_CLIENT_ID: envStr('GOTRUE_EXTERNAL_SPOTIFY_CLIENT_ID', ''),
    EXTERNAL_SPOTIFY_SECRET: envStr('GOTRUE_EXTERNAL_SPOTIFY_SECRET', ''),
    EXTERNAL_SPOTIFY_EMAIL_OPTIONAL: envBool('GOTRUE_EXTERNAL_SPOTIFY_EMAIL_OPTIONAL', false),
    EXTERNAL_TWITCH_ENABLED: envBool('GOTRUE_EXTERNAL_TWITCH_ENABLED', false),
    EXTERNAL_TWITCH_CLIENT_ID: envStr('GOTRUE_EXTERNAL_TWITCH_CLIENT_ID', ''),
    EXTERNAL_TWITCH_SECRET: envStr('GOTRUE_EXTERNAL_TWITCH_SECRET', ''),
    EXTERNAL_TWITCH_EMAIL_OPTIONAL: envBool('GOTRUE_EXTERNAL_TWITCH_EMAIL_OPTIONAL', false),
    EXTERNAL_TWITTER_ENABLED: envBool('GOTRUE_EXTERNAL_TWITTER_ENABLED', false),
    EXTERNAL_TWITTER_CLIENT_ID: envStr('GOTRUE_EXTERNAL_TWITTER_CLIENT_ID', ''),
    EXTERNAL_TWITTER_SECRET: envStr('GOTRUE_EXTERNAL_TWITTER_SECRET', ''),
    EXTERNAL_TWITTER_EMAIL_OPTIONAL: envBool('GOTRUE_EXTERNAL_TWITTER_EMAIL_OPTIONAL', false),
    EXTERNAL_WEB3_ETHEREUM_ENABLED: envBool('GOTRUE_EXTERNAL_WEB3_ETHEREUM_ENABLED', false),
    EXTERNAL_WEB3_SOLANA_ENABLED: envBool('GOTRUE_EXTERNAL_WEB3_SOLANA_ENABLED', false),
    EXTERNAL_WORKOS_CLIENT_ID: envStr('GOTRUE_EXTERNAL_WORKOS_CLIENT_ID', ''),
    EXTERNAL_WORKOS_SECRET: envStr('GOTRUE_EXTERNAL_WORKOS_SECRET', ''),
    EXTERNAL_WORKOS_URL: envStr('GOTRUE_EXTERNAL_WORKOS_URL', ''),
    EXTERNAL_ZOOM_ENABLED: envBool('GOTRUE_EXTERNAL_ZOOM_ENABLED', false),
    EXTERNAL_ZOOM_CLIENT_ID: envStr('GOTRUE_EXTERNAL_ZOOM_CLIENT_ID', ''),
    EXTERNAL_ZOOM_SECRET: envStr('GOTRUE_EXTERNAL_ZOOM_SECRET', ''),
    EXTERNAL_ZOOM_EMAIL_OPTIONAL: envBool('GOTRUE_EXTERNAL_ZOOM_EMAIL_OPTIONAL', false),

    // Custom OAuth (Nimbus)
    CUSTOM_OAUTH_ENABLED: envBool('GOTRUE_CUSTOM_OAUTH_ENABLED', false),
    CUSTOM_OAUTH_MAX_PROVIDERS: envNum('GOTRUE_CUSTOM_OAUTH_MAX_PROVIDERS', 0),
    NIMBUS_OAUTH_CLIENT_ID: envStr('GOTRUE_NIMBUS_OAUTH_CLIENT_ID', ''),
    NIMBUS_OAUTH_CLIENT_SECRET: envStr('GOTRUE_NIMBUS_OAUTH_CLIENT_SECRET', ''),

    // Hooks
    HOOK_AFTER_USER_CREATED_ENABLED: envBool('GOTRUE_HOOK_AFTER_USER_CREATED_ENABLED', false),
    HOOK_AFTER_USER_CREATED_URI: envStr('GOTRUE_HOOK_AFTER_USER_CREATED_URI', ''),
    HOOK_AFTER_USER_CREATED_SECRETS: envStr('GOTRUE_HOOK_AFTER_USER_CREATED_SECRETS', ''),
    HOOK_BEFORE_USER_CREATED_ENABLED: envBool('GOTRUE_HOOK_BEFORE_USER_CREATED_ENABLED', false),
    HOOK_BEFORE_USER_CREATED_URI: envStr('GOTRUE_HOOK_BEFORE_USER_CREATED_URI', ''),
    HOOK_BEFORE_USER_CREATED_SECRETS: envStr('GOTRUE_HOOK_BEFORE_USER_CREATED_SECRETS', ''),
    HOOK_CUSTOM_ACCESS_TOKEN_ENABLED: envBool('GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED', false),
    HOOK_CUSTOM_ACCESS_TOKEN_URI: envStr('GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_URI', ''),
    HOOK_CUSTOM_ACCESS_TOKEN_SECRETS: envStr('GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_SECRETS', ''),
    HOOK_MFA_VERIFICATION_ATTEMPT_ENABLED: envBool(
      'GOTRUE_HOOK_MFA_VERIFICATION_ATTEMPT_ENABLED',
      false,
    ),
    HOOK_MFA_VERIFICATION_ATTEMPT_URI: envStr('GOTRUE_HOOK_MFA_VERIFICATION_ATTEMPT_URI', ''),
    HOOK_MFA_VERIFICATION_ATTEMPT_SECRETS: envStr(
      'GOTRUE_HOOK_MFA_VERIFICATION_ATTEMPT_SECRETS',
      '',
    ),
    HOOK_PASSWORD_VERIFICATION_ATTEMPT_ENABLED: envBool(
      'GOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_ENABLED',
      false,
    ),
    HOOK_PASSWORD_VERIFICATION_ATTEMPT_URI: envStr(
      'GOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_URI',
      '',
    ),
    HOOK_PASSWORD_VERIFICATION_ATTEMPT_SECRETS: envStr(
      'GOTRUE_HOOK_PASSWORD_VERIFICATION_ATTEMPT_SECRETS',
      '',
    ),
    HOOK_SEND_EMAIL_ENABLED: envBool('GOTRUE_HOOK_SEND_EMAIL_ENABLED', false),
    HOOK_SEND_EMAIL_URI: envStr('GOTRUE_HOOK_SEND_EMAIL_URI', ''),
    HOOK_SEND_EMAIL_SECRETS: envStr('GOTRUE_HOOK_SEND_EMAIL_SECRETS', ''),
    HOOK_SEND_SMS_ENABLED: envBool('GOTRUE_HOOK_SEND_SMS_ENABLED', false),
    HOOK_SEND_SMS_URI: envStr('GOTRUE_HOOK_SEND_SMS_URI', ''),
    HOOK_SEND_SMS_SECRETS: envStr('GOTRUE_HOOK_SEND_SMS_SECRETS', ''),

    INDEX_WORKER_ENSURE_USER_SEARCH_INDEXES_EXIST: envBool(
      'GOTRUE_INDEX_WORKER_ENSURE_USER_SEARCH_INDEXES_EXIST',
      false,
    ),

    // MFA
    MFA_ALLOW_LOW_AAL: envBool('GOTRUE_MFA_ALLOW_LOW_AAL', false),
    MFA_MAX_ENROLLED_FACTORS: envNum('GOTRUE_MFA_MAX_ENROLLED_FACTORS', 10),
    MFA_PHONE_ENROLL_ENABLED: envBool('GOTRUE_MFA_PHONE_ENROLL_ENABLED', false),
    MFA_PHONE_VERIFY_ENABLED: envBool('GOTRUE_MFA_PHONE_VERIFY_ENABLED', false),
    MFA_PHONE_OTP_LENGTH: envNum('GOTRUE_MFA_PHONE_OTP_LENGTH', 6),
    MFA_PHONE_MAX_FREQUENCY: envNum('GOTRUE_MFA_PHONE_MAX_FREQUENCY', 5),
    MFA_PHONE_TEMPLATE: envStr('GOTRUE_MFA_PHONE_TEMPLATE', ''),
    MFA_TOTP_ENROLL_ENABLED: envBool('GOTRUE_MFA_TOTP_ENROLL_ENABLED', true),
    MFA_TOTP_VERIFY_ENABLED: envBool('GOTRUE_MFA_TOTP_VERIFY_ENABLED', true),
    MFA_WEB_AUTHN_ENROLL_ENABLED: envBool('GOTRUE_MFA_WEB_AUTHN_ENROLL_ENABLED', false),
    MFA_WEB_AUTHN_VERIFY_ENABLED: envBool('GOTRUE_MFA_WEB_AUTHN_VERIFY_ENABLED', false),

    // OAuth server
    OAUTH_SERVER_ENABLED: envBool('GOTRUE_OAUTH_SERVER_ENABLED', false),
    OAUTH_SERVER_ALLOW_DYNAMIC_REGISTRATION: envBool(
      'GOTRUE_OAUTH_SERVER_ALLOW_DYNAMIC_REGISTRATION',
      false,
    ),
    OAUTH_SERVER_AUTHORIZATION_PATH: envStr('GOTRUE_OAUTH_SERVER_AUTHORIZATION_PATH', ''),

    // Passkey / WebAuthn
    PASSKEY_ENABLED: envBool('GOTRUE_PASSKEY_ENABLED', false),
    WEBAUTHN_RP_DISPLAY_NAME: envStr('GOTRUE_WEBAUTHN_RP_DISPLAY_NAME', ''),
    WEBAUTHN_RP_ID: envStr('GOTRUE_WEBAUTHN_RP_ID', ''),
    WEBAUTHN_RP_ORIGINS: envStr('GOTRUE_WEBAUTHN_RP_ORIGINS', ''),

    // Password
    PASSWORD_MIN_LENGTH: envNum('GOTRUE_PASSWORD_MIN_LENGTH', 6),
    PASSWORD_REQUIRED_CHARACTERS: envStr('GOTRUE_PASSWORD_REQUIRED_CHARACTERS', ''),
    PASSWORD_HIBP_ENABLED: envBool('GOTRUE_PASSWORD_HIBP_ENABLED', false),

    // Rate limits
    RATE_LIMIT_EMAIL_SENT: envNum('GOTRUE_RATE_LIMIT_EMAIL_SENT', 30),
    RATE_LIMIT_SMS_SENT: envNum('GOTRUE_RATE_LIMIT_SMS_SENT', 30),
    RATE_LIMIT_VERIFY: envNum('GOTRUE_RATE_LIMIT_VERIFY', 30),
    RATE_LIMIT_TOKEN_REFRESH: envNum('GOTRUE_RATE_LIMIT_TOKEN_REFRESH', 150),
    RATE_LIMIT_OTP: envNum('GOTRUE_RATE_LIMIT_OTP', 30),
    RATE_LIMIT_ANONYMOUS_USERS: envNum('GOTRUE_RATE_LIMIT_ANONYMOUS_USERS', 30),
    RATE_LIMIT_WEB3: envNum('GOTRUE_RATE_LIMIT_WEB3', 30),

    // DB pool
    DB_MAX_POOL_SIZE: envNum('GOTRUE_DB_MAX_POOL_SIZE', 10),
    DB_MAX_POOL_SIZE_UNIT: envStr('GOTRUE_DB_MAX_POOL_SIZE_UNIT', 'connections'),

    // SAML
    SAML_ENABLED: envBool('GOTRUE_SAML_ENABLED', false),
    SAML_ALLOW_ENCRYPTED_ASSERTIONS: envBool('GOTRUE_SAML_ALLOW_ENCRYPTED_ASSERTIONS', false),
    SAML_EXTERNAL_URL: envStr(
      'GOTRUE_SAML_EXTERNAL_URL',
      apiExternalUrl ? apiExternalUrl + '/auth/v1/sso/saml/metadata' : '',
    ),

    // Security
    SECURITY_CAPTCHA_ENABLED: envBool('GOTRUE_SECURITY_CAPTCHA_ENABLED', false),
    SECURITY_CAPTCHA_PROVIDER: envStr('GOTRUE_SECURITY_CAPTCHA_PROVIDER', 'hcaptcha'),
    SECURITY_CAPTCHA_SECRET: envStr('GOTRUE_SECURITY_CAPTCHA_SECRET', ''),
    SECURITY_MANUAL_LINKING_ENABLED: envBool('GOTRUE_SECURITY_MANUAL_LINKING_ENABLED', false),
    SECURITY_REFRESH_TOKEN_REUSE_INTERVAL: envNum(
      'GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL',
      10,
    ),
    SECURITY_SB_FORWARDED_FOR_ENABLED: envBool('GOTRUE_SECURITY_SB_FORWARDED_FOR_ENABLED', false),
    SECURITY_UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD: envBool(
      'GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD',
      false,
    ),
    SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION: envBool(
      'GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION',
      false,
    ),

    // Sessions
    SESSIONS_INACTIVITY_TIMEOUT: envNum('GOTRUE_SESSIONS_INACTIVITY_TIMEOUT', 0),
    SESSIONS_SINGLE_PER_USER: envBool('GOTRUE_SESSIONS_SINGLE_PER_USER', false),
    SESSIONS_TAGS: envStr('GOTRUE_SESSIONS_TAGS', ''),
    SESSIONS_TIMEBOX: envNum('GOTRUE_SESSIONS_TIMEBOX', 0),

    // SMS
    SMS_AUTOCONFIRM: envBool('GOTRUE_SMS_AUTOCONFIRM', envBool('ENABLE_PHONE_AUTOCONFIRM', false)),
    SMS_MAX_FREQUENCY: envNum('GOTRUE_SMS_MAX_FREQUENCY', 60),
    SMS_OTP_EXP: envNum('GOTRUE_SMS_OTP_EXP', 60),
    SMS_OTP_LENGTH: envNum('GOTRUE_SMS_OTP_LENGTH', 6),
    SMS_PROVIDER: envStr('GOTRUE_SMS_PROVIDER', 'twilio'),
    SMS_TEMPLATE: envStr('GOTRUE_SMS_TEMPLATE', ''),
    SMS_TEST_OTP: envStr('GOTRUE_SMS_TEST_OTP', ''),
    SMS_TEST_OTP_VALID_UNTIL: envStr('GOTRUE_SMS_TEST_OTP_VALID_UNTIL', ''),
    SMS_MESSAGEBIRD_ACCESS_KEY: envStr('GOTRUE_SMS_MESSAGEBIRD_ACCESS_KEY', ''),
    SMS_MESSAGEBIRD_ORIGINATOR: envStr('GOTRUE_SMS_MESSAGEBIRD_ORIGINATOR', ''),
    SMS_TEXTLOCAL_API_KEY: envStr('GOTRUE_SMS_TEXTLOCAL_API_KEY', ''),
    SMS_TEXTLOCAL_SENDER: envStr('GOTRUE_SMS_TEXTLOCAL_SENDER', ''),
    SMS_TWILIO_ACCOUNT_SID: envStr('GOTRUE_SMS_TWILIO_ACCOUNT_SID', ''),
    SMS_TWILIO_AUTH_TOKEN: envStr('GOTRUE_SMS_TWILIO_AUTH_TOKEN', ''),
    SMS_TWILIO_CONTENT_SID: envStr('GOTRUE_SMS_TWILIO_CONTENT_SID', ''),
    SMS_TWILIO_MESSAGE_SERVICE_SID: envStr('GOTRUE_SMS_TWILIO_MESSAGE_SERVICE_SID', ''),
    SMS_TWILIO_VERIFY_ACCOUNT_SID: envStr('GOTRUE_SMS_TWILIO_VERIFY_ACCOUNT_SID', ''),
    SMS_TWILIO_VERIFY_AUTH_TOKEN: envStr('GOTRUE_SMS_TWILIO_VERIFY_AUTH_TOKEN', ''),
    SMS_TWILIO_VERIFY_MESSAGE_SERVICE_SID: envStr(
      'GOTRUE_SMS_TWILIO_VERIFY_MESSAGE_SERVICE_SID',
      '',
    ),
    SMS_VONAGE_API_KEY: envStr('GOTRUE_SMS_VONAGE_API_KEY', ''),
    SMS_VONAGE_API_SECRET: envStr('GOTRUE_SMS_VONAGE_API_SECRET', ''),
    SMS_VONAGE_FROM: envStr('GOTRUE_SMS_VONAGE_FROM', ''),
  }
}

// ── Override table access ────────────────────────────────────────────────────

export async function getOverrides(
  pool: Pool,
  projectRef: string,
): Promise<Record<string, unknown>> {
  const connection = await pool.connect()
  try {
    const result = await connection.queryObject<{ config_key: string; config_value: unknown }>`
      SELECT config_key, config_value FROM traffic.auth_config_overrides
      WHERE project_ref = ${projectRef}
    `
    const overrides: Record<string, unknown> = {}
    for (const row of result.rows) {
      overrides[row.config_key] = row.config_value
    }
    return overrides
  } finally {
    connection.release()
  }
}

export interface AuthConfigAuditContext {
  email: string
  ip: string
  method: string
  route: string
}

// Upsert overrides in a single transaction. Null values clear the override
// (so the subsequent GET falls back to the env-derived default). Audit log
// records the keys touched, never the values — secrets must not land in
// traffic.audit_logs.action_metadata in plaintext.
export async function upsertOverrides(
  pool: Pool,
  projectRef: string,
  overrides: Record<string, unknown>,
  gotrueId: string,
  profileId: number,
  auditContext?: AuthConfigAuditContext,
): Promise<void> {
  const keys = Object.keys(overrides)
  if (keys.length === 0) return

  const connection = await pool.connect()
  try {
    const tx = connection.createTransaction('auth_config_upsert')
    await tx.begin()

    for (const key of keys) {
      const value = overrides[key]
      if (value === null) {
        await tx.queryObject`
          DELETE FROM traffic.auth_config_overrides
          WHERE project_ref = ${projectRef} AND config_key = ${key}
        `
        continue
      }
      await tx.queryObject`
        INSERT INTO traffic.auth_config_overrides
          (project_ref, config_key, config_value, updated_at)
        VALUES
          (${projectRef}, ${key}, ${JSON.stringify(value)}::jsonb, now())
        ON CONFLICT (project_ref, config_key)
        DO UPDATE SET config_value = EXCLUDED.config_value, updated_at = now()
      `
    }

    if (auditContext) {
      await tx.queryObject`
        INSERT INTO traffic.audit_logs (
          id, profile_id, action_name, action_metadata,
          actor_id, actor_type, actor_metadata,
          target_description, target_metadata, occurred_at
        ) VALUES (
          gen_random_uuid(), ${profileId}, 'auth_config.update',
          ${
        JSON.stringify([{ method: auditContext.method, route: auditContext.route, status: 200 }])
      }::jsonb,
          ${gotrueId}, 'user',
          ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
          ${'auth_config ' + projectRef}, ${JSON.stringify({ keys })}::jsonb, now()
        )
      `
    }

    await tx.commit()
  } finally {
    connection.release()
  }
}

// ── GoTrue admin HTTP proxy ─────────────────────────────────────────────────
//
// Real HTTP calls to the GoTrue admin endpoints for a single project's
// backend. The URL is derived from `ProjectBackend.endpoint` (so per-project
// stacks resolve through Kong's auth-v1 rule on their own gateway, and the
// shared Docker stack routes through `http://kong:8000/auth/v1/...`). The
// admin JWT is `ProjectBackend.serviceKey` — which is itself a
// `role: service_role` HS256 JWT signed with the project's JWT_SECRET, so
// there's no need to sign a fresh token at call-time.
//
// Endpoint coverage is pragmatic: this self-hosted GoTrue build does not
// necessarily expose a live-mutation `POST /admin/config` endpoint. We call
// it anyway and treat a 404 / 501 / network error as "not supported", falling
// back to the override table (traffic.auth_config_overrides). `GET /admin/
// settings` is similarly optional — if it succeeds we merge its values on top
// of the env-derived defaults (live wins over env), and any override from the
// DB wins over live.

// L9: `buildServiceRoleJwt` / `base64UrlEncode` were removed from this file.
//
// They predated the project-backend refactor and signed an HS256 token from
// `JWT_SECRET` on demand. Every production caller now receives a signed
// `service_role` key via `getProjectBackend(ref).serviceKey`, so the only
// consumers left were the unit tests that covered the helper itself. That
// circular cover-yourself test was creating a false sense of "JWT plumbing
// is tested" without exercising any real callsite, so we dropped both the
// helper and its tests — see `tests/services/gotrue-admin-service-test.ts`.
// Future callers that need a service-role JWT without a pre-resolved backend
// should use `jose` (already in the import map) directly rather than
// re-introducing a bespoke signer here.

// Injectable fetch hook so tests can stub GoTrue without network access.
export type FetchLike = typeof fetch

// Attempts `GET {backend.endpoint}/auth/v1/admin/settings`. Returns the parsed
// JSON body on 2xx, or `null` if the endpoint is not available (404/501) or
// the request fails. Non-throwing: callers always get defaults + overrides
// as the safety net.
export async function fetchLiveSettings(
  backend: ProjectBackend,
  fetchImpl: FetchLike = fetch,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetchProjectJson(
      backend,
      '/auth/v1/admin/settings',
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
      },
      fetchImpl,
    )
    if (!res.ok) {
      await res.body?.cancel()
      return null
    }
    const body = await res.json().catch(() => null)
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      return body as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

export interface PushLiveConfigResult {
  accepted: string[]
  rejected: string[]
}

// Attempts `POST {backend.endpoint}/auth/v1/admin/config` with the full patch
// body. Returns which keys GoTrue accepted (so callers can skip writing them
// to the override table) and which it rejected (so they still get persisted
// as overrides).
//
// A full endpoint failure (404 / network / 5xx) is treated as "nothing
// accepted" — every key lands in overrides, preserving Wave-1 behavior.
export async function pushLiveConfig(
  backend: ProjectBackend,
  patch: Record<string, unknown>,
  fetchImpl: FetchLike = fetch,
): Promise<PushLiveConfigResult> {
  const keys = Object.keys(patch)
  const noneAccepted: PushLiveConfigResult = { accepted: [], rejected: keys }

  let res: Response
  try {
    res = await fetchProjectJson(
      backend,
      '/auth/v1/admin/config',
      {
        method: 'POST',
        body: JSON.stringify(patch),
      },
      fetchImpl,
    )
  } catch {
    return noneAccepted
  }
  if (!res.ok) {
    await res.body?.cancel()
    return noneAccepted
  }
  const parsed = await res.json().catch(() => null)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    // 200 with empty/opaque body — assume GoTrue accepted everything.
    return { accepted: keys, rejected: [] }
  }
  const body = parsed as { accepted?: unknown; rejected?: unknown }
  const accepted = Array.isArray(body.accepted)
    ? body.accepted.filter((k): k is string => typeof k === 'string')
    : []
  const rejected = Array.isArray(body.rejected)
    ? body.rejected.filter((k): k is string => typeof k === 'string')
    : []
  // If GoTrue didn't tell us which keys it took, default to "took
  // everything" so overrides don't accumulate stale shadows of live values.
  if (accepted.length === 0 && rejected.length === 0) {
    return { accepted: keys, rejected: [] }
  }
  return { accepted, rejected }
}

// ── Merged config read ───────────────────────────────────────────────────────

// Internal helper: pure layering of already-fetched inputs. Lives here so
// `getMergedConfig` and `applyConfigPatch` can share the exact same merge +
// redaction logic without either one double-fetching the live settings.
function mergeLayers(
  defaults: Record<string, unknown>,
  live: Record<string, unknown> | null,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...defaults,
    ...(live ?? {}),
    ...overrides,
  }
  const redacted: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(merged)) {
    redacted[k] = redactValue(k, v)
  }
  return redacted
}

// Returns defaults + live-settings + overrides (earlier wins loser, overrides
// take final precedence) with secret fields redacted. Never emits the
// plaintext value of any *_SECRET / *_SECRETS / *_PASS / *_PASSWORD field.
export async function getMergedConfig(
  pool: Pool,
  backend: ProjectBackend,
  fetchImpl: FetchLike = fetch,
): Promise<Record<string, unknown>> {
  const defaults = getDefaultConfig()
  const live = await fetchLiveSettings(backend, fetchImpl)
  const overrides = await getOverrides(pool, backend.ref)
  return mergeLayers(defaults, live, overrides)
}

// ── PATCH: live push + overrides fallback ───────────────────────────────────
//
// Mirrors upsertOverrides' signature but first tries to push the patch live
// to GoTrue. Keys GoTrue accepts are NOT written to the override table (so
// GET reflects the live value on the next request). Keys GoTrue rejects, or
// every key if the live endpoint is unavailable, fall back to overrides —
// preserving the Wave-1 "Studio sees its own writes" contract.
//
// M13: this function now also returns the post-patch merged view. The old
// shape had `handleAuthConfig` call `applyConfigPatch(...)` and then
// immediately call `getMergedConfig(...)` — which re-fetched
// `/auth/v1/admin/settings` for a second time in the same request. We now
// fetch live settings ONCE, up front, and synthesize the post-push live
// state by overlaying the patch values that GoTrue accepted. Net change:
// no more duplicate GET, semantics identical (defaults ≺ live ≺ overrides
// with secret fields redacted).
export async function applyConfigPatch(
  pool: Pool,
  backend: ProjectBackend,
  patch: Record<string, unknown>,
  gotrueId: string,
  profileId: number,
  auditContext?: AuthConfigAuditContext,
  fetchImpl: FetchLike = fetch,
): Promise<{ accepted: string[]; overridden: string[]; merged: Record<string, unknown> }> {
  const defaults = getDefaultConfig()
  const keys = Object.keys(patch)

  // Empty patch: nothing to push, nothing to audit. Still return the
  // current merged view so callers get a consistent response shape.
  if (keys.length === 0) {
    const live = await fetchLiveSettings(backend, fetchImpl)
    const overrides = await getOverrides(pool, backend.ref)
    return { accepted: [], overridden: [], merged: mergeLayers(defaults, live, overrides) }
  }

  // Single fetch of the pre-push live state; reused below to compose the
  // post-push merged view without a second GoTrue round-trip.
  const prePushLive = await fetchLiveSettings(backend, fetchImpl)

  const pushResult = await pushLiveConfig(backend, patch, fetchImpl)
  const acceptedSet = new Set(pushResult.accepted)
  const overrideBody: Record<string, unknown> = {}
  for (const k of keys) {
    if (!acceptedSet.has(k)) overrideBody[k] = patch[k]
  }

  if (Object.keys(overrideBody).length > 0) {
    await upsertOverrides(pool, backend.ref, overrideBody, gotrueId, profileId, auditContext)
  } else if (auditContext) {
    // Everything went live — still audit the operation.
    const connection = await pool.connect()
    try {
      await connection.queryObject`
        INSERT INTO traffic.audit_logs (
          id, profile_id, action_name, action_metadata,
          actor_id, actor_type, actor_metadata,
          target_description, target_metadata, occurred_at
        ) VALUES (
          gen_random_uuid(), ${profileId}, 'auth_config.update',
          ${
        JSON.stringify([
          {
            method: auditContext.method,
            route: auditContext.route,
            status: 200,
          },
        ])
      }::jsonb,
          ${gotrueId}, 'user',
          ${JSON.stringify([{ email: auditContext.email, ip: auditContext.ip }])}::jsonb,
          ${'auth_config ' + backend.ref},
          ${JSON.stringify({ keys, live: true })}::jsonb,
          now()
        )
      `
    } finally {
      connection.release()
    }
  }

  // Compose the post-push live state: start with whatever GoTrue returned
  // before the push (may be null when the admin endpoint is unavailable)
  // and overlay any keys GoTrue just accepted. For rejected keys the
  // `overrides` read below will have captured the new value, so leaving
  // live untouched for them is correct.
  const postPushLive: Record<string, unknown> | null = prePushLive !== null || acceptedSet.size > 0
    ? {
      ...(prePushLive ?? {}),
      ...Object.fromEntries(
        [...acceptedSet]
          .filter((k) => Object.prototype.hasOwnProperty.call(patch, k))
          .map((k) => [k, patch[k]]),
      ),
    }
    : null

  const overrides = await getOverrides(pool, backend.ref)
  const merged = mergeLayers(defaults, postPushLive, overrides)

  return {
    accepted: [...acceptedSet],
    overridden: Object.keys(overrideBody),
    merged,
  }
}
