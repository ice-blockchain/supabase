import { OrganizationInvite } from '@/components/interfaces/OrganizationInvite/OrganizationInvite'
import {
  InterstitialLayout,
  LogoBox,
  SupabaseSymbol,
} from '@/components/layouts/InterstitialLayout'
import type { NextPageWithLayout } from '@/types'

const JoinOrganizationPage: NextPageWithLayout = () => {
  return <OrganizationInvite />
}

JoinOrganizationPage.getLayout = (page) => (
  <InterstitialLayout
    logo={
      <LogoBox>
        <SupabaseSymbol className="size-7" />
      </LogoBox>
    }
    title="Organization Invitation"
    description="You have been invited to join an organization"
  >
    {page}
  </InterstitialLayout>
)

export default JoinOrganizationPage
