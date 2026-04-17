import { useQuery } from '@tanstack/react-query'
import { useParams } from 'common'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { useRouter } from 'next/router'
import { useEffect, useState } from 'react'
import { Button, LogoLoader } from 'ui'

import {
  InterstitialLayout,
  LogoPair,
  SupabaseSymbol,
} from '@/components/layouts/InterstitialLayout'
import { useConfirmAccountRequestMutation } from '@/data/partners/stripe-projects-confirm-mutation'
import { accountRequestQueryOptions } from '@/data/partners/stripe-projects-query'
import { withAuth } from '@/hooks/misc/withAuth'
import { useSignOut } from '@/lib/auth'
import { BASE_PATH } from '@/lib/constants'
import { useProfileNameAndPicture } from '@/lib/profile'
import type { NextPageWithLayout } from '@/types'

const StripeIcon = () => (
  <img
    src={`${BASE_PATH}/img/icons/stripe-icon.svg`}
    alt="Stripe"
    className="size-7"
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
  const { username, primaryEmail } = useProfileNameAndPicture()

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

  const displayName = username ?? primaryEmail ?? ''
  const initial = displayName.charAt(0).toUpperCase()

  return (
    <>
      {isMockMode && (
        <div className="fixed right-3 top-3 z-50 rounded border border-dashed border-warning bg-warning/10 px-2 py-1 font-mono text-xs text-warning-600">
          mock: {mockParam}
        </div>
      )}

      <div className="px-6 pb-6">
        {/* Loading */}
        {(effectiveIsPending || effectiveIsConfirming) && (
          <div className="flex flex-col items-center gap-3 py-4">
            <LogoLoader />
            {effectiveIsConfirming && (
              <p className="text-sm text-foreground-light">
                {linkedOrg ? 'Completing authorization...' : 'Creating your organization...'}
              </p>
            )}
          </div>
        )}

        {/* Success */}
        {effectiveIsConfirmed && (
          <div className="py-4 text-center">
            <div className="mb-4 flex justify-center">
              <div className="flex size-14 items-center justify-center rounded-full bg-emerald-100">
                <CheckCircle2 className="size-7 text-emerald-600" />
              </div>
            </div>
            <p className="text-lg font-semibold text-foreground">Stripe connected</p>
            <p className="mt-1 text-sm text-foreground-light">You can close this tab.</p>
          </div>
        )}

        {/* Wrong account */}
        {effectiveIsSuccess && !emailMatches && (
          <div className="flex flex-col gap-3">
            <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
              <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-600" />
              <div>
                <p className="text-sm font-medium text-amber-900">Wrong account</p>
                <p className="mt-1 text-sm text-amber-700">
                  Sign in as{' '}
                  <span className="font-medium">{effectiveAccountRequest?.email}</span> to
                  continue.
                </p>
              </div>
            </div>
            <Button type="default" block onClick={() => signOut()}>
              Sign out
            </Button>
          </div>
        )}

        {/* Linked — org already connected */}
        {effectiveIsSuccess && emailMatches && linkedOrg && (
          <div className="flex flex-col gap-3">
            <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
              <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" />
              <div>
                <p className="text-sm font-medium text-emerald-900">Already connected</p>
                <p className="mt-1 text-sm text-emerald-800">
                  <span className="font-medium">{linkedOrg.name}</span> is linked to this Stripe
                  account.
                </p>
              </div>
            </div>
            <Button type="primary" block loading={effectiveIsConfirming} onClick={handleApprove}>
              Continue to dashboard
            </Button>
            <Button type="text" block onClick={() => router.back()}>
              Cancel
            </Button>
          </div>
        )}

        {/* Pending — new org will be created */}
        {effectiveIsSuccess && emailMatches && !linkedOrg && (
          <div className="flex flex-col gap-3">
            {/* Signed-in-as row */}
            <div className="flex items-center gap-3 rounded-lg border border-muted p-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
                <span className="text-sm font-medium text-foreground">{initial}</span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-foreground-light">Signed in as</p>
                <p className="truncate text-sm font-medium text-foreground">{displayName}</p>
              </div>
              <Button
                type="primary"
                loading={effectiveIsConfirming}
                disabled={effectiveIsConfirming}
                onClick={handleApprove}
              >
                Continue
              </Button>
            </div>

            {/* "or" divider */}
            <div className="relative my-1">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-muted" />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="bg-surface-100 px-2 text-foreground-muted">or</span>
              </div>
            </div>

            <Button type="default" block onClick={() => signOut()}>
              Use a different account
            </Button>

            <p className="text-center text-xs text-foreground-muted">
              A new Supabase organization will be created and linked to your Stripe account.
            </p>
          </div>
        )}

        {/* Error */}
        {effectiveIsError && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-foreground-light">{error?.message}</p>
            <Button type="default" block onClick={() => signOut()}>
              Sign out
            </Button>
          </div>
        )}
      </div>
    </>
  )
}

StripeProjectsLoginPage.getLayout = (page) => (
  <InterstitialLayout
    logo={<LogoPair left={<StripeIcon />} right={<SupabaseSymbol className="size-7" />} />}
    title="Stripe"
    description="Connect a Supabase organization"
  >
    {page}
  </InterstitialLayout>
)

export default withAuth(StripeProjectsLoginPage)
