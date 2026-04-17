import { useRouter } from 'next/router'

import AlertError from '@/components/ui/AlertError'
import { OrganizationInviteByToken } from '@/data/organization-members/organization-invitation-token-query'
import { useSignOut } from '@/lib/auth'
import { useProfile } from '@/lib/profile'
import type { ResponseError } from '@/types'

interface OrganizationInviteError {
  data?: OrganizationInviteByToken
  error?: ResponseError | null
  isError: boolean
}

export const OrganizationInviteError = ({ data, error, isError }: OrganizationInviteError) => {
  const router = useRouter()
  const signOut = useSignOut()
  const { profile } = useProfile()

  if (isError) {
    return (
      <div className="p-6">
        <AlertError error={error} subject="Failed to retrieve token" />
      </div>
    )
  }

  if (!data?.email_match) {
    return (
      <div className="flex flex-col gap-2 p-6 text-sm">
        <p className="text-foreground-light">
          Your email address {profile?.primary_email} does not match the email address this
          invitation was sent to.
        </p>
        <p className="text-foreground-lighter">
          To accept this invitation, you will need to{' '}
          <a
            className="cursor-pointer text-brand"
            onClick={async () => {
              await signOut()
              router.reload()
            }}
          >
            sign out
          </a>{' '}
          and sign in using the same email address as the invitation.
        </p>
      </div>
    )
  }

  if (data.expired_token) {
    return (
      <div className="flex flex-col gap-1 p-6 text-sm">
        <p className="text-foreground-light">The invite token has expired.</p>
        <p className="text-foreground-lighter">
          Please request a new one from the organization owner.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1 p-6 text-sm">
      <p className="text-foreground-light">The invite token is invalid.</p>
      <p className="text-foreground-lighter">
        You could be logged in with the wrong account. Try copying and pasting the link from the
        invite email, or ask the organization owner to invite you again.
      </p>
    </div>
  )
}
