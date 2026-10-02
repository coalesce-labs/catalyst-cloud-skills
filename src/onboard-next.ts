import { loadConfig, normalizeBaseUrl } from "./config.js";
import type { OnboardJournal, OnboardStep } from "./onboard.js";

/** What a person reads for a step that is not done. Each line ends in an action they can take. */
const REASONS: Record<string, string> = {
  account_identity_unverified:
    "Your login changed while coding accounts were checked. Run catalyst onboard again to verify your person and workspace.",
  account_inventory_unavailable:
    "Coding accounts could not be read. Run catalyst onboard again to retry.",
  account_inventory_unverified:
    "The server did not return a fresh supported coding-account list. Run catalyst onboard after the server update.",
  account_validation_admin_required:
    "An administrator must check the workspace's coding-account access.",
  account_login_refresh_required:
    "Renew your login with catalyst login, then run catalyst onboard.",
  account_validation_unavailable:
    "The provider check could not finish. Run catalyst onboard again to retry.",
  account_validation_unverified:
    "The server did not return a fresh provider check. Run catalyst onboard after the server update.",
  account_provider_access_unverified:
    "Coding-account provider access is not freshly verified. Check the account in the workspace's coding-account settings, then resume setup.",
  codex_provider_access_unverified:
    "Codex credentials are stored, but provider access is not freshly verified. Setup did not refresh or rotate the Codex login.",
  account_provider_walled:
    "Claude's usage limit is spent for now. Check the account's reset time, then run catalyst onboard again.",
  account_provider_rejected:
    "Claude refused the stored login. Replace it in the workspace's coding-account settings, then resume setup.",
  personal_consent_handoff:
    "The browser approval link could not be verified. Run catalyst onboard to try again.",
  personal_identity_refused:
    "Your current login no longer matches this setup. Resume with the original workspace and person.",
  personal_login_refresh_required:
    "Renew your login with catalyst login, then run catalyst onboard to resume.",
  onboard_login_refresh_required:
    "Renew your login with catalyst login, then run catalyst onboard to resume.",
  personal_status_unavailable:
    "Your personal connection could not be checked. Run catalyst onboard to try again.",
  workspace_browser_unavailable:
    "This computer could not open a browser. Connect Linear from this workspace’s Integrations page in your browser, then run catalyst onboard to resume.",
  personal_browser_unavailable:
    "This computer could not open a browser. Finish this login’s connection from Connected accounts in your browser, then run catalyst onboard to resume.",
  onboarding_capability_unavailable:
    "The server's setup capabilities could not be checked. Run catalyst onboard to try again.",
  onboarding_capability_identity_unverified:
    "The server's setup capabilities belong to another login or workspace. Sign in to the original workspace to resume.",
  onboarding_capability_login_refresh_required:
    "Your login needs a refresh before setup capabilities can be checked. Run catalyst login, then catalyst onboard.",
  workspace_login_refresh_required:
    "Renew your login with catalyst login, then run catalyst onboard to resume.",
  workspace_consent_refused:
    "The server did not accept this login for Linear workspace setup. Sign in again or ask your workspace administrator.",
  github_installation_status_unavailable:
    "Your GitHub App installation could not be checked. Run catalyst onboard to try again.",
  github_installation_status_shape:
    "The server returned a GitHub installation result that could not be verified.",
  github_installation_consent_handoff:
    "The GitHub installation approval link could not be verified. Run catalyst onboard to try again.",
  github_installation_consent_refused:
    "The server did not accept this login for GitHub App setup. Sign in again or ask your workspace administrator.",
  github_installation_identity_refused:
    "GitHub setup belongs to another login or workspace. Sign in to the original workspace to resume.",
  github_installation_admin_required:
    "A workspace owner or administrator approves the GitHub App installation.",
  github_installation_login_refresh_required:
    "Renew your login with catalyst login, then run catalyst onboard to resume.",
  github_installation_browser_unavailable:
    "This computer could not open a browser. Install the GitHub App from this workspace’s Integrations page in your browser, then run catalyst onboard to resume.",
  step_not_available_in_this_release:
    "This setup step is not available yet.",
  prerequisite_not_ready: "Waiting for an earlier setup step.",
  local_sync_not_selected:
    "Using cloud reads. Local sync was not selected.",
  local_sync_capability_unavailable:
    "Local sync was selected but could not be verified.",
  member_scope: "Your workspace administrator handles this step.",
  onboarding_checks_pending: "Some required checks are still unverified.",
  interrupted: "Setup paused. Run the same command to resume.",
  signin_timeout: "Sign-in timed out. Run catalyst onboard to try again.",
  linear_workspace_unverified:
    "Your Linear workspace connection could not be verified.",
  team_inventory_empty: "No existing Linear teams could be verified.",
  team_inventory_shape:
    "The cloud returned a team list that could not be verified.",
  team_read_unavailable:
    "Your existing Linear teams could not be read. Run catalyst onboard to try again.",
  team_read_identity_unverified:
    "Your login changed while setup was reading this workspace. Resume with the original workspace and person.",
  project_identity_unverified:
    "Your login changed while setup was checking this project. Resume with the original workspace and person.",
  project_options_unavailable:
    "Available teams and repositories could not be checked. Run catalyst onboard to try again.",
  project_provider_inventory_unavailable:
    "Linear or GitHub access could not be verified. Check this workspace's connections, then resume.",
  project_options_unverified:
    "The server returned a team or repository list that could not be verified.",
  project_registration_visibility_pending:
    "Your project exists, but its repository binding is not visible yet. Run catalyst onboard to check again.",
  project_binding_conflict:
    "This team or repository is already bound to a project. Ask your workspace administrator to check its binding, then resume.",
  project_login_refresh_required:
    "Renew your login with catalyst onboard, then review the plan before creating this project.",
  project_create_unverified:
    "Project creation could not be confirmed. Run catalyst onboard to check for the project before trying again.",
  team_read_login_refresh_required:
    "Renew your login with catalyst login, then run catalyst onboard to resume.",
  team_choice_required:
    "Choose an existing team with catalyst onboard --team <team ID or key>.",
  team_selection_unverified:
    "Your selected Linear team could not be verified. Run catalyst onboard --team <team ID or key> to choose again.",
  repository_choice_required:
    "Choose repositories with catalyst onboard --repo <owner/name>. Repeat --repo to choose more than one.",
  repository_inventory_empty:
    "No accessible repositories are registered to this Linear team yet.",
  repository_read_unavailable:
    "Your repository list could not be read. Run catalyst onboard to try again.",
  repository_inventory_shape:
    "The cloud returned a repository list that could not be verified.",
  repository_contract_unavailable:
    "Current repository IDs could not be checked. Run catalyst onboard to try again.",
  repository_contract_unverified:
    "The cloud returned repository IDs that could not be verified for this workspace.",
  repository_id_unverified:
    "A repository's current ID could not be verified. Keep your selection and try again.",
  repository_binding_ambiguous:
    "A repository's Linear team binding is ambiguous. Your administrator needs to check it.",
  repository_identity_unverified:
    "Sign in to the original workspace to choose repositories.",
  settings_review_timeout:
    "The settings review timed out. Run catalyst onboard to resume.",
  settings_checkout_unverified:
    "Setup could not verify the repository's local checkout or settings file. Settings are optional for a first ticket. To finish them later, run catalyst onboard from the repository's checkout.",
  settings_draft_storage_unavailable:
    "A private settings draft could not be kept. Run catalyst onboard to retry.",
  settings_draft_storage_timeout:
    "Keeping your settings draft took too long. Run catalyst onboard to retry.",
  settings_approval_unverified:
    "Settings still need review and approval; kept drafts do not count. Settings are optional for a first ticket. To finish them later, run catalyst onboard from the repository's checkout.",
  repository_selection_unverified:
    "Your selected repositories could not be verified. Run catalyst onboard --repo <owner/name> to choose again.",
  workflow_adoption_declined:
    "Skipped for now. Run catalyst onboard to review the changes again.",
  workflow_identity_unverified:
    "Setup could not confirm the signed-in workspace, person or role for this team. Run catalyst onboard again as a workspace owner or administrator.",
  workflow_login_refresh_required:
    "Renew your login with catalyst login, then run catalyst onboard.",
  workflow_mapping_changed:
    "The team's workflow changed while setup checked it. Run catalyst onboard again.",
  workflow_admin_required:
    "Applying the Catalyst workflow needs a workspace owner or administrator. Ask one to run catalyst onboard for this team.",
  workflow_plan_changed:
    "The team's Linear workflow changed while setup was applying it. Run catalyst onboard again to see the new plan.",
  verification_pending:
    "Setup made the change but could not confirm it yet. Run catalyst onboard again to check.",
  automations_compatible: "Nothing to change.",
  workflow_unavailable:
    "Setup could not read the team's workflow. Run catalyst onboard again to retry.",
  capacity_admission_unverified:
    "No runner is allowed to take work for this workspace yet. Enroll a self-hosted runner host, or ask Catalyst to enable cloud runners for it. Then run catalyst onboard.",
  capacity_currently_full:
    "Every runner slot for this repository is in use. Run catalyst onboard again after current work finishes.",
  capacity_unavailable:
    "Setup could not read runner capacity. Run catalyst onboard again to retry.",
  runner_not_selected:
    "This setup does not start a runner on this machine. To start one, run catalyst onboard --runner.",
  runner_docker_missing:
    "A runner needs Docker with Compose (Docker Desktop, OrbStack or Docker Engine), and setup could not reach it. Start Docker, or install it, then run catalyst onboard --runner.",
  runner_identity_unverified:
    "A workspace owner or administrator enrolls a runner. Sign in as one with catalyst login, then run catalyst onboard --runner.",
  runner_context_unverified:
    "Setup could not confirm the selected Linear team. Run catalyst onboard again.",
  runner_directory_unavailable:
    "Setup could not prepare the runner folder in Catalyst's state directory. Check its permissions, then run catalyst onboard again.",
  runner_image_unpinned:
    "Each runner image must be pinned as name@sha256:<digest>, and Catalyst's runner image is not public yet. Ask Catalyst support to load it here and set CATALYST_RUNNER_IMAGE to the reference they give you. A CATALYST_SUPERVISOR_IMAGE or CATALYST_WATCHDOG_IMAGE override takes the same form. Then run catalyst onboard --runner.",
  runner_image_emulated:
    "A runner image here is built for another processor, and Catalyst does not run work under emulation. Ask Catalyst support for the image built for this processor, then run catalyst onboard again.",
  runner_session_network_misshaped:
    "A Docker network named catalyst-session-v1 exists with the wrong settings. Remove it with docker network rm catalyst-session-v1 when nothing uses it, then run catalyst onboard again.",
  runner_session_network_failed:
    "Docker could not create the catalyst-session-v1 network. Check that Docker is running, then run catalyst onboard again.",
  runner_docker_socket_unreadable:
    "Setup could not read the group of the Docker socket at /var/run/docker.sock. Check that Docker is running, then run catalyst onboard again.",
  runner_enrollment_unavailable:
    "Setup could not read this workspace's runner hosts. Run catalyst onboard again to retry.",
  runner_enrollment_stale:
    "This machine still holds the credential of a runner enrollment that was revoked. Stop the runner with docker compose -p catalyst-host down, remove the credential with docker volume rm catalyst-host_host-credential (this also removes the organization key), then run catalyst onboard --runner.",
  runner_login_refresh_required:
    "Renew your login with catalyst login, then run catalyst onboard.",
  runner_join_token_unavailable:
    "Catalyst did not issue a join token for this machine. Run catalyst onboard again to retry.",
  runner_org_key_file_invalid:
    "CATALYST_RUNNER_ORG_KEY_FILE must name a regular file that holds one organization key. Fix the file, then run catalyst onboard again.",
  runner_org_key_write_failed:
    "Setup could not place the organization key on the runner. Check that Docker is running, then run catalyst onboard again.",
  runner_compose_failed:
    "Docker Compose could not start the runner. Run docker compose -p catalyst-host logs to see why, then run catalyst onboard again.",
  runner_compose_not_running:
    "The runner's supervisor is not running. Run docker compose -p catalyst-host logs supervisor to see why, then run catalyst onboard again.",
  runner_enrollment_unverified:
    "The runner started but has not enrolled yet. Run docker compose -p catalyst-host logs supervisor to see why, or run catalyst onboard again in a minute.",
  runner_needs_runner_flag:
    "This machine was set up to run Catalyst's work, but its runner is not running or not enrolled. To bring it up, run catalyst onboard --runner.",
  runner_capability_pending:
    "The runner enrolled but has not reported its capacity yet. Run catalyst onboard again in a minute.",
  runner_admission_unverified:
    "Setup could not read whether the team's pool admits runner hosts. Run catalyst onboard again to retry.",
  housekeeping_service_unverified:
    "The daily update needs a user service manager, launchd on macOS or systemd --user on Linux. Setup cannot schedule it on this computer. It is optional, and work does not depend on it.",
};

/** The saved login's web address, or nothing when the config is missing, unreadable or not http(s). */
export function savedOnboardBaseUrl(home: string): string | undefined {
  try {
    const cfg = loadConfig(home);
    const url = cfg ? webUrl(cfg.baseUrl) : undefined;
    return url ? normalizeBaseUrl(url) : undefined;
  } catch {
    return undefined;
  }
}
// Receipt and config text reaches the terminal only after URL parsing has escaped it.
function webUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/** The selected team's key from the receipt, only when it is plain enough to print in a command. */
export function onboardTeamKey(journal?: OnboardJournal): string | undefined {
  const step = journal?.steps.find((row) => row.id === "linear.team");
  const key = step?.state === "done" ? step.evidence?.teamKey : undefined;
  return typeof key === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(key)
    ? key
    : undefined;
}

/** One step's next action. `waitsFor` names the unfinished step a prerequisite wait is blocked on. */
export function onboardReasonText(
  step: OnboardStep,
  context: {
    baseUrl?: string;
    journal?: OnboardJournal;
    waitsFor?: string;
  } = {},
): string {
  const reason = step.reason ?? "";
  if (reason === "workflow_mapping_unverified")
    return `This team's workflow mapping is not verified yet. Run catalyst team adopt ${onboardTeamKey(context.journal) ?? "<TEAM KEY>"} to preview the adoption plan. Run it again with the --yes --plan-hash value it prints. Then run catalyst onboard.`;
  if (reason === "account_enrollment_required") {
    const where = context.baseUrl
      ? `at ${normalizeBaseUrl(context.baseUrl)}/settings/coding-accounts, the Settings → AI accounts page`
      : "in the web app on the Settings → AI accounts page";
    return `No coding account is enrolled. A workspace owner or administrator adds one ${where}. A Claude account needs its email and the token printed by \`claude setup-token\`. Then run catalyst onboard.`;
  }
  if (reason === "automation_management_unavailable") {
    const conflicts =
      typeof step.evidence?.automations === "string" &&
      /^(?:open|review|ready|merge)(?:,(?:open|review|ready|merge))*$/.test(
        step.evidence.automations,
      );
    if (!conflicts)
      return "could not read them; checked again before work starts";
    const key = onboardTeamKey(context.journal);
    const workspace = context.journal?.steps.find(
      (row) => row.id === "linear.workspace" && row.state === "done",
    );
    const slug = workspace?.evidence?.workspaceSlug;
    if (
      key &&
      /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(key) &&
      typeof slug === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(slug)
    )
      return `Open https://linear.app/${slug}/settings/teams/${key}/workflow and set each pull request automation to No action.`;
    return `Open your ${key ? `${key} team's` : "team's"} workflow settings in Linear and set each pull request automation to No action.`;
  }
  if (reason === "cloud_capability_unavailable") {
    // The capability guard records the web page in evidence.path only when it printed it.
    const page = webUrl(step.evidence?.path);
    return page
      ? `This setup step is not available on this server yet. Continue in the web app at ${page}, then run catalyst onboard.`
      : "This setup step is not available on this server yet. Run catalyst onboard after the server update.";
  }
  if (reason === "runner_images_unavailable") {
    const image = step.evidence?.image;
    const named =
      typeof image === "string" && /^[a-z0-9][a-z0-9._:/-]{0,255}@sha256:[0-9a-f]{64}$/.test(image)
        ? ` ${image}`
        : "";
    return `This machine does not have the Catalyst image${named}, and setup never signs in to a registry to pull it. Ask Catalyst support to load it here, then run catalyst onboard again.`;
  }
  if (reason === "runner_org_key_missing") {
    const where = context.baseUrl
      ? `at ${normalizeBaseUrl(context.baseUrl)}/settings/account-keys`
      : "on the web app's Account API keys page";
    return `The runner is enrolled, but it takes no work without an organization key. A workspace owner or administrator creates one with the mirror:read, mirror:write and mirror:feed scopes ${where} and saves it in a file only they can read. Then run catalyst onboard --runner with CATALYST_RUNNER_ORG_KEY_FILE set to that file.`;
  }
  if (reason === "runner_host_not_ready") {
    const failing = step.evidence?.failing;
    const checks =
      typeof failing === "string" && /^[a-z0-9.,_-]{1,500}$/.test(failing)
        ? `: ${failing.split(",").join(", ")}`
        : "";
    return `The runner is enrolled but its readiness checks fail${checks}. Run docker compose -p catalyst-host logs supervisor for the remedy, then run catalyst onboard again.`;
  }
  if (reason === "runner_admission_operator")
    return `This machine is enrolled and ready, but team ${onboardTeamKey(context.journal) ?? "<TEAM KEY>"} does not admit runner hosts yet, and only a Catalyst operator can turn that on today. Ask Catalyst support to enable host admission for the team with Cloudflare placement set to never. Then run catalyst onboard.`;
  if (reason === "prerequisite_not_ready" && context.waitsFor)
    return `Runs after "${context.waitsFor}".`;
  return REASONS[reason] ?? reason.replaceAll("_", " ");
}
