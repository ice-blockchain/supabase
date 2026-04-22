export type DisabledFeature =
  | "organizations:create"
  | "organizations:delete"
  | "organization_members:create"
  | "organization_members:delete"
  | "projects:create"
  | "projects:transfer"
  | "project_auth:all"
  | "project_storage:all"
  | "project_edge_function:all"
  | "profile:update"
  | "billing:account_data"
  | "billing:credits"
  | "billing:invoices"
  | "billing:payment_methods"
  | "realtime:all";

export interface ProfileResponse {
  auth0_id: string;
  disabled_features: DisabledFeature[];
  first_name: string | null;
  free_project_limit: number | null;
  gotrue_id: string;
  id: number;
  is_alpha_user: boolean;
  is_sso_user: boolean;
  last_name: string | null;
  mobile: string | null;
  primary_email: string;
  username: string;
}

export interface AccessToken {
  created_at: string;
  expires_at: string | null;
  id: number;
  last_used_at: string | null;
  name: string;
  scope?: "V0";
  token_alias: string;
}

export interface CreateAccessTokenResponse extends AccessToken {
  token: string;
}

export interface CreateScopedAccessTokenResponse {
  created_at: string;
  expires_at: string | null;
  id: string;
  last_used_at: string | null;
  name: string;
  organization_slugs?: string[];
  permissions: string[];
  project_refs?: string[];
  token: string;
  token_alias: string;
}

export type ScopedAccessToken = Omit<CreateScopedAccessTokenResponse, "token">;

export type NotificationPriority = "Critical" | "Warning" | "Info";
export type NotificationStatus = "new" | "seen" | "archived";

export interface NotificationResponse {
  data: unknown;
  id: string;
  inserted_at: string;
  meta: unknown;
  name: string;
  priority: NotificationPriority;
  status: NotificationStatus;
}

export interface AuditLogAction {
  name: string;
  metadata: Array<{ method?: string; route?: string; status?: number }>;
}

export interface AuditLogActor {
  id: string;
  type: string;
  metadata: Array<{ email?: string; ip?: string; tokenType?: string }>;
}

export interface AuditLogTarget {
  description: string;
  metadata: Record<string, unknown>;
}

export interface AuditLog {
  action: AuditLogAction;
  actor: AuditLogActor;
  target: AuditLogTarget;
  occurred_at: string;
}

export interface AuditLogsResponse {
  result: AuditLog[];
  retention_period: number;
}

export interface UserAuditLogsResponse {
  result: unknown[];
  retention_period: number;
}

export type AccessControlPermission =
  | "organizations_read"
  | "organizations_create"
  | "projects_read"
  | "snippets_read"
  | "organization_admin_read"
  | "organization_admin_write"
  | "members_read"
  | "members_write"
  | "organization_projects_read"
  | "organization_projects_create"
  | "project_admin_read"
  | "project_admin_write"
  | "action_runs_read"
  | "action_runs_write"
  | "advisors_read";

export interface OrganizationPlan {
  id: string;
  name: string;
}

export interface OrganizationResponse {
  id: number;
  name: string;
  slug: string;
  billing_email: string | null;
  billing_partner: null;
  is_owner: boolean;
  opt_in_tags: string[];
  plan: OrganizationPlan;
  restriction_data: null;
  restriction_status: null;
  stripe_customer_id: null;
  subscription_id: null;
  usage_billing_enabled: boolean;
  organization_missing_address: boolean;
  organization_missing_tax_id: boolean;
  organization_requires_mfa: boolean;
}

export interface OrganizationSlugResponse {
  id: number;
  name: string;
  slug: string;
  billing_email: string | null;
  billing_partner: null;
  opt_in_tags: string[];
  plan: OrganizationPlan;
  restriction_data: null;
  restriction_status: null;
  usage_billing_enabled: boolean;
  has_oriole_project: boolean;
}

export interface UpdateOrganizationResponse {
  id: number;
  name: string;
  slug: string;
  billing_email: string | null;
  opt_in_tags: string[];
  stripe_customer_id: null;
}

export interface CreateOrganizationBody {
  name: string;
  kind?: string;
  size?: string;
  tier?: string;
}

// ── Usage & Pricing Types ─────────────────────────────────

export type UsageMetric =
  | "EGRESS"
  | "CACHED_EGRESS"
  | "DATABASE_SIZE"
  | "STORAGE_SIZE"
  | "MONTHLY_ACTIVE_USERS"
  | "MONTHLY_ACTIVE_SSO_USERS"
  | "MONTHLY_ACTIVE_THIRD_PARTY_USERS"
  | "FUNCTION_INVOCATIONS"
  | "FUNCTION_CPU_MILLISECONDS"
  | "STORAGE_IMAGES_TRANSFORMED"
  | "REALTIME_MESSAGE_COUNT"
  | "REALTIME_PEAK_CONNECTIONS"
  | "DISK_SIZE_GB_HOURS_GP3"
  | "DISK_SIZE_GB_HOURS_IO2"
  | "DISK_THROUGHPUT_GP3"
  | "DISK_IOPS_GP3"
  | "DISK_IOPS_IO2"
  | "AUTH_MFA_PHONE"
  | "AUTH_MFA_WEB_AUTHN"
  | "LOG_DRAIN_EVENTS"
  | "COMPUTE_HOURS_BRANCH"
  | "COMPUTE_HOURS_XS"
  | "COMPUTE_HOURS_SM"
  | "COMPUTE_HOURS_MD"
  | "COMPUTE_HOURS_L"
  | "COMPUTE_HOURS_XL"
  | "COMPUTE_HOURS_2XL"
  | "COMPUTE_HOURS_4XL"
  | "COMPUTE_HOURS_8XL"
  | "COMPUTE_HOURS_12XL"
  | "COMPUTE_HOURS_16XL"
  | "COMPUTE_HOURS_24XL"
  | "COMPUTE_HOURS_24XL_OPTIMIZED_CPU"
  | "COMPUTE_HOURS_24XL_OPTIMIZED_MEMORY"
  | "COMPUTE_HOURS_24XL_HIGH_MEMORY"
  | "COMPUTE_HOURS_48XL"
  | "COMPUTE_HOURS_48XL_OPTIMIZED_CPU"
  | "COMPUTE_HOURS_48XL_OPTIMIZED_MEMORY"
  | "COMPUTE_HOURS_48XL_HIGH_MEMORY"
  | "CUSTOM_DOMAIN"
  | "PITR_7"
  | "PITR_14"
  | "PITR_28"
  | "IPV4"
  | "LOG_DRAIN"
  | "LOG_INGESTION"
  | "LOG_QUERYING"
  | "LOG_STORAGE"
  | "ACTIVE_COMPUTE_HOURS";

export type PricingStrategy = "UNIT" | "PACKAGE" | "TIERED" | "NONE";

export interface EgressBreakdown {
  egress_function: number;
  egress_graphql: number;
  egress_logdrain: number;
  egress_realtime: number;
  egress_rest: number;
  egress_storage: number;
  egress_supavisor: number;
}

export interface ProjectAllocation {
  ref: string;
  name: string;
  usage: number;
  hours?: number;
}

export interface UsageEntry {
  metric: UsageMetric;
  usage: number;
  usage_original: number;
  cost: number;
  available_in_plan: boolean;
  capped: boolean;
  unlimited: boolean;
  pricing_strategy: PricingStrategy;
  pricing_free_units?: number;
  pricing_per_unit_price?: number;
  pricing_package_price?: number;
  pricing_package_size?: number;
  project_allocations: ProjectAllocation[];
  unit_price_desc: string;
}

export interface OrgUsageResponse {
  usage_billing_enabled: boolean;
  usages: UsageEntry[];
}

export interface DailyUsageEntry {
  date: string;
  metric: UsageMetric;
  usage: number;
  usage_original: number;
  breakdown: EgressBreakdown | null;
}

export interface OrgDailyUsageResponse {
  usages: DailyUsageEntry[];
}

export interface PricingOverride {
  id: number;
  organization_id: number;
  metric: string | null;
  discount_percent: number;
  custom_free_units: number | null;
  custom_per_unit_price: number | null;
  notes: string | null;
}

export interface MetricPricing {
  pricing_strategy: PricingStrategy;
  free_units: number;
  per_unit_price: number;
  package_size?: number;
  package_price?: number;
  available_in_plan: boolean;
  capped: boolean;
  unit_price_desc: string;
}

// ── Organization Settings Types ───────────────────────────

export interface MfaEnforcementResponse {
  enforced: boolean;
}

export interface SSOProviderResponse {
  id: string;
  organization_id: number;
  enabled: boolean;
  metadata_xml_file: string | null;
  metadata_xml_url: string | null;
  domains: string[];
  email_mapping: string[];
  first_name_mapping: string[];
  last_name_mapping: string[];
  user_name_mapping: string[];
  join_org_on_signup_enabled: boolean;
  join_org_on_signup_role: string;
  created_at: string;
  updated_at: string;
}

export interface CreateSSOProviderBody {
  enabled?: boolean;
  metadata_xml_file?: string;
  metadata_xml_url?: string;
  domains?: string[];
  email_mapping?: string[];
  first_name_mapping?: string[];
  last_name_mapping?: string[];
  user_name_mapping?: string[];
  join_org_on_signup_enabled?: boolean;
  join_org_on_signup_role?: string;
}

export type UpdateSSOProviderBody = CreateSSOProviderBody;

// ── Member / Invitation / Role Types ──────────────────────

export interface MemberResponse {
  gotrue_id: string;
  is_sso_user: boolean | null;
  metadata: Record<string, unknown>;
  mfa_enabled: boolean;
  primary_email: string | null;
  role_ids: number[];
  username: string;
}

export interface InvitationItem {
  id: number;
  invited_at: string;
  invited_email: string;
  role_id: number;
}

export interface InvitationResponse {
  invitations: InvitationItem[];
}

export interface InvitationByTokenResponse {
  authorized_user: boolean;
  email_match: boolean;
  expired_token: boolean;
  invite_id?: number;
  organization_name: string;
  sso_mismatch: boolean;
  token_does_not_exist: boolean;
}

export interface CreateInvitationBody {
  email: string;
  role_id: number;
  require_sso?: boolean;
  role_scoped_projects?: string[];
}

export interface AssignMemberRoleBodyV2 {
  role_id: number;
  role_scoped_projects?: string[];
}

export interface UpdateMemberRoleBody {
  name: string;
  description?: string;
  role_scoped_projects: string[];
}

export interface RoleItem {
  base_role_id: number;
  description: string | null;
  id: number;
  name: string;
  projects: { name: string; ref: string }[];
}

export interface OrganizationRoleResponse {
  org_scoped_roles: RoleItem[];
  project_scoped_roles: RoleItem[];
}

export interface MemberWithFreeProjectLimit {
  free_project_limit: number;
  primary_email: string;
  username: string;
}

// ── Project Types ─────────────────────────────────────────

export interface CreateProjectBody {
  name: string;
  organization_slug: string;
  db_pass?: string;
  db_region?: string;
  cloud_provider?: string;
  plan?: string;
}

export interface CreateProjectResponse {
  id: number;
  ref: string;
  name: string;
  status: string;
  endpoint: string;
  anon_key: string;
  service_key: string;
  organization_id: number;
  organization_slug: string;
  region: string;
  cloud_provider: string;
  is_branch_enabled: boolean;
  is_physical_backups_enabled: boolean;
  preview_branch_refs: string[];
  subscription_id: string | null;
  inserted_at: string;
  disk_volume_size_gb?: number;
  infra_compute_size?: string;
}

export interface ProjectDetailResponse {
  id: number;
  ref: string;
  name: string;
  status: string;
  cloud_provider: string;
  region: string;
  organization_id: number;
  db_host: string;
  connectionString: string | null;
  restUrl: string;
  high_availability: boolean;
  is_branch_enabled: boolean;
  is_physical_backups_enabled: boolean;
  subscription_id: string;
  inserted_at: string;
  updated_at: string;
}

export interface ProjectListItem {
  id: number;
  ref: string;
  name: string;
  status: string;
  region: string;
  cloud_provider: string;
  organization_id: number;
  organization_slug: string;
  is_branch_enabled: boolean;
  is_physical_backups_enabled: boolean;
  preview_branch_refs: string[];
  subscription_id: string | null;
  inserted_at: string;
}

export interface ListProjectsPaginatedResponse {
  pagination: { count: number; limit: number; offset: number };
  projects: ProjectListItem[];
}

export interface OrgProjectDatabase {
  identifier: string;
  infra_compute_size: string;
  region: string;
  status: string;
  type: string;
  cloud_provider: string;
}

export interface OrgProjectItem {
  ref: string;
  name: string;
  status: string;
  region: string;
  cloud_provider: string;
  inserted_at: string;
  is_branch: boolean;
  databases: OrgProjectDatabase[];
}

export interface OrganizationProjectsResponse {
  pagination: { count: number; limit: number; offset: number };
  projects: OrgProjectItem[];
}

export interface RemoveProjectResponse {
  id: number;
  ref: string;
  name: string;
  status: string;
}
