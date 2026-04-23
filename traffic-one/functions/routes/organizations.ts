import type { Pool } from 'https://deno.land/x/postgres@v0.17.0/mod.ts'

import { corsHeaders } from '../index.ts'
import {
  createSSOProvider,
  deleteSSOProvider,
  getOrgAuditLogs,
  getSSOProvider,
  updateSSOProvider,
} from '../services/org-settings.service.ts'
import {
  createOrganization,
  deleteOrganization,
  generateSlugBase,
  getOrganizationBySlug,
  listOrganizations,
  updateOrganization,
} from '../services/organization.service.ts'
import { listOrgProjects } from '../services/project.service.ts'
import { getOrgDailyUsage, getOrgUsage } from '../services/usage.service.ts'
import type { CreateOrganizationBody } from '../types/api.ts'
import { getClientIp } from '../utils/client-ip.ts'
import { handleBilling } from './billing.ts'
import { handleMembers } from './members.ts'

const COMPLIANCE_DOC_TYPES = new Set([
  'standard-security-questionnaire',
  'soc2-type-2-report',
  'iso27001-certificate',
])

export async function handleOrganizations(
  req: Request,
  path: string,
  method: string,
  pool: Pool,
  profileId: number,
  gotrueId: string,
  email: string
): Promise<Response> {
  const ip = getClientIp(req)
  const auditContext = { email, ip, method, route: '/organizations' + path }

  // GET /organizations — list all user's orgs
  if (path === '/' && method === 'GET') {
    const orgs = await listOrganizations(pool, profileId)
    return Response.json(orgs, { headers: corsHeaders })
  }

  // POST /organizations — create org
  if (path === '/' && method === 'POST') {
    const body: CreateOrganizationBody = await req.json()
    if (!body.name) {
      return Response.json({ message: 'name is required' }, { status: 400, headers: corsHeaders })
    }
    const org = await createOrganization(pool, profileId, body, gotrueId, auditContext)
    return Response.json(org, { status: 201, headers: corsHeaders })
  }

  // POST /organizations/cloud-marketplace — AWS Marketplace managed org creation.
  // Must come before the slug regex so "cloud-marketplace" isn't parsed as a slug and
  // bounced with 404 by the normal org lookup. Self-hosted has no marketplace integration;
  // return a stable stub so Studio's aws-marketplace-onboarding flow renders gracefully.
  if (path === '/cloud-marketplace' && method === 'POST') {
    return Response.json({ installed: false, reason: 'self_hosted' }, { headers: corsHeaders })
  }

  // POST /organizations/preview-creation — preview pricing/slug before creating an org.
  // Self-hosted is always tier_free with zero cost; compute the slug that the future org
  // would get so Studio's creation wizard can display it.
  if (path === '/preview-creation' && method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const name = typeof body.name === 'string' ? body.name : null
    const slug = name ? generateSlugBase(name) || null : null
    return Response.json(
      {
        name,
        slug,
        currency: 'USD',
        plan_price: 0,
        tax: null,
        tax_status: 'not_applicable',
        total: 0,
      },
      { headers: corsHeaders }
    )
  }

  // Extract slug from path: /{slug} or /{slug}/sub-resource
  const slugMatch = path.match(/^\/([^/]+)(\/.*)?$/)
  if (!slugMatch) {
    return Response.json({ message: 'Not Found' }, { status: 404, headers: corsHeaders })
  }

  const slug = slugMatch[1]
  const subPath = slugMatch[2] || ''

  // GET /organizations/{slug}/projects — list org projects from DB
  if (method === 'GET' && subPath === '/projects') {
    const org = await getOrganizationBySlug(pool, slug, profileId)
    if (!org) {
      return Response.json(
        { message: 'Organization not found' },
        { status: 404, headers: corsHeaders }
      )
    }
    const url = new URL(req.url)
    const limit = parseInt(url.searchParams.get('limit') || '100', 10)
    const offset = parseInt(url.searchParams.get('offset') || '0', 10)
    const result = await listOrgProjects(pool, org.id, limit, offset)
    return Response.json(result, { headers: corsHeaders })
  }

  // Delegate billing/payments/customer/tax sub-paths to billing handler
  if (
    subPath.startsWith('/billing') ||
    subPath.startsWith('/customer') ||
    subPath.startsWith('/tax-ids') ||
    subPath.startsWith('/payments')
  ) {
    const org = await getOrganizationBySlug(pool, slug, profileId)
    if (!org) {
      return Response.json(
        { message: 'Organization not found' },
        { status: 404, headers: corsHeaders }
      )
    }
    return handleBilling(req, subPath, method, pool, org.id, profileId, gotrueId, email)
  }

  // Usage endpoints (real metrics from Postgres + Logflare)
  if (method === 'GET' && (subPath === '/usage' || subPath === '/usage/daily')) {
    const org = await getOrganizationBySlug(pool, slug, profileId)
    if (!org) {
      return Response.json(
        { message: 'Organization not found' },
        { status: 404, headers: corsHeaders }
      )
    }

    const url = new URL(req.url)
    const usageOpts = {
      projectRef: url.searchParams.get('project_ref') ?? undefined,
      start: url.searchParams.get('start') ?? undefined,
      end: url.searchParams.get('end') ?? undefined,
    }

    try {
      if (subPath === '/usage') {
        const result = await getOrgUsage(pool, org.id, org.plan.id, usageOpts)
        return Response.json(result, { headers: corsHeaders })
      } else {
        const result = await getOrgDailyUsage(pool, org.id, usageOpts)
        return Response.json(result, { headers: corsHeaders })
      }
    } catch (err) {
      console.error('Usage endpoint error:', err)
      return Response.json(
        { message: 'Failed to get usage stats' },
        { status: 500, headers: corsHeaders }
      )
    }
  }

  // ── Org Audit Logs ────────────────────────────────────
  if (method === 'GET' && subPath === '/audit') {
    const org = await getOrganizationBySlug(pool, slug, profileId)
    if (!org) {
      return Response.json(
        { message: 'Organization not found' },
        { status: 404, headers: corsHeaders }
      )
    }
    const url = new URL(req.url)
    const startTs = url.searchParams.get('iso_timestamp_start')
    const endTs = url.searchParams.get('iso_timestamp_end')
    if (!startTs || !endTs) {
      return Response.json(
        { message: 'iso_timestamp_start and iso_timestamp_end are required' },
        { status: 400, headers: corsHeaders }
      )
    }
    const logs = await getOrgAuditLogs(pool, org.id, startTs, endTs)
    return Response.json(logs, { headers: corsHeaders })
  }

  // ── Members, Invitations, Roles ─────────────────────────
  if (subPath.startsWith('/members') || subPath === '/roles') {
    const org = await getOrganizationBySlug(pool, slug, profileId)
    if (!org) {
      return Response.json(
        { message: 'Organization not found' },
        { status: 404, headers: corsHeaders }
      )
    }
    return handleMembers(req, subPath, method, pool, org.id, profileId, gotrueId, email)
  }

  // ── SSO Provider CRUD ───────────────────────────────────
  if (subPath === '/sso') {
    const org = await getOrganizationBySlug(pool, slug, profileId)
    if (!org) {
      return Response.json(
        { message: 'Organization not found' },
        { status: 404, headers: corsHeaders }
      )
    }
    if (method === 'GET') {
      const provider = await getSSOProvider(pool, org.id)
      if (!provider) {
        return Response.json(
          { message: 'No SSO provider configured for this organization' },
          { status: 404, headers: corsHeaders }
        )
      }
      return Response.json(provider, { headers: corsHeaders })
    }
    if (method === 'POST') {
      const body = await req.json()
      const provider = await createSSOProvider(
        pool,
        org.id,
        body,
        profileId,
        gotrueId,
        auditContext
      )
      return Response.json(provider, { status: 201, headers: corsHeaders })
    }
    if (method === 'PUT') {
      const body = await req.json()
      const provider = await updateSSOProvider(
        pool,
        org.id,
        body,
        profileId,
        gotrueId,
        auditContext
      )
      if (!provider) {
        return Response.json(
          { message: 'No SSO provider configured for this organization' },
          { status: 404, headers: corsHeaders }
        )
      }
      return Response.json(provider, { headers: corsHeaders })
    }
    if (method === 'DELETE') {
      const deleted = await deleteSSOProvider(pool, org.id, profileId, gotrueId, auditContext)
      if (!deleted) {
        return Response.json(
          { message: 'No SSO provider configured for this organization' },
          { status: 404, headers: corsHeaders }
        )
      }
      return Response.json({ message: 'SSO provider deleted' }, { headers: corsHeaders })
    }
  }

  // ── Compliance documents ────────────────────────────────
  // GET /documents/{standard-security-questionnaire|soc2-type-2-report|iso27001-certificate}
  // returns a shape-correct "not available" response instead of {} (which Studio downloads
  // as a broken PDF). Studio's useDocumentQuery reads `fileUrl` and skips the download when
  // it's null.
  const docMatch = subPath.match(/^\/documents\/([^/]+)$/)
  if (docMatch && method === 'GET' && COMPLIANCE_DOC_TYPES.has(docMatch[1])) {
    const org = await getOrganizationBySlug(pool, slug, profileId)
    if (!org) {
      return Response.json(
        { message: 'Organization not found' },
        { status: 404, headers: corsHeaders }
      )
    }
    return Response.json({ fileUrl: null, available: false }, { headers: corsHeaders })
  }

  // POST /documents/dpa — Data Processing Addendum generation is a PandaDoc-backed
  // cloud-only flow. Return 501 with the canonical `{ code, message }` envelope
  // so Studio surfaces the "not available in self-hosted" state instead of
  // "Failed to request DPA". L3: every self-hosted-unsupported response in
  // traffic-one uses this exact shape for machine-readable rendering.
  if (subPath === '/documents/dpa' && method === 'POST') {
    const org = await getOrganizationBySlug(pool, slug, profileId)
    if (!org) {
      return Response.json(
        { message: 'Organization not found' },
        { status: 404, headers: corsHeaders }
      )
    }
    return Response.json(
      {
        code: 'self_hosted_unsupported',
        message: 'Data Processing Addendum requests are not available in self-hosted',
      },
      { status: 501, headers: corsHeaders }
    )
  }

  // Sub-resource stubs for self-hosted (no marketplace).
  //
  // M3: pre-fix we fell through to `Response.json({}, 200)` for ANY unknown
  // `/organizations/{slug}/<anything>` GET/POST once org membership was
  // verified. That silently swallowed upstream API renames (and the
  // corresponding breakages in Studio) because every call looked like a
  // success with no body. Narrow to the explicit allow-list below and return
  // 404 otherwise so bad routes surface as real errors.
  const subResourceStubs: Record<string, unknown> = {
    '/entitlements': { entitlements: [] },
    '/oauth/apps': [],
    '/apps': [],
    '/apps/installations': [],
  }

  // Stubs for mutations too — self-hosted has no backing store for marketplace
  // link, OAuth apps, signing-key rotations, or client-secret admin flows.
  // Keeping the whitelist unified means the same set of paths answers GET /
  // POST / PATCH / PUT / DELETE consistently.
  const MUTATION_STUB_PATHS = new Set<string>([
    '/apps',
    '/apps/installations',
    '/oauth/apps',
    '/marketplace/link',
  ])

  if (method === 'GET' && subPath && subPath !== '/') {
    const stubData = subResourceStubs[subPath]
    if (stubData === undefined) {
      return Response.json({ message: 'Not Found' }, { status: 404, headers: corsHeaders })
    }
    const org = await getOrganizationBySlug(pool, slug, profileId)
    if (!org) {
      return Response.json(
        { message: 'Organization not found' },
        { status: 404, headers: corsHeaders }
      )
    }
    return Response.json(stubData, { headers: corsHeaders })
  }

  if (method === 'POST' && subPath && subPath !== '/') {
    if (subPath === '/available-versions') {
      const org = await getOrganizationBySlug(pool, slug, profileId)
      if (!org) {
        return Response.json(
          { message: 'Organization not found' },
          { status: 404, headers: corsHeaders }
        )
      }
      return Response.json({ available_versions: [] }, { headers: corsHeaders })
    }
    if (MUTATION_STUB_PATHS.has(subPath)) {
      const org = await getOrganizationBySlug(pool, slug, profileId)
      if (!org) {
        return Response.json(
          { message: 'Organization not found' },
          { status: 404, headers: corsHeaders }
        )
      }
      return Response.json({}, { headers: corsHeaders })
    }
    return Response.json({ message: 'Not Found' }, { status: 404, headers: corsHeaders })
  }

  // PATCH / PUT / DELETE only succeed for the mutation-stub whitelist. Outside
  // of that, return 404 instead of a misleading 200 {}.
  if (
    (method === 'PATCH' || method === 'PUT' || method === 'DELETE') &&
    subPath &&
    subPath !== '/'
  ) {
    if (!MUTATION_STUB_PATHS.has(subPath)) {
      return Response.json({ message: 'Not Found' }, { status: 404, headers: corsHeaders })
    }
    const org = await getOrganizationBySlug(pool, slug, profileId)
    if (!org) {
      return Response.json(
        { message: 'Organization not found' },
        { status: 404, headers: corsHeaders }
      )
    }
    return Response.json({}, { headers: corsHeaders })
  }

  // GET /organizations/{slug} — get org detail
  if (method === 'GET') {
    const org = await getOrganizationBySlug(pool, slug, profileId)
    if (!org) {
      return Response.json(
        { message: 'Organization not found' },
        { status: 404, headers: corsHeaders }
      )
    }
    return Response.json(org, { headers: corsHeaders })
  }

  // PATCH /organizations/{slug} — update org
  if (method === 'PATCH' && !subPath) {
    const body = await req.json()
    const result = await updateOrganization(
      pool,
      slug,
      profileId,
      {
        name: body.name,
        billing_email: body.billing_email,
        opt_in_tags: body.opt_in_tags,
        additional_billing_emails: body.additional_billing_emails,
      },
      gotrueId,
      auditContext
    )
    if (!result) {
      return Response.json(
        { message: 'Organization not found' },
        { status: 404, headers: corsHeaders }
      )
    }
    return Response.json(result, { headers: corsHeaders })
  }

  // DELETE /organizations/{slug} — delete org
  if (method === 'DELETE' && !subPath) {
    const deleted = await deleteOrganization(pool, slug, profileId, gotrueId, auditContext)
    if (!deleted) {
      return Response.json(
        { message: 'Organization not found or not owner' },
        { status: 404, headers: corsHeaders }
      )
    }
    return Response.json({ message: 'Organization deleted' }, { headers: corsHeaders })
  }

  return Response.json({ message: 'Method not allowed' }, { status: 405, headers: corsHeaders })
}

// ── /api/v1/organizations/{slug}/... ────────────────────────────────────────
//
// Served by the `v1-organizations` Kong service. Today the only endpoint Studio
// hits is /project-claim/{token} (used by the AWS-marketplace project transfer
// flow). Keep the handler scoped to that subpath; unmatched paths 404.
export async function handleV1Organizations(
  _req: Request,
  path: string,
  method: string,
  pool: Pool,
  profileId: number
): Promise<Response> {
  const claimMatch = path.match(/^\/([^/]+)\/project-claim\/([^/]+)\/?$/)
  if (!claimMatch) {
    return Response.json({ message: 'Not Found' }, { status: 404, headers: corsHeaders })
  }

  const slug = claimMatch[1]

  // Authorize against the target org — a claim token is only usable by a member of
  // the org that's supposed to receive the project. Unknown slug / non-member: 404
  // (not 403, to avoid leaking org existence).
  const org = await getOrganizationBySlug(pool, slug, profileId)
  if (!org) {
    return Response.json(
      { message: 'Organization not found' },
      { status: 404, headers: corsHeaders }
    )
  }

  // Self-hosted has no cross-region project transfer / AWS-marketplace provisioning,
  // so there are no real claim tokens. GET returns a "not valid" stub so Studio's
  // claim-project page shows its error admonition; POST is explicitly 501.
  if (method === 'GET') {
    return Response.json({ valid: false }, { headers: corsHeaders })
  }
  if (method === 'POST') {
    return Response.json(
      { code: 'self_hosted_unsupported', message: 'Project claim is not available in self-hosted' },
      { status: 501, headers: corsHeaders }
    )
  }

  return Response.json({ message: 'Method not allowed' }, { status: 405, headers: corsHeaders })
}
