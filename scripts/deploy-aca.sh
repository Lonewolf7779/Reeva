#!/usr/bin/env bash
# ==============================================================================
# Reeva — Azure Container Apps Standard Environment Migration & Deployment Script
# Subscription: Azure for Students | RG: reeva-rg | Region: Central India
# ==============================================================================
#
# Architectural Note:
# Azure Container Apps "Express" environments (environmentMode: Express) do NOT
# support System-Assigned Managed Identity for private ACR authentication
# (error: ExpressEnvironmentFeatureNotSupported).
#
# This script:
# 1. Verifies Azure CLI & Container Apps extension compatibility upfront and
#    never falls back to creating an Express environment.
# 2. Preserves existing Express resources (reeva-env, reeva-mobile-test) untouched
#    and verifies their preservation before and after deployment.
# 3. Validates or creates a Standard Workload Profiles environment (reeva-standard-env)
#    using --enable-workload-profiles with an explicit Consumption workload profile
#    in Central India.
# 4. Rejects any Express or non-Consumption environment before touching any app.
# 5. Provisions/updates a dedicated Container App (reeva-mobile-app) in reeva-standard-env.
# 6. Verifies System-Assigned Managed Identity, exact-scope AcrPull role assignment,
#    and ARM registry binding BEFORE deploying the private Reeva image.
# 7. Fails immediately on unsupported feature or configuration errors instead of
#    entering misleading retry loops.
# 8. Verifies the ACR image sha256 digest, active revision health/running state,
#    /ready JSON payload, /health JSON payload, and /api/capabilities feature gates.
# ==============================================================================

set -euo pipefail

# ------------------------------------------------------------------------------
# Error Trap & Cleanup Handler
# ------------------------------------------------------------------------------
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/reeva-deploy.XXXXXX")
cleanup() {
    rm -rf "${TMP_DIR}" 2>/dev/null || true
}
trap cleanup EXIT

on_error() {
    local exit_code=$?
    local line_no=$1
    echo "" >&2
    echo "==================================================================" >&2
    echo " ERROR: Deployment script failed at line ${line_no} (exit code: ${exit_code})." >&2
    echo " Fetching diagnostic state for '${APP_NAME:-reeva-mobile-app}' in '${RESOURCE_GROUP:-reeva-rg}'..." >&2
    echo "==================================================================" >&2
    if command -v az >/dev/null 2>&1; then
        az containerapp revision list \
            --name "${APP_NAME:-reeva-mobile-app}" \
            --resource-group "${RESOURCE_GROUP:-reeva-rg}" \
            --query "[].{Name:name,Active:properties.active,Health:properties.healthState,Provisioning:properties.provisioningState,Running:properties.runningState,Details:properties.runningStateDetails}" \
            -o table 2>/dev/null || true
        az containerapp logs show \
            --name "${APP_NAME:-reeva-mobile-app}" \
            --resource-group "${RESOURCE_GROUP:-reeva-rg}" \
            --tail 30 2>/dev/null || true
    fi
    exit "${exit_code}"
}
trap 'on_error $LINENO' ERR

# ------------------------------------------------------------------------------
# Configuration & Constants
# ------------------------------------------------------------------------------
RESOURCE_GROUP="reeva-rg"
LOCATION="centralindia"
STANDARD_ENV_NAME="reeva-standard-env"
LEGACY_EXPRESS_ENV_NAME="reeva-env"
LEGACY_EXPRESS_APP_NAME="reeva-mobile-test"
APP_NAME="reeva-mobile-app"
ACR_NAME="reevaacr20261031"
ACR_LOGIN_SERVER="reevaacr20261031-hpg2gjgtbxb6c5hv.azurecr.io"
IMAGE_REPOSITORY="reeva"
IMAGE_TAG="mobile-test"
FULL_IMAGE="${ACR_LOGIN_SERVER}/${IMAGE_REPOSITORY}:${IMAGE_TAG}"
TARGET_PORT=3000
WORKLOAD_PROFILE_NAME="Consumption"

# Hard safety assertions: never allow target names to collide with preserved legacy Express resources
if [ "${STANDARD_ENV_NAME}" = "${LEGACY_EXPRESS_ENV_NAME}" ]; then
    echo "FATAL: STANDARD_ENV_NAME ('${STANDARD_ENV_NAME}') must not equal LEGACY_EXPRESS_ENV_NAME ('${LEGACY_EXPRESS_ENV_NAME}')." >&2
    exit 1
fi
if [ "${APP_NAME}" = "${LEGACY_EXPRESS_APP_NAME}" ]; then
    echo "FATAL: APP_NAME ('${APP_NAME}') must not equal LEGACY_EXPRESS_APP_NAME ('${LEGACY_EXPRESS_APP_NAME}')." >&2
    exit 1
fi

# ------------------------------------------------------------------------------
# Helper: Classify Azure CLI Errors (Fail-Fast on Permanent/Unsupported Errors)
# ------------------------------------------------------------------------------
is_non_retryable_az_error() {
    local err_file=$1
    python3 - "$err_file" << 'PYEOF'
import re, sys

with open(sys.argv[1], "r", encoding="utf-8", errors="replace") as f:
    text = f.read()

fatal_patterns = [
    r"ExpressEnvironmentFeatureNotSupported",
    r"ExpressEnvironmentNotAvailableInRegion",
    r"FeatureNotSupported",
    r"NotSupported",
    r"InvalidParameter",
    r"InvalidArgument",
    r"Unrecognized arguments",
    r"BadRequest",
    r"InvalidTemplate",
    r"ValidationError",
    r"AuthorizationFailed",
    r"DisallowedByPolicy",
    r"RequestDisallowedByPolicy",
    r"QuotaExceeded",
    r"LocationNotAvailable",
    r"SubscriptionNotRegistered"
]

for pat in fatal_patterns:
    if re.search(pat, text, re.IGNORECASE):
        sys.exit(0)  # 0 = true (is non-retryable)

sys.exit(1)  # 1 = false (may be transient RBAC/token propagation)
PYEOF
}

echo "=================================================================="
echo " Starting Reeva Standard ACA Environment Migration & Deployment"
echo " Resource Group:       ${RESOURCE_GROUP}"
echo " Region:               ${LOCATION} (Central India)"
echo " Legacy Express Env:   ${LEGACY_EXPRESS_ENV_NAME} (preserved untouched)"
echo " Legacy Express App:   ${LEGACY_EXPRESS_APP_NAME} (preserved untouched)"
echo " Target Standard Env:  ${STANDARD_ENV_NAME} (WorkloadProfiles / Consumption)"
echo " Target Container App: ${APP_NAME}"
echo " Target Image:         ${FULL_IMAGE}"
echo " Target Port:          ${TARGET_PORT}"
echo " Feature Gates:        YouTube=ON, Twitter/X=ON, Pinterest=ON, Generic=ON"
echo "                       Instagram=OFF, TikTok=OFF, Facebook=OFF, AudioOnly=OFF"
echo "=================================================================="

# ------------------------------------------------------------------------------
# PHASE 1: AZURE CLI & CONTAINERAPPS EXTENSION COMPATIBILITY GATE
# ------------------------------------------------------------------------------
echo ""
echo "--> [Phase 1] Verifying Azure CLI & Container Apps extension compatibility..."

if ! command -v az >/dev/null 2>&1; then
    echo "ERROR: Azure CLI ('az') is not installed or not in PATH." >&2
    exit 1
fi

# Ensure Azure CLI installs missing extensions non-interactively if needed
az config set extension.use_dynamic_install=yes_without_prompt >/dev/null 2>&1 || true

# Verify active Azure subscription session
ACTIVE_SUB=$(az account show --query "{name:name,id:id,state:state}" -o json 2>/dev/null || true)
if [ -z "$ACTIVE_SUB" ]; then
    echo "ERROR: No active Azure CLI login session found. Run 'az login' first." >&2
    exit 1
fi
echo "Active Azure Account: ${ACTIVE_SUB}"

# Verify required flags on az containerapp subcommands to prevent silent fallback to Express
ENV_CREATE_HELP=$(az containerapp env create --help 2>&1 || true)
for req_flag in "--enable-workload-profiles" "--logs-destination" "--logs-workspace-id" "--logs-workspace-key"; do
    if ! echo "$ENV_CREATE_HELP" | grep -q -- "${req_flag}"; then
        echo "ERROR: Installed 'az containerapp env create' does not support required flag '${req_flag}'." >&2
        echo "Refusing to proceed to prevent silent fallback to an incompatible environment." >&2
        echo "Run: az extension add --name containerapp --upgrade" >&2
        exit 1
    fi
done

APP_CREATE_HELP=$(az containerapp create --help 2>&1 || true)
for req_flag in "--workload-profile-name" "--system-assigned" "--target-port" "--ingress" "--min-replicas" "--max-replicas" "--cpu" "--memory"; do
    if ! echo "$APP_CREATE_HELP" | grep -q -- "${req_flag}"; then
        echo "ERROR: Installed 'az containerapp create' does not support required flag '${req_flag}'." >&2
        echo "Run: az extension add --name containerapp --upgrade" >&2
        exit 1
    fi
done

REG_SET_HELP=$(az containerapp registry set --help 2>&1 || true)
for req_flag in "--server" "--identity"; do
    if ! echo "$REG_SET_HELP" | grep -q -- "${req_flag}"; then
        echo "ERROR: Installed 'az containerapp registry set' does not support required flag '${req_flag}'." >&2
        exit 1
    fi
done

APP_UPDATE_HELP=$(az containerapp update --help 2>&1 || true)
if ! echo "$APP_UPDATE_HELP" | grep -q -- "--yaml"; then
    echo "ERROR: Installed 'az containerapp update' does not support required flag '--yaml'." >&2
    exit 1
fi

echo "Verified Azure CLI & Container Apps extension support all required Standard Workload Profiles flags."

# ------------------------------------------------------------------------------
# PHASE 2: AZURE PROVIDER, LEGACY SNAPSHOT & STANDARD ENVIRONMENT VALIDATION
# ------------------------------------------------------------------------------
echo ""
echo "--> [Phase 2] Checking Azure provider registration and auditing environments..."

for NS in Microsoft.App Microsoft.OperationalInsights; do
    STATE=$(az provider show -n "$NS" --query "registrationState" -o tsv 2>/dev/null | tr -d '\r' || echo "NotRegistered")
    if [ "$STATE" != "Registered" ]; then
        echo "Registering provider $NS..."
        az provider register --namespace "$NS" --wait
    else
        echo "Provider $NS is Registered."
    fi
done

RG_EXISTS=$(az group show --name "${RESOURCE_GROUP}" --query "name" -o tsv 2>/dev/null | tr -d '\r' || true)
if [ -z "$RG_EXISTS" ]; then
    echo "ERROR: Target resource group '${RESOURCE_GROUP}' does not exist." >&2
    exit 1
fi

# Record baseline state of legacy Express resources (if present) to verify they remain untouched
LEGACY_ENV_PRE_ID=$(az containerapp env show --name "${LEGACY_EXPRESS_ENV_NAME}" --resource-group "${RESOURCE_GROUP}" --query "id" -o tsv 2>/dev/null | tr -d '\r' || true)
LEGACY_APP_PRE_REV=$(az containerapp show --name "${LEGACY_EXPRESS_APP_NAME}" --resource-group "${RESOURCE_GROUP}" --query "properties.latestRevisionName" -o tsv 2>/dev/null | tr -d '\r' || true)
if [ -n "$LEGACY_ENV_PRE_ID" ]; then
    echo "Preserving existing legacy environment '${LEGACY_EXPRESS_ENV_NAME}' (${LEGACY_ENV_PRE_ID})."
fi
if [ -n "$LEGACY_APP_PRE_REV" ]; then
    echo "Preserving existing legacy container app '${LEGACY_EXPRESS_APP_NAME}' (latestRevisionName: ${LEGACY_APP_PRE_REV})."
fi

echo "Auditing all Container Apps Environments in resource group '${RESOURCE_GROUP}'..."
az containerapp env list --resource-group "${RESOURCE_GROUP}" -o json > "${TMP_DIR}/envs.json"

ENV_EVAL=$(python3 - "${TMP_DIR}/envs.json" "${LOCATION}" "${STANDARD_ENV_NAME}" << 'PYEOF'
import json, sys

envs_path, expected_loc_raw, target_env_name = sys.argv[1], sys.argv[2], sys.argv[3]
expected_loc = expected_loc_raw.lower().replace(" ", "")

with open(envs_path, "r", encoding="utf-8") as f:
    envs = json.load(f)

if not isinstance(envs, list):
    print("ERROR: Unexpected response format from az containerapp env list.", file=sys.stderr)
    sys.exit(1)

def classify_env(env_obj):
    name = env_obj.get("name", "")
    env_id = env_obj.get("id", "")
    raw_loc = env_obj.get("location", "")
    norm_loc = raw_loc.lower().replace(" ", "")
    kind = (env_obj.get("kind") or "").lower()
    props = env_obj.get("properties") or {}
    state = props.get("provisioningState", "")
    env_mode = (props.get("environmentMode") or "").strip()
    plan_type = (props.get("planType") or "").strip()
    profiles = props.get("workloadProfiles")

    has_explicit_consumption_profile = False
    if isinstance(profiles, list):
        for p in profiles:
            if not isinstance(p, dict):
                continue
            p_type = (p.get("workloadProfileType") or "").strip().lower()
            p_name = (p.get("name") or "").strip().lower()
            if p_type == "consumption" and p_name == "consumption":
                has_explicit_consumption_profile = True
                break

    # Reject Express environments, ConsumptionOnly legacy environments, and any environment
    # without an explicit {"name": "Consumption", "workloadProfileType": "Consumption"} entry.
    mode_invalid = (
        env_mode.lower() in ("express", "consumptiononly")
        or (env_mode != "" and env_mode.lower() != "workloadprofiles")
        or plan_type.lower() in ("express", "consumptiononly")
    )
    is_incompatible = (
        mode_invalid
        or "express" in kind
        or not has_explicit_consumption_profile
    )
    return {
        "name": name,
        "id": env_id,
        "raw_loc": raw_loc,
        "norm_loc": norm_loc,
        "state": state,
        "env_mode": env_mode or plan_type or ("WorkloadProfiles" if has_explicit_consumption_profile else "Express/Legacy"),
        "has_consumption_profile": has_explicit_consumption_profile,
        "is_incompatible": is_incompatible
    }

classified = [classify_env(e) for e in envs]
for c in classified:
    status_label = "INCOMPATIBLE (Express/No-WorkloadProfiles)" if c["is_incompatible"] else "COMPATIBLE (Standard WorkloadProfiles)"
    print(
        f"  [Env Audit] Name: {c['name']} | Location: {c['raw_loc']} | State: {c['state']} | "
        f"Mode: {c['env_mode']} | ConsumptionProfile: {c['has_consumption_profile']} -> {status_label}",
        file=sys.stderr
    )

# Check if another standard environment exists with a different name
other_standard_envs = [c for c in classified if not c["is_incompatible"] and c["name"] != target_env_name]
target_matches = [c for c in classified if c["name"] == target_env_name]

if len(other_standard_envs) > 0 and len(target_matches) == 0:
    print(
        f"ERROR: Found existing standard environment(s) {[c['name'] for c in other_standard_envs]} "
        f"not matching target '{target_env_name}'. Refusing to arbitrarily select one.",
        file=sys.stderr
    )
    sys.exit(1)

if len(target_matches) == 0:
    print("CREATE_NEEDED")
    sys.exit(0)

t = target_matches[0]
if t["is_incompatible"]:
    print(
        f"ERROR: Target environment '{target_env_name}' is an Express or non-WorkloadProfiles environment "
        f"(Mode='{t['env_mode']}', ConsumptionProfile={t['has_consumption_profile']}). "
        f"Express environments do not support System-Assigned Managed Identity for ACR authentication.",
        file=sys.stderr
    )
    sys.exit(1)

if t["norm_loc"] != expected_loc:
    print(
        f"ERROR: Target environment '{target_env_name}' is in location '{t['raw_loc']}', "
        f"expected '{expected_loc_raw}' (Central India).",
        file=sys.stderr
    )
    sys.exit(1)

if t["state"] != "Succeeded":
    print(
        f"ERROR: Target environment '{target_env_name}' has provisioningState='{t['state']}' (expected 'Succeeded').",
        file=sys.stderr
    )
    sys.exit(1)

print(f"VERIFIED|{t['name']}|{t['id']}|{t['raw_loc']}")
PYEOF
)

if [ "$ENV_EVAL" = "CREATE_NEEDED" ]; then
    echo "Creating Standard Workload Profiles environment '${STANDARD_ENV_NAME}' in '${LOCATION}' with --enable-workload-profiles..."

    CREATE_ENV_ARGS=(
        --name "${STANDARD_ENV_NAME}"
        --resource-group "${RESOURCE_GROUP}"
        --location "${LOCATION}"
        --enable-workload-profiles
    )

    # Reuse existing Log Analytics workspace in reeva-rg if one already exists to avoid creating a duplicate workspace
    EXISTING_LAW_CUSTOMER_ID=$(az monitor log-analytics workspace list \
        --resource-group "${RESOURCE_GROUP}" \
        --query "[0].customerId" -o tsv 2>/dev/null | tr -d '\r' || true)
    EXISTING_LAW_NAME=$(az monitor log-analytics workspace list \
        --resource-group "${RESOURCE_GROUP}" \
        --query "[0].name" -o tsv 2>/dev/null | tr -d '\r' || true)

    if [ -n "$EXISTING_LAW_CUSTOMER_ID" ] && [ "$EXISTING_LAW_CUSTOMER_ID" != "null" ] && [ -n "$EXISTING_LAW_NAME" ]; then
        echo "Reusing existing Log Analytics workspace '${EXISTING_LAW_NAME}' in '${RESOURCE_GROUP}'..."
        EXISTING_LAW_KEY=$(az monitor log-analytics workspace get-shared-keys \
            --resource-group "${RESOURCE_GROUP}" \
            --workspace-name "${EXISTING_LAW_NAME}" \
            --query "primarySharedKey" -o tsv 2>/dev/null | tr -d '\r' || true)
        if [ -n "$EXISTING_LAW_KEY" ] && [ "$EXISTING_LAW_KEY" != "null" ]; then
            CREATE_ENV_ARGS+=(
                --logs-destination log-analytics
                --logs-workspace-id "${EXISTING_LAW_CUSTOMER_ID}"
                --logs-workspace-key "${EXISTING_LAW_KEY}"
            )
        fi
    fi

    az containerapp env create "${CREATE_ENV_ARGS[@]}"

    # Post-creation ARM metadata verification: reject Express or environments without explicit Consumption workload profile
    az containerapp env show \
        --name "${STANDARD_ENV_NAME}" \
        --resource-group "${RESOURCE_GROUP}" \
        -o json > "${TMP_DIR}/created_env.json"

    ENV_ID=$(python3 - "${TMP_DIR}/created_env.json" "${LOCATION}" << 'PYEOF'
import json, sys

env_path, expected_loc_raw = sys.argv[1], sys.argv[2]
expected_loc = expected_loc_raw.lower().replace(" ", "")
with open(env_path, "r", encoding="utf-8") as f:
    env = json.load(f)

props = env.get("properties") or {}
state = props.get("provisioningState", "")
env_mode = (props.get("environmentMode") or "").strip()
plan_type = (props.get("planType") or "").strip()
kind = (env.get("kind") or "").lower()
raw_loc = env.get("location", "")
norm_loc = raw_loc.lower().replace(" ", "")
profiles = props.get("workloadProfiles") or []

has_consumption = any(
    isinstance(p, dict)
    and (p.get("workloadProfileType") or "").strip().lower() == "consumption"
    and (p.get("name") or "").strip().lower() == "consumption"
    for p in profiles
)

mode_invalid = (
    env_mode.lower() in ("express", "consumptiononly")
    or (env_mode != "" and env_mode.lower() != "workloadprofiles")
    or plan_type.lower() in ("express", "consumptiononly")
)

if mode_invalid or "express" in kind or not has_consumption:
    print(
        f"ERROR: Newly created environment '{env.get('name')}' failed Standard WorkloadProfiles ARM verification "
        f"(environmentMode='{env_mode}', planType='{plan_type}', kind='{kind}', workloadProfiles={json.dumps(profiles)}).",
        file=sys.stderr
    )
    sys.exit(1)

if norm_loc != expected_loc or state != "Succeeded":
    print(f"ERROR: Environment provisioningState='{state}', location='{raw_loc}'.", file=sys.stderr)
    sys.exit(1)

print(env.get("id", ""))
PYEOF
    )
    ENV_ID=$(echo "$ENV_ID" | tr -d '\r')
    echo "Verified new Standard Workload Profiles environment: '${STANDARD_ENV_NAME}' (${ENV_ID})."
else
    IFS='|' read -r _ _ ENV_ID ENV_RAW_LOC <<< "$ENV_EVAL"
    echo "Verified existing Standard Workload Profiles environment: '${STANDARD_ENV_NAME}' (Location: ${ENV_RAW_LOC})."
fi

# ------------------------------------------------------------------------------
# PHASE 3: ACR METADATA, IMAGE DIGEST & TARGET APP REGISTRY AUTHENTICATION
# ------------------------------------------------------------------------------
echo ""
echo "--> [Phase 3] Validating ACR scope, image digest, and target Container App identity..."

ACR_ID=$(az acr show --name "${ACR_NAME}" --resource-group "${RESOURCE_GROUP}" --query id -o tsv | tr -d '\r')
DISCOVERED_SERVER=$(az acr show --name "${ACR_NAME}" --resource-group "${RESOURCE_GROUP}" --query loginServer -o tsv | tr -d '\r')

EXPECTED_ACR_SCOPE_SUFFIX="/resourcegroups/${RESOURCE_GROUP}/providers/microsoft.containerregistry/registries/${ACR_NAME}"
if [ -z "${ACR_ID}" ] || [[ "${ACR_ID,,}" != *"${EXPECTED_ACR_SCOPE_SUFFIX,,}" ]]; then
    echo "ERROR: ACR resource ID '${ACR_ID}' does not match expected registry scope suffix '${EXPECTED_ACR_SCOPE_SUFFIX}'." >&2
    exit 1
fi

if [ "${DISCOVERED_SERVER}" != "${ACR_LOGIN_SERVER}" ]; then
    echo "ERROR: Discovered ACR login server (${DISCOVERED_SERVER}) does not match expected (${ACR_LOGIN_SERVER})!" >&2
    exit 1
fi

EXPECTED_IMAGE_DIGEST=$(az acr repository show \
    --name "${ACR_NAME}" \
    --image "${IMAGE_REPOSITORY}:${IMAGE_TAG}" \
    --query "digest" -o tsv | tr -d '\r')

if [[ ! "${EXPECTED_IMAGE_DIGEST}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "ERROR: Image '${FULL_IMAGE}' did not return a valid sha256 digest from ACR '${ACR_NAME}' (got: '${EXPECTED_IMAGE_DIGEST}')." >&2
    exit 1
fi
echo "Verified ACR Resource ID: ${ACR_ID}"
echo "Verified ACR Login Server: ${ACR_LOGIN_SERVER}"
echo "Verified ACR Image Digest (${IMAGE_REPOSITORY}:${IMAGE_TAG}): ${EXPECTED_IMAGE_DIGEST}"

if az containerapp show --name "${APP_NAME}" --resource-group "${RESOURCE_GROUP}" -o json > "${TMP_DIR}/existing_app.json" 2>/dev/null; then
    echo "Existing Container App '${APP_NAME}' detected. Auditing current configuration before modification..."
    python3 - "${TMP_DIR}/existing_app.json" "${ENV_ID}" "${WORKLOAD_PROFILE_NAME}" << 'PYEOF'
import json, sys

app_path, expected_env_id, expected_wp = sys.argv[1], sys.argv[2], sys.argv[3]
with open(app_path, "r", encoding="utf-8") as f:
    app = json.load(f)

props = app.get("properties") or {}
actual_env_id = props.get("environmentId") or props.get("managedEnvironmentId") or ""
if actual_env_id.lower() != expected_env_id.lower():
    print(
        f"ERROR: Existing Container App '{app.get('name')}' is bound to environment '{actual_env_id}', "
        f"which does NOT match standard environment '{expected_env_id}'. "
        f"Refusing to modify an app on an incompatible environment.",
        file=sys.stderr
    )
    sys.exit(1)

wp_name = props.get("workloadProfileName") or ""
if wp_name and wp_name.lower() != expected_wp.lower():
    print(
        f"ERROR: Existing Container App uses workloadProfileName='{wp_name}' (expected '{expected_wp}').",
        file=sys.stderr
    )
    sys.exit(1)

identity = app.get("identity") or {}
config = props.get("configuration") or {}
ingress = config.get("ingress") or {}
template = props.get("template") or {}
scale = template.get("scale") or {}
containers = template.get("containers") or []
env_names = [e.get("name") for e in (containers[0].get("env") or []) if e.get("name")] if containers else []

print("  [Audit] Environment ID:      ", actual_env_id)
print("  [Audit] Workload Profile:    ", wp_name or "Consumption")
print("  [Audit] Identity Type:       ", identity.get("type", "None"))
print("  [Audit] Principal ID:        ", identity.get("principalId", "None"))
print("  [Audit] Active Revisions:    ", config.get("activeRevisionsMode", "Single"))
print("  [Audit] Latest Revision:     ", props.get("latestRevisionName", "None"))
print("  [Audit] Current Image:       ", containers[0].get("image") if containers else "None")
print("  [Audit] Ingress External:    ", ingress.get("external"))
print("  [Audit] Ingress TargetPort:  ", ingress.get("targetPort"))
print("  [Audit] Ingress AllowInsec:  ", ingress.get("allowInsecure"))
print("  [Audit] Ingress FQDN:        ", ingress.get("fqdn", "None"))
print("  [Audit] Scale Min/Max:       ", f"{scale.get('minReplicas')} / {scale.get('maxReplicas')}")
print("  [Audit] Existing Env Keys:   ", ", ".join(env_names) if env_names else "(none)")
PYEOF
else
    echo "Creating replacement Container App '${APP_NAME}' in Standard environment '${STANDARD_ENV_NAME}' with bootstrap image..."
    az containerapp create \
        --name "${APP_NAME}" \
        --resource-group "${RESOURCE_GROUP}" \
        --environment "${STANDARD_ENV_NAME}" \
        --workload-profile-name "${WORKLOAD_PROFILE_NAME}" \
        --system-assigned \
        --image "mcr.microsoft.com/k8se/quickstart:latest" \
        --target-port "${TARGET_PORT}" \
        --ingress external \
        --min-replicas 0 \
        --max-replicas 1 \
        --cpu 0.5 \
        --memory 1.0Gi
fi

echo "Retrieving System-Assigned Managed Identity Principal ID for '${APP_NAME}'..."
PRINCIPAL_ID=$(az containerapp identity show \
    --name "${APP_NAME}" \
    --resource-group "${RESOURCE_GROUP}" \
    --query principalId -o tsv 2>/dev/null | tr -d '\r' || true)

if [ -z "$PRINCIPAL_ID" ] || [ "$PRINCIPAL_ID" = "null" ]; then
    echo "Enabling System-Assigned Managed Identity on ${APP_NAME} (preserving any existing identities)..."
    az containerapp identity assign \
        --name "${APP_NAME}" \
        --resource-group "${RESOURCE_GROUP}" \
        --system-assigned
    PRINCIPAL_ID=$(az containerapp identity show \
        --name "${APP_NAME}" \
        --resource-group "${RESOURCE_GROUP}" \
        --query principalId -o tsv | tr -d '\r')
fi

if [ -z "$PRINCIPAL_ID" ] || [ "$PRINCIPAL_ID" = "null" ]; then
    echo "ERROR: Failed to obtain System-Assigned Managed Identity Principal ID for '${APP_NAME}'." >&2
    exit 1
fi
echo "System-Assigned Principal ID: ${PRINCIPAL_ID}"

echo "Verifying / granting least-privilege 'AcrPull' role assignment at registry scope '${ACR_ID}'..."
az role assignment list \
    --assignee "${PRINCIPAL_ID}" \
    --scope "${ACR_ID}" \
    -o json > "${TMP_DIR}/role_assignments.json"

HAS_ACRPULL=$(python3 - "${TMP_DIR}/role_assignments.json" "${PRINCIPAL_ID}" "${ACR_ID}" << 'PYEOF'
import json, sys

roles_path, expected_principal, expected_scope = sys.argv[1], sys.argv[2].lower(), sys.argv[3].lower()
with open(roles_path, "r", encoding="utf-8") as f:
    roles = json.load(f)

matched = [
    r.get("id") for r in (roles if isinstance(roles, list) else [])
    if (r.get("roleDefinitionName") or "") == "AcrPull"
    and (r.get("principalId") or "").lower() == expected_principal
    and (r.get("scope") or "").lower() == expected_scope
]
print(matched[0] if matched else "")
PYEOF
)
HAS_ACRPULL=$(echo "$HAS_ACRPULL" | tr -d '\r')

if [ -z "$HAS_ACRPULL" ]; then
    echo "Creating AcrPull role assignment for Managed Identity (${PRINCIPAL_ID}) at scope '${ACR_ID}'..."
    az role assignment create \
        --assignee-object-id "${PRINCIPAL_ID}" \
        --assignee-principal-type ServicePrincipal \
        --role "AcrPull" \
        --scope "${ACR_ID}"

    echo "Polling Azure RBAC for AcrPull role propagation at registry scope..."
    MAX_ATTEMPTS=12
    ATTEMPT=1
    ROLE_CONFIRMED=""
    while [ $ATTEMPT -le $MAX_ATTEMPTS ]; do
        az role assignment list \
            --assignee "${PRINCIPAL_ID}" \
            --scope "${ACR_ID}" \
            -o json > "${TMP_DIR}/role_assignments.json"
        ROLE_CONFIRMED=$(python3 - "${TMP_DIR}/role_assignments.json" "${PRINCIPAL_ID}" "${ACR_ID}" << 'PYEOF'
import json, sys

roles_path, expected_principal, expected_scope = sys.argv[1], sys.argv[2].lower(), sys.argv[3].lower()
with open(roles_path, "r", encoding="utf-8") as f:
    roles = json.load(f)

matched = [
    r.get("id") for r in (roles if isinstance(roles, list) else [])
    if (r.get("roleDefinitionName") or "") == "AcrPull"
    and (r.get("principalId") or "").lower() == expected_principal
    and (r.get("scope") or "").lower() == expected_scope
]
print(matched[0] if matched else "")
PYEOF
        )
        ROLE_CONFIRMED=$(echo "$ROLE_CONFIRMED" | tr -d '\r')
        if [ -n "$ROLE_CONFIRMED" ]; then
            echo "AcrPull role verified in ARM at exact registry scope on attempt ${ATTEMPT} (${ROLE_CONFIRMED})."
            break
        fi
        echo "Waiting for role assignment visibility (attempt ${ATTEMPT}/${MAX_ATTEMPTS})..."
        sleep 5
        ATTEMPT=$((ATTEMPT + 1))
    done

    if [ -z "$ROLE_CONFIRMED" ]; then
        echo "ERROR: AcrPull role assignment did not propagate at scope '${ACR_ID}' within 60 seconds." >&2
        exit 1
    fi

    echo "Allowing 20s buffer for ACR data-plane token cache propagation..."
    sleep 20
else
    echo "AcrPull role assignment already confirmed at exact registry scope (${HAS_ACRPULL})."
fi

echo "Configuring Container App registry authentication with system managed identity..."
REG_SET_OK=false
for attempt in 1 2 3; do
    if az containerapp registry set \
        --name "${APP_NAME}" \
        --resource-group "${RESOURCE_GROUP}" \
        --server "${ACR_LOGIN_SERVER}" \
        --identity system > "${TMP_DIR}/reg_set.out" 2> "${TMP_DIR}/reg_set.err"; then
        REG_SET_OK=true
        break
    fi

    cat "${TMP_DIR}/reg_set.err" >&2
    if is_non_retryable_az_error "${TMP_DIR}/reg_set.err"; then
        echo "FATAL: Azure rejected registry configuration with a non-retryable platform/configuration error. Aborting immediately." >&2
        exit 1
    fi

    if [ "$attempt" -lt 3 ]; then
        echo "Transient RBAC/token delay during registry binding (attempt ${attempt}/3). Retrying in 15s..."
        sleep 15
    fi
done

if [ "$REG_SET_OK" != true ]; then
    echo "ERROR: Failed to bind ACR registry '${ACR_LOGIN_SERVER}' using system identity on '${APP_NAME}'." >&2
    exit 1
fi

# Explicitly verify registry authentication & identity in ARM configuration BEFORE deploying the Reeva image
az containerapp show \
    --name "${APP_NAME}" \
    --resource-group "${RESOURCE_GROUP}" \
    -o json > "${TMP_DIR}/current_app_pre_update.json"

python3 - "${TMP_DIR}/current_app_pre_update.json" "${ACR_LOGIN_SERVER}" "${ENV_ID}" "${PRINCIPAL_ID}" << 'PYEOF'
import json, sys

app_path, expected_server, expected_env_id, expected_principal = (
    sys.argv[1],
    sys.argv[2].lower(),
    sys.argv[3].lower(),
    sys.argv[4].lower()
)
with open(app_path, "r", encoding="utf-8") as f:
    app = json.load(f)

props = app.get("properties") or {}
actual_env_id = (props.get("environmentId") or props.get("managedEnvironmentId") or "").lower()
if actual_env_id != expected_env_id:
    print(f"ERROR: Pre-deploy check failed: environmentId '{actual_env_id}' != '{expected_env_id}'.", file=sys.stderr)
    sys.exit(1)

identity = app.get("identity") or {}
id_type = identity.get("type") or ""
actual_principal = (identity.get("principalId") or "").lower()
if "systemassigned" not in id_type.lower() or actual_principal != expected_principal:
    print(
        f"ERROR: Pre-deploy check failed: SystemAssigned identity mismatch (type='{id_type}', principalId='{actual_principal}').",
        file=sys.stderr
    )
    sys.exit(1)

registries = ((props.get("configuration") or {}).get("registries") or [])
matched = [
    r for r in registries
    if (r.get("server") or "").lower() == expected_server and (r.get("identity") or "").lower() == "system"
]
if not matched:
    print(
        f"ERROR: Registry '{expected_server}' with identity='system' was not found in Container App configuration: "
        f"{json.dumps(registries)}",
        file=sys.stderr
    )
    sys.exit(1)

for r in matched:
    if r.get("username") or r.get("passwordSecretRef"):
        print(
            f"ERROR: Registry '{expected_server}' contains admin username/passwordSecretRef; only passwordless managed identity is permitted.",
            file=sys.stderr
        )
        sys.exit(1)

print(
    f"Verified pre-deployment ARM registry authentication: server='{expected_server}', "
    f"identity='system', principalId='{actual_principal}'."
)
PYEOF

# ------------------------------------------------------------------------------
# PHASE 4: DECLARATIVE DEPLOYMENT WITH PROBES & SAFE CONFIG MERGE
# ------------------------------------------------------------------------------
echo ""
echo "--> [Phase 4] Preparing declarative YAML update with /health & /ready probes and selective gates..."

python3 - "${TMP_DIR}/current_app_pre_update.json" "${TMP_DIR}/reeva_update.yaml" "${FULL_IMAGE}" "${TARGET_PORT}" "${WORKLOAD_PROFILE_NAME}" << 'PYEOF'
import json, sys

src_json, dst_yaml, full_image, target_port_str, wp_name = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
target_port = int(target_port_str)

with open(src_json, "r", encoding="utf-8") as f:
    app = json.load(f)

props = app.get("properties") or {}
config = props.get("configuration") or {}
ingress = dict(config.get("ingress") or {})

# Ensure external HTTPS ingress on port 3000 while preserving existing customDomains, traffic, ipSecurityRestrictions, etc.
ingress["external"] = True
ingress["targetPort"] = target_port
ingress["allowInsecure"] = False
if not ingress.get("transport"):
    ingress["transport"] = "auto"

template = props.get("template") or {}
containers = template.get("containers") or [{}]
container = dict(containers[0])

container["name"] = container.get("name") or app.get("name") or "reeva-mobile-app"
container["image"] = full_image

resources = dict(container.get("resources") or {})
resources["cpu"] = 0.5
resources["memory"] = "1.0Gi"
container["resources"] = resources

# Merge environment variables: preserve existing unrelated env vars, remove redundant alias keys, set canonical Reeva config
existing_env = container.get("env") or []
desired_env = {
    "NODE_ENV": "production",
    "PORT": str(target_port),
    "TRUST_PROXY": "1",
    "REEVA_ENABLE_YOUTUBE": "true",
    "REEVA_ENABLE_TWITTER": "true",
    "REEVA_ENABLE_PINTEREST": "true",
    "REEVA_ENABLE_GENERIC": "true",
    "REEVA_ENABLE_INSTAGRAM": "false",
    "REEVA_ENABLE_TIKTOK": "false",
    "REEVA_ENABLE_FACEBOOK": "false",
    "REEVA_ENABLE_AUDIO_ONLY": "false"
}
deprecated_aliases = {"REEVA_ENABLE_MORE_SITES", "REEVA_ENABLE_X", "REEVA_ENABLE_AUDIO"}

merged_env = []
seen = set()
for item in existing_env:
    k = item.get("name")
    if not k or k in deprecated_aliases:
        continue
    if k in desired_env:
        merged_env.append({"name": k, "value": desired_env[k]})
        seen.add(k)
    else:
        # Preserve unrelated environment variable (including value or secretRef)
        merged_env.append(item)
        seen.add(k)

for k, v in desired_env.items():
    if k not in seen:
        merged_env.append({"name": k, "value": v})

container["env"] = merged_env

# Configure Startup, Readiness (/ready), and Liveness (/health) HTTP probes on port 3000
container["probes"] = [
    {
        "type": "Startup",
        "httpGet": {
            "path": "/ready",
            "port": target_port,
            "scheme": "HTTP"
        },
        "initialDelaySeconds": 5,
        "periodSeconds": 5,
        "timeoutSeconds": 3,
        "successThreshold": 1,
        "failureThreshold": 12
    },
    {
        "type": "Readiness",
        "httpGet": {
            "path": "/ready",
            "port": target_port,
            "scheme": "HTTP"
        },
        "initialDelaySeconds": 5,
        "periodSeconds": 10,
        "timeoutSeconds": 3,
        "successThreshold": 1,
        "failureThreshold": 3
    },
    {
        "type": "Liveness",
        "httpGet": {
            "path": "/health",
            "port": target_port,
            "scheme": "HTTP"
        },
        "initialDelaySeconds": 15,
        "periodSeconds": 15,
        "timeoutSeconds": 3,
        "successThreshold": 1,
        "failureThreshold": 3
    }
]

scale = dict(template.get("scale") or {})
scale["minReplicas"] = 0
scale["maxReplicas"] = 1

update_payload = {
    "properties": {
        "workloadProfileName": wp_name,
        "configuration": {
            "ingress": ingress
        },
        "template": {
            "containers": [container],
            "scale": scale
        }
    }
}
if config.get("registries"):
    update_payload["properties"]["configuration"]["registries"] = config["registries"]
if template.get("volumes"):
    update_payload["properties"]["template"]["volumes"] = template["volumes"]

try:
    import yaml
    with open(dst_yaml, "w", encoding="utf-8") as out:
        yaml.safe_dump(update_payload, out, default_flow_style=False, sort_keys=False)
except ImportError:
    with open(dst_yaml, "w", encoding="utf-8") as out:
        json.dump(update_payload, out, indent=2)
PYEOF

echo "Deploying Reeva image '${FULL_IMAGE}' (${EXPECTED_IMAGE_DIGEST}) to '${APP_NAME}'..."
DEPLOY_OK=false
for attempt in 1 2 3; do
    if az containerapp update \
        --name "${APP_NAME}" \
        --resource-group "${RESOURCE_GROUP}" \
        --yaml "${TMP_DIR}/reeva_update.yaml" > "${TMP_DIR}/app_update.out" 2> "${TMP_DIR}/app_update.err"; then
        DEPLOY_OK=true
        break
    fi

    cat "${TMP_DIR}/app_update.err" >&2
    if is_non_retryable_az_error "${TMP_DIR}/app_update.err"; then
        echo "FATAL: Azure rejected container app update with a non-retryable platform/configuration error. Aborting immediately." >&2
        exit 1
    fi

    if [ "$attempt" -lt 3 ]; then
        echo "Transient image pull/token delay during container update (attempt ${attempt}/3). Retrying in 15s..."
        sleep 15
    fi
done

if [ "$DEPLOY_OK" != true ]; then
    echo "ERROR: Failed to update Container App '${APP_NAME}' with image '${FULL_IMAGE}'." >&2
    exit 1
fi

# ------------------------------------------------------------------------------
# PHASE 5: LIVE VERIFICATION, REVISION & DIGEST AUDIT, AND HEALTH CHECKS
# ------------------------------------------------------------------------------
echo ""
echo "--> [Phase 5] Verifying deployed revision, image digest, probes, legacy preservation, and live endpoints..."

# Confirm ACR image digest has not mutated and remains valid
POST_DEPLOY_IMAGE_DIGEST=$(az acr repository show \
    --name "${ACR_NAME}" \
    --image "${IMAGE_REPOSITORY}:${IMAGE_TAG}" \
    --query "digest" -o tsv | tr -d '\r')

if [ "${POST_DEPLOY_IMAGE_DIGEST}" != "${EXPECTED_IMAGE_DIGEST}" ]; then
    echo "ERROR: ACR image digest changed during deployment (expected '${EXPECTED_IMAGE_DIGEST}', found '${POST_DEPLOY_IMAGE_DIGEST}')." >&2
    exit 1
fi

az containerapp show \
    --name "${APP_NAME}" \
    --resource-group "${RESOURCE_GROUP}" \
    -o json > "${TMP_DIR}/post_update_app.json"

READ_OUT=$(python3 - "${TMP_DIR}/post_update_app.json" "${TARGET_PORT}" "${FULL_IMAGE}" << 'PYEOF'
import json, sys

app_path, target_port, expected_image = sys.argv[1], int(sys.argv[2]), sys.argv[3]
with open(app_path, "r", encoding="utf-8") as f:
    app = json.load(f)

props = app.get("properties") or {}
state = props.get("provisioningState")
if state != "Succeeded":
    print(f"ERROR: Container App provisioningState is '{state}' (expected 'Succeeded').", file=sys.stderr)
    sys.exit(1)

latest_rev = props.get("latestRevisionName") or ""
latest_ready_rev = props.get("latestReadyRevisionName") or ""
if not latest_rev or latest_rev != latest_ready_rev:
    print(
        f"ERROR: Latest revision '{latest_rev}' does not match latestReadyRevisionName '{latest_ready_rev}'.",
        file=sys.stderr
    )
    sys.exit(1)

ingress = (props.get("configuration") or {}).get("ingress") or {}
if not ingress.get("external") or ingress.get("targetPort") != target_port or ingress.get("allowInsecure"):
    print(f"ERROR: Ingress verification failed: {json.dumps(ingress)}", file=sys.stderr)
    sys.exit(1)

containers = (props.get("template") or {}).get("containers") or []
if not containers:
    print("ERROR: No containers found in template.", file=sys.stderr)
    sys.exit(1)

actual_image = containers[0].get("image") or ""
if actual_image != expected_image:
    print(
        f"ERROR: Deployed container image '{actual_image}' does not match expected '{expected_image}'!",
        file=sys.stderr
    )
    sys.exit(1)

probes = {p.get("type"): p for p in (containers[0].get("probes") or [])}
liveness = probes.get("Liveness") or {}
readiness = probes.get("Readiness") or {}
if (liveness.get("httpGet") or {}).get("path") != "/health" or (liveness.get("httpGet") or {}).get("port") != target_port:
    print(f"ERROR: Liveness probe not configured on GET /health:{target_port}. Found: {json.dumps(liveness)}", file=sys.stderr)
    sys.exit(1)

if (readiness.get("httpGet") or {}).get("path") != "/ready" or (readiness.get("httpGet") or {}).get("port") != target_port:
    print(f"ERROR: Readiness probe not configured on GET /ready:{target_port}. Found: {json.dumps(readiness)}", file=sys.stderr)
    sys.exit(1)

fqdn = ingress.get("fqdn") or ""
if not fqdn:
    print("ERROR: Ingress FQDN is empty.", file=sys.stderr)
    sys.exit(1)

print(f"{fqdn}|{latest_ready_rev}|{actual_image}")
PYEOF
)
READ_OUT=$(echo "$READ_OUT" | tr -d '\r')
IFS='|' read -r FQDN ACTIVE_REVISION DEPLOYED_IMAGE <<< "$READ_OUT"

PUBLIC_URL="https://${FQDN}"
echo "Verified ACR Image Digest: ${EXPECTED_IMAGE_DIGEST}"
echo "Verified Platform Probes:  Liveness (GET /health:3000), Readiness (GET /ready:3000), Startup (GET /ready:3000)"
echo "Public Application URL:    ${PUBLIC_URL}"

echo "Polling application readiness probe (${PUBLIC_URL}/ready)..."
READY=false
for i in {1..15}; do
    STATUS_CODE=$(curl -s -o "${TMP_DIR}/reeva_ready.json" -w "%{http_code}" "${PUBLIC_URL}/ready" || echo "000")
    if [ "$STATUS_CODE" = "200" ]; then
        if python3 -c 'import json, sys; d = json.load(open(sys.argv[1], encoding="utf-8")); sys.exit(0 if d.get("status") == "ready" else 1)' "${TMP_DIR}/reeva_ready.json" 2>/dev/null; then
            echo "Application reported HTTP 200 and JSON status='ready' on attempt $i."
            READY=true
            break
        fi
    fi
    echo "Waiting for application startup preflight (HTTP ${STATUS_CODE}, attempt $i/15)..."
    sleep 5
done

if [ "$READY" != true ]; then
    echo "ERROR: Application /ready endpoint did not return HTTP 200 with status='ready' within 75 seconds." >&2
    echo "Fetching container logs for failure diagnosis..." >&2
    az containerapp logs show \
        --name "${APP_NAME}" \
        --resource-group "${RESOURCE_GROUP}" \
        --tail 50 || true
    exit 1
fi

echo ""
echo "Verifying Liveness Probe (${PUBLIC_URL}/health):"
HEALTH_CODE=$(curl -s -o "${TMP_DIR}/reeva_health.json" -w "%{http_code}" "${PUBLIC_URL}/health" || echo "000")
cat "${TMP_DIR}/reeva_health.json"
echo ""
if [ "$HEALTH_CODE" != "200" ]; then
    echo "ERROR: Liveness probe /health returned HTTP ${HEALTH_CODE} (expected 200)." >&2
    exit 1
fi
python3 - "${TMP_DIR}/reeva_health.json" << 'PYEOF'
import json, sys

with open(sys.argv[1], "r", encoding="utf-8") as f:
    data = json.load(f)

if data.get("status") != "ok" or not isinstance(data.get("timestamp"), str):
    print(f"ERROR: Unexpected /health payload: {json.dumps(data)}", file=sys.stderr)
    sys.exit(1)

print("Verified /health JSON payload (status='ok').")
PYEOF

echo ""
echo "Verifying Readiness Probe (${PUBLIC_URL}/ready):"
cat "${TMP_DIR}/reeva_ready.json"
echo ""

echo ""
echo "Verifying Production Feature Gates (${PUBLIC_URL}/api/capabilities):"
CAP_CODE=$(curl -s -o "${TMP_DIR}/reeva_caps.json" -w "%{http_code}" "${PUBLIC_URL}/api/capabilities" || echo "000")
cat "${TMP_DIR}/reeva_caps.json"
echo ""
if [ "$CAP_CODE" != "200" ]; then
    echo "ERROR: Capabilities endpoint /api/capabilities returned HTTP ${CAP_CODE} (expected 200)." >&2
    exit 1
fi

python3 - "${TMP_DIR}/reeva_caps.json" << 'PYEOF'
import json, sys

with open(sys.argv[1], "r", encoding="utf-8") as f:
    data = json.load(f)

caps = data.get("capabilities") or {}
platforms = caps.get("platforms") or {}
expected = {
    "youtube": True,
    "twitter": True,
    "pinterest": True,
    "generic": True,
    "instagram": False,
    "tiktok": False,
    "facebook": False
}
for k, exp_val in expected.items():
    actual_val = platforms.get(k)
    if actual_val is not exp_val:
        print(f"ERROR: Feature gate mismatch for '{k}': expected {exp_val}, got {actual_val}", file=sys.stderr)
        sys.exit(1)

if caps.get("audioOnly") is not False:
    print(f"ERROR: Expected audioOnly=False, got {caps.get('audioOnly')}", file=sys.stderr)
    sys.exit(1)

print("Verified live capabilities match expected production feature gates.")
PYEOF

# Inspect the active revision details directly after traffic/probe validation
az containerapp revision show \
    --name "${APP_NAME}" \
    --resource-group "${RESOURCE_GROUP}" \
    --revision "${ACTIVE_REVISION}" \
    -o json > "${TMP_DIR}/active_revision.json"

python3 - "${TMP_DIR}/active_revision.json" "${FULL_IMAGE}" << 'PYEOF'
import json, sys

rev_path, expected_image = sys.argv[1], sys.argv[2]
with open(rev_path, "r", encoding="utf-8") as f:
    rev = json.load(f)

props = rev.get("properties") or {}
active = props.get("active")
prov_state = props.get("provisioningState")
health_state = props.get("healthState")
running_state = props.get("runningState")
containers = (props.get("template") or {}).get("containers") or []
rev_image = containers[0].get("image") if containers else ""

if not active or prov_state != "Provisioned" or health_state == "Unhealthy":
    print(
        f"ERROR: Revision '{rev.get('name')}' unhealthy or unprovisioned: "
        f"active={active}, provisioningState={prov_state}, healthState={health_state}, runningState={running_state}",
        file=sys.stderr
    )
    sys.exit(1)

if rev_image != expected_image:
    print(f"ERROR: Revision image '{rev_image}' != '{expected_image}'.", file=sys.stderr)
    sys.exit(1)

print(
    f"Verified Active Revision: {rev.get('name')} | Provisioning={prov_state} | "
    f"Health={health_state} | Running={running_state} | Image={rev_image}"
)
PYEOF

# Verify legacy Express resources were preserved untouched
if [ -n "$LEGACY_ENV_PRE_ID" ]; then
    LEGACY_ENV_POST_ID=$(az containerapp env show --name "${LEGACY_EXPRESS_ENV_NAME}" --resource-group "${RESOURCE_GROUP}" --query "id" -o tsv 2>/dev/null | tr -d '\r' || true)
    if [ "$LEGACY_ENV_POST_ID" != "$LEGACY_ENV_PRE_ID" ]; then
        echo "ERROR: Legacy environment '${LEGACY_EXPRESS_ENV_NAME}' state changed unexpectedly!" >&2
        exit 1
    fi
    echo "Verified legacy environment '${LEGACY_EXPRESS_ENV_NAME}' preserved untouched."
fi
if [ -n "$LEGACY_APP_PRE_REV" ]; then
    LEGACY_APP_POST_REV=$(az containerapp show --name "${LEGACY_EXPRESS_APP_NAME}" --resource-group "${RESOURCE_GROUP}" --query "properties.latestRevisionName" -o tsv 2>/dev/null | tr -d '\r' || true)
    if [ "$LEGACY_APP_POST_REV" != "$LEGACY_APP_PRE_REV" ]; then
        echo "ERROR: Legacy container app '${LEGACY_EXPRESS_APP_NAME}' revision changed unexpectedly!" >&2
        exit 1
    fi
    echo "Verified legacy container app '${LEGACY_EXPRESS_APP_NAME}' preserved untouched (revision: ${LEGACY_APP_POST_REV})."
fi

echo ""
echo "Fetching recent application container logs..."
az containerapp logs show \
    --name "${APP_NAME}" \
    --resource-group "${RESOURCE_GROUP}" \
    --tail 30 || true

echo ""
echo "=================================================================="
echo " Deployment Succeeded & Verified Live!"
echo " Standard Environment:   ${STANDARD_ENV_NAME}"
echo " Container App:          ${APP_NAME}"
echo " Active Revision:        ${ACTIVE_REVISION}"
echo " Deployed Image:         ${DEPLOYED_IMAGE}"
echo " Image Digest:           ${EXPECTED_IMAGE_DIGEST}"
echo " Public Mobile Test URL: ${PUBLIC_URL}"
echo " Health Endpoint:        ${PUBLIC_URL}/health"
echo " Readiness Endpoint:     ${PUBLIC_URL}/ready"
echo " Capabilities Endpoint:  ${PUBLIC_URL}/api/capabilities"
echo "=================================================================="
