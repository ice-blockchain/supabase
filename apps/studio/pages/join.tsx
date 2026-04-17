import { OrganizationInvite } from '@/components/interfaces/OrganizationInvite/OrganizationInvite'
import { InterstitialLayout, SupabaseLogo } from '@/components/layouts/InterstitialLayout'
import type { NextPageWithLayout } from '@/types'

const JoinOrganizationPage: NextPageWithLayout = () => {
  return <OrganizationInvite />
}

JoinOrganizationPage.getLayout = (page) => (
  <InterstitialLayout
    logo={<SupabaseLogo />}
    title="Organization Invitation"
    description="You have been invited to join an organization"
  >
    {page}
  </InterstitialLayout>
)

export default JoinOrganizationPage
