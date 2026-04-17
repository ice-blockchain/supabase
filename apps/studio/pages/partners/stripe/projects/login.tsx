import { useQuery } from '@tanstack/react-query'
import { useParams } from 'common'
import { useRouter } from 'next/router'
import { useEffect, useState } from 'react'
import {
  Alert_Shadcn_,
  AlertDescription_Shadcn_,
  AlertTitle_Shadcn_,
  Button,
  LogoLoader,
  Separator,
  WarningIcon,
} from 'ui'

import {
  InterstitialLayout,
  LogoPair,
  SupabaseLogo,
} from '@/components/layouts/InterstitialLayout'
import { useConfirmAccountRequestMutation } from '@/data/partners/stripe-projects-confirm-mutation'
import { accountRequestQueryOptions } from '@/data/partners/stripe-projects-query'
import { withAuth } from '@/hooks/misc/withAuth'
import { useSignOut } from '@/lib/auth'
import { BASE_PATH } from '@/lib/constants'
import { useProfileNameAndPicture } from '@/lib/profile'
import { ProfileImage } from '@/components/ui/ProfileImage'
import type { NextPageWithLayout } from '@/types'

const StripeIcon = () => (
  <img
    src={`${BASE_PATH}/img/icons/stripe-icon.svg`}
    alt="Stripe"
    width={40}
    height={40}
    className="rounded-md"
  />
)

// ---------------------------------------------------------------------------
// Mock data — design review only
// Navigate to /partners/stripe/projects/login?mock=<state> to preview each UI state.
// States: pending | linked | wrong-account | success
// ---------------------------------------------------------------------------
const MOCK_RESPONSES = {
  pending: {
    id: 'mock',
    email: 'jane@acmecorp.io',
    email_matches: true,
    status: 'pending' as const,
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    linked_organization: undefined,
  },
  linked: {
    id: 'mock',
    email: 'jane@acmecorp.io',
    email_matches: true,
    status: 'pending' as const,
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    linked_organization: { id: 42, name: 'Acme Corp', slug: 'acme-corp' },
  },
  'wrong-account': {
    id: 'mock',
    email: 'jane@acmecorp.io',
    email_matches: false,
    status: 'pending' as const,
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    linked_organization: undefined,
  },
  success: {
    id: 'mock',
    email: 'jane@acmecorp.io',
    email_matches: true,
    status: 'complete' as const,
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    linked_organization: undefined,
  },
}

type MockState = keyof typeof MOCK_RESPONSES

const StripeProjectsLoginPage: NextPageWithLayout = () => {
  const router = useRouter()
  const { ar_id } = useParams()

  const signOut = useSignOut()
  const { username, avatarUrl, primaryEmail } = useProfileNameAndPicture()

  const mockParam = router.query.mock as MockState | undefined
  const isMockMode = !!mockParam && mockParam in MOCK_RESPONSES

  const [mockConfirming, setMockConfirming] = useState(false)
  const [mockConfirmed, setMockConfirmed] = useState(false)

  const {
    data: accountRequest,
    isPending,
    isSuccess,
    isError,
    error,
  } = useQuery({
    ...accountRequestQueryOptions({ arId: ar_id }),
    enabled: !isMockMode && typeof ar_id !== 'undefined',
  })

  const {
    mutate: confirmAccountRequest,
    isPending: isConfirming,
    isSuccess: isConfirmed,
  } = useConfirmAccountRequestMutation()

  useEffect(() => {
    if (!router.isReady) return
    if (isMockMode) return

    if (!ar_id) {
      router.push('/404')
      return
    }
  }, [router.isReady, ar_id, isMockMode, router])

  const handleApprove = async () => {
    if (isMockMode) {
      setMockConfirming(true)
      setTimeout(() => {
        setMockConfirming(false)
        setMockConfirmed(true)
      }, 1200)
      return
    }
    if (!ar_id || isConfirming) return
    confirmAccountRequest({ arId: ar_id })
  }

  // Overlay real state with mock values when in mock mode
  const effectiveAccountRequest = isMockMode
    ? MOCK_RESPONSES[mockParam as MockState]
    : accountRequest
  const effectiveIsPending = isMockMode ? false : isPending
  const effectiveIsSuccess = isMockMode ? mockParam !== 'success' : isSuccess
  const effectiveIsConfirmed = isMockMode ? mockParam === 'success' || mockConfirmed : isConfirmed
  const effectiveIsConfirming = isMockMode ? mockConfirming : isConfirming
  const effectiveIsError = isMockMode ? false : isError

  const linkedOrg = effectiveAccountRequest?.linked_organization
  const emailMatches = effectiveAccountRequest?.email_matches ?? false

  const loadingText = linkedOrg ? 'Completing authorization...' : 'Creating your organization...'

  return (
    <>
      {isMockMode && (
        <div className="fixed top-3 right-3 z-50 rounded border border-dashed border-warning bg-warning/10 px-2 py-1 font-mono text-xs text-warning-600">
          mock: {mockParam}
        </div>
      )}
      <div className="flex min-h-[280px] flex-col items-center justify-center gap-4 p-6">
        {effectiveIsConfirming ? (
          <>
            <LogoLoader />
            <p className="text-sm text-foreground-light">{loadingText}</p>
          </>
        ) : effectiveIsConfirmed ? (
          <div className="flex flex-col items-center gap-2 text-center">
            <p className="text-base font-medium text-foreground">Authorization complete</p>
            <p className="text-sm text-foreground-muted">You can now close this window</p>
          </div>
        ) : effectiveIsPending ? (
          <LogoLoader />
        ) : effectiveIsSuccess ? (
          <>
            {!emailMatches ? (
              <div className="flex w-full flex-col gap-4">
                <Alert_Shadcn_ variant="warning">
                  <WarningIcon />
                  <AlertTitle_Shadcn_>Wrong account</AlertTitle_Shadcn_>
                  <AlertDescription_Shadcn_>
                    You're signed in as a different account. Sign out and sign back in as{' '}
                    <strong>{effectiveAccountRequest.email}</strong>, then return to Stripe to
                    restart the request.
                  </AlertDescription_Shadcn_>
                </Alert_Shadcn_>
                <Button size="large" type="primary" block onClick={() => signOut()}>
                  Sign out
                </Button>
              </div>
            ) : (
              <div className="flex w-full flex-col gap-3">
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
                      <span className="text-sm font-medium text-foreground">
                        {username ?? primaryEmail}
                      </span>
                    </div>
                  </div>
                  <Button
                    size="medium"
                    type="primary"
                    loading={effectiveIsConfirming}
                    disabled={effectiveIsConfirming}
                    onClick={handleApprove}
                  >
                    Authorize
                  </Button>
                </div>

                {/* Footer note */}
                {!linkedOrg && (
                  <p className="text-center text-xs text-foreground-lighter">
                    Approving will create a new Supabase organization linked to your Stripe account.
                  </p>
                )}
                {linkedOrg && (
                  <p className="text-center text-xs text-foreground-lighter">
                    <strong>{linkedOrg.name}</strong> is already connected to your Stripe account.
                    Confirm to complete the request.
                  </p>
                )}

                <Separator />

                <Button size="large" type="text" block onClick={() => signOut()}>
                  Use a different account
                </Button>
              </div>
            )}
          </>
        ) : effectiveIsError ? (
          <div className="flex w-full flex-col gap-4">
            <p className="text-sm text-foreground-light">{error?.message}</p>
            <Button size="large" type="default" block onClick={() => signOut()}>
              Sign out
            </Button>
          </div>
        ) : null}
      </div>
    </>
  )
}

StripeProjectsLoginPage.getLayout = (page) => (
  <InterstitialLayout
    logo={
      <LogoPair
        left={<StripeIcon />}
        right={<SupabaseLogo className="h-[24px]" />}
      />
    }
    title="Stripe Projects"
    description="Connect a Supabase organization"
  >
    {page}
  </InterstitialLayout>
)

export default withAuth(StripeProjectsLoginPage)
