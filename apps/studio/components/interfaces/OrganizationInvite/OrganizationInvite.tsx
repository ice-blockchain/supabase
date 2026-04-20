import { useIsLoggedIn, useParams } from 'common'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { toast } from 'sonner'
import { Button, Separator } from 'ui'
import { GenericSkeletonLoader } from 'ui-patterns'

import { OrganizationInviteError } from './OrganizationInviteError'
import { ProfileImage } from '@/components/ui/ProfileImage'
import { useOrganizationAcceptInvitationMutation } from '@/data/organization-members/organization-invitation-accept-mutation'
import { useOrganizationInvitationTokenQuery } from '@/data/organization-members/organization-invitation-token-query'
import { useIsFeatureEnabled } from '@/hooks/misc/useIsFeatureEnabled'
import { useProfile, useProfileNameAndPicture } from '@/lib/profile'

export const OrganizationInvite = () => {
  const router = useRouter()
  const isLoggedIn = useIsLoggedIn()
  const { profile, isLoading: isLoadingProfile } = useProfile()
  const { username, avatarUrl, primaryEmail } = useProfileNameAndPicture()
  const { slug, token } = useParams()

  const isSignUpEnabled = useIsFeatureEnabled('dashboard_auth:sign_up')

  const {
    data,
    error,
    isSuccess: isSuccessInvitation,
    isError: isErrorInvitation,
    isPending: isLoadingInvitation,
  } = useOrganizationInvitationTokenQuery(
    { slug, token },
    {
      retry: false,
      refetchOnWindowFocus: false,
      enabled: !!profile,
    }
  )
  const hasError =
    isErrorInvitation ||
    (isSuccessInvitation && (data.token_does_not_exist || data.expired_token || !data.email_match))
  const inviteIsNoLongerValid =
    error?.code === 401 && error?.message.includes('Failed to retrieve organization')

  const organizationName = isSuccessInvitation ? data?.organization_name : 'an organization'
  const loginRedirectLink = `/sign-in?returnTo=${encodeURIComponent(`/join?token=${token}&slug=${slug}`)}`
  const signupRedirectLink = `/sign-up?returnTo=${encodeURIComponent(`/join?token=${token}&slug=${slug}`)}`

  const { mutate: joinOrganization, isPending: isJoining } =
    useOrganizationAcceptInvitationMutation({
      onSuccess: () => {
        router.push('/organizations')
      },
      onError: (error) => {
        toast.error(`Failed to join organization: ${error.message}`)
      },
    })

  async function handleJoinOrganization() {
    if (!slug) return console.error('Slug is required')
    if (!token) return console.error('Token is required')
    joinOrganization({ slug, token })
  }

  if (!isLoggedIn || (!profile && !isLoadingProfile)) {
    return (
      <div className="flex flex-col gap-4 p-6">
        <p className="text-sm text-foreground-light text-center">
          Sign in{isSignUpEnabled ? ' or create an account' : ''} to view this invitation
        </p>
        <div className="flex gap-3 justify-center">
          <Button asChild type="default">
            <Link href={loginRedirectLink}>Sign in</Link>
          </Button>
          {isSignUpEnabled && (
            <Button asChild type="default">
              <Link href={signupRedirectLink}>Create an account</Link>
            </Button>
          )}
        </div>
      </div>
    )
  }

  if (isLoadingProfile || isLoadingInvitation) {
    return (
      <div className="p-6">
        <GenericSkeletonLoader />
      </div>
    )
  }

  if (inviteIsNoLongerValid) {
    return (
      <div className="flex flex-col gap-4 p-6 text-center">
        <p className="text-sm text-foreground-light">
          This organization invite is no longer valid as it has either been accepted or declined.
        </p>
        <Button type="default" asChild>
          <Link href="/">Back to dashboard</Link>
        </Button>
      </div>
    )
  }

  if (hasError) {
    return <OrganizationInviteError data={data} error={error} isError={isErrorInvitation} />
  }

  return (
    <div className="flex flex-col gap-3 p-6">
      <p className="text-center text-sm text-foreground-light">
        You have been invited to join{' '}
        <strong className="text-foreground">{organizationName}</strong>
      </p>

      {/* Signed-in-as user card */}
      <div className="flex items-center justify-between gap-3 rounded-md border border-muted bg-surface-200 px-4 py-3">
        <div className="flex items-center gap-3">
          <ProfileImage
            src={avatarUrl}
            alt={username}
            className="h-8 w-8 flex-shrink-0 rounded-md"
          />
          <div className="flex flex-col">
            <span className="text-sm text-foreground-light">Signed in as</span>
            <span className="text-sm font-medium text-foreground">{username ?? primaryEmail}</span>
          </div>
        </div>
        <Button
          type="primary"
          loading={isJoining}
          disabled={isJoining}
          onClick={handleJoinOrganization}
        >
          Accept
        </Button>
      </div>

      <Separator />

      <Button asChild type="text" block>
        <Link href="/projects">Decline</Link>
      </Button>
    </div>
  )
}
