#!/usr/bin/env bash
# ==============================================================================
# Reeva — Azure Container Apps Standard Environment Migration & Deployment Script
# Subscription: Azure for Students | RG: reeva-rg | Region: Central India
# ==============================================================================
#
# Architectural Note:
# 1. Azure Container Apps "Express" environments (environmentMode: Express) do NOT
#    support System-Assigned Managed Identity for private ACR authentication
#    (error: ExpressEnvironmentFeatureNotSupported).
# 2. Live Azure ARM metadata (api-version=2026-07-01) confirmed that Express
#    environments ALSO include a Consumption workload profile entry:
#      {
#        "environmentMode": "Express",
#        "workloadProfiles": [{"name": "Consumption", "workloadProfileType": "Consumption"}]
#      }
#    Meanwhile, older CLI show/list API versions (e.g. 2025-10-02-preview in
#    containerapp extension 1.3.0b5) omit environmentMode (returning null).
# 3. Therefore, this script NEVER infers a Standard environment from workloadProfiles
#    containing Consumption or from a Container App's workloadProfileName. Instead,
#    it queries authoritative ARM metadata directly via:
#      az rest --method get --url "https://management.azure.com${ENVIRONMENT_RESOURCE_ID}?api-version=2026-07-01"
#    and accepts an environment ONLY when authoritative ARM metadata explicitly confirms
#    properties.environmentMode == "WorkloadProfiles" AND an explicit Consumption profile,
#    with zero Express indicators. If environmentMode is missing or ambiguous, it fails closed.
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
ARM_ENV_API_VERSION="2026-07-01"

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
# Authoritative ARM Environment Metadata Fetcher & Classifier
# ------------------------------------------------------------------------------
fetch_authoritative_env_arm_json() {
    local env_resource_id=$1
    local out_file=$2

    if [[ -z "${env_resource_id}" || ! "${env_resource_id}" =~ ^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/Microsoft\.App/managedEnvironments/[^/]+$ ]]; then
        echo "ERROR: Invalid Managed Environment ARM Resource ID: '${env_resource_id}'" >&2
        return 1
    fi

    az rest --method get \
        --url "https://management.azure.com${env_resource_id}?api-version=${ARM_ENV_API_VERSION}" \
        -o json > "${out_file}"
}

write_env_classifier_module() {
    cat > "${TMP_DIR}/aca_env_classifier.py" << 'PYEOF'
# BEGIN_ACA_ENV_CLASSIFIER
import json
import sys


def _extract_env_metadata(obj):
    if not isinstance(obj, dict):
        return {
            "present": False,
            "name": "",
            "id": "",
            "location": "",
            "norm_location": "",
            "kind": "",
            "provisioning_state": "",
            "environment_mode": "",
            "plan_type": "",
            "workload_profiles": None,
            "has_consumption_profile": False,
            "has_express_indicator": False
        }

    props = obj.get("properties") if isinstance(obj.get("properties"), dict) else obj
    name = (obj.get("name") or props.get("name") or "").strip()
    env_id = (obj.get("id") or props.get("id") or "").strip()
    raw_loc = (obj.get("location") or props.get("location") or "").strip()
    norm_loc = raw_loc.lower().replace(" ", "")
    kind = (obj.get("kind") or props.get("kind") or "").strip()
    state = (props.get("provisioningState") or obj.get("provisioningState") or "").strip()

    raw_mode = props.get("environmentMode") if "environmentMode" in props else obj.get("environmentMode")
    env_mode = raw_mode.strip() if isinstance(raw_mode, str) else ""

    raw_plan = props.get("planType") if "planType" in props else obj.get("planType")
    plan_type = raw_plan.strip() if isinstance(raw_plan, str) else ""

    profiles = props.get("workloadProfiles") if "workloadProfiles" in props else obj.get("workloadProfiles")
    has_consumption_profile = False
    if isinstance(profiles, list):
        for p in profiles:
            if not isinstance(p, dict):
                continue
            p_name = (p.get("name") or "").strip().lower()
            p_type = (p.get("workloadProfileType") or "").strip().lower()
            if p_name == "consumption" and p_type == "consumption":
                has_consumption_profile = True
                break

    has_express_indicator = (
        env_mode.lower() == "express"
        or plan_type.lower() == "express"
        or "express" in kind.lower()
    )

    return {
        "present": True,
        "name": name,
        "id": env_id,
        "location": raw_loc,
        "norm_location": norm_loc,
        "kind": kind,
        "provisioning_state": state,
        "environment_mode": env_mode,
        "plan_type": plan_type,
        "workload_profiles": profiles,
        "has_consumption_profile": has_consumption_profile,
        "has_express_indicator": has_express_indicator
    }


def classify_aca_environment(
    cli_env,
    authoritative_arm_env=None,
    expected_location=None,
    require_succeeded=False,
    require_authoritative=False
):
    """
    Classifies an Azure Container Apps environment using CLI metadata and authoritative
    ARM metadata from api-version=2026-07-01.

    Invariants:
    1. Express metadata (environmentMode == 'Express'/'express', planType == 'Express',
       or 'express' in kind) in EITHER CLI or authoritative ARM metadata is unconditionally
       REJECTED, regardless of workloadProfiles contents (Fixtures A & D).
    2. Standard is NEVER inferred solely from workloadProfiles containing Consumption,
       workloadProfileType == 'Consumption', or an app's workloadProfileName == 'Consumption'.
    3. Missing/null/empty environmentMode is REJECTED unless authoritative_arm_env is provided
       and explicitly resolves environmentMode to 'WorkloadProfiles' (Fixture C).
    4. ACCEPT requires authoritative confirmation of:
       - environmentMode == 'WorkloadProfiles' (case-insensitive)
       - explicit Consumption workload profile (name='Consumption', workloadProfileType='Consumption')
       - zero Express indicators in any metadata source
       - matching location and provisioningState == 'Succeeded' (when requested)
    """
    cli_meta = _extract_env_metadata(cli_env)
    auth_meta = _extract_env_metadata(authoritative_arm_env) if authoritative_arm_env is not None else None

    name = (auth_meta["name"] if auth_meta and auth_meta["name"] else cli_meta["name"])
    env_id = (auth_meta["id"] if auth_meta and auth_meta["id"] else cli_meta["id"])
    raw_loc = (auth_meta["location"] if auth_meta and auth_meta["location"] else cli_meta["location"])
    norm_loc = (auth_meta["norm_location"] if auth_meta and auth_meta["norm_location"] else cli_meta["norm_location"])
    state = (
        auth_meta["provisioning_state"]
        if auth_meta and auth_meta["provisioning_state"]
        else cli_meta["provisioning_state"]
    )
    has_consumption = (
        auth_meta["has_consumption_profile"]
        if auth_meta is not None
        else cli_meta["has_consumption_profile"]
    )

    # Rule 1 (Fixtures A & D): Express indicator in ANY metadata source is unconditionally rejected
    if cli_meta["has_express_indicator"] or (auth_meta and auth_meta["has_express_indicator"]):
        resolved_mode = (
            auth_meta["environment_mode"]
            if (auth_meta and auth_meta["environment_mode"])
            else (cli_meta["environment_mode"] or "Express")
        )
        return {
            "decision": "REJECT",
            "compatible": False,
            "reason": "EXPRESS_ENVIRONMENT",
            "name": name,
            "id": env_id,
            "location": raw_loc,
            "norm_location": norm_loc,
            "provisioning_state": state,
            "environment_mode": resolved_mode,
            "has_consumption_profile": has_consumption
        }

    # Rule 2: If authoritative ARM metadata is strictly required (production runtime), reject if absent
    if require_authoritative and (auth_meta is None or not auth_meta["present"]):
        return {
            "decision": "REJECT",
            "compatible": False,
            "reason": "MISSING_AUTHORITATIVE_ARM_METADATA",
            "name": name,
            "id": env_id,
            "location": raw_loc,
            "norm_location": norm_loc,
            "provisioning_state": state,
            "environment_mode": "",
            "has_consumption_profile": has_consumption
        }

    # Rule 3 (Fixture C): Resolve environmentMode from authoritative metadata if provided; never guess
    if auth_meta is not None:
        resolved_mode = auth_meta["environment_mode"]
        resolved_plan = auth_meta["plan_type"]
    else:
        resolved_mode = cli_meta["environment_mode"]
        resolved_plan = cli_meta["plan_type"]

    if not resolved_mode:
        return {
            "decision": "REJECT",
            "compatible": False,
            "reason": "MISSING_OR_AMBIGUOUS_ENVIRONMENT_MODE",
            "name": name,
            "id": env_id,
            "location": raw_loc,
            "norm_location": norm_loc,
            "provisioning_state": state,
            "environment_mode": "",
            "has_consumption_profile": has_consumption
        }

    if (
        resolved_mode.lower() != "workloadprofiles"
        or resolved_plan.lower() == "consumptiononly"
        or cli_meta["plan_type"].lower() == "consumptiononly"
        or (cli_meta["environment_mode"] and cli_meta["environment_mode"].lower() != "workloadprofiles")
    ):
        return {
            "decision": "REJECT",
            "compatible": False,
            "reason": f"UNSUPPORTED_ENVIRONMENT_MODE:{resolved_mode}",
            "name": name,
            "id": env_id,
            "location": raw_loc,
            "norm_location": norm_loc,
            "provisioning_state": state,
            "environment_mode": resolved_mode,
            "has_consumption_profile": has_consumption
        }

    # Rule 4: Must also contain an explicit Consumption workload profile
    if not has_consumption:
        return {
            "decision": "REJECT",
            "compatible": False,
            "reason": "MISSING_CONSUMPTION_WORKLOAD_PROFILE",
            "name": name,
            "id": env_id,
            "location": raw_loc,
            "norm_location": norm_loc,
            "provisioning_state": state,
            "environment_mode": resolved_mode,
            "has_consumption_profile": False
        }

    if expected_location is not None:
        exp_norm = expected_location.strip().lower().replace(" ", "")
        if norm_loc != exp_norm:
            return {
                "decision": "REJECT",
                "compatible": False,
                "reason": f"LOCATION_MISMATCH:{raw_loc}",
                "name": name,
                "id": env_id,
                "location": raw_loc,
                "norm_location": norm_loc,
                "provisioning_state": state,
                "environment_mode": resolved_mode,
                "has_consumption_profile": True
            }

    if require_succeeded and state != "Succeeded":
        return {
            "decision": "REJECT",
            "compatible": False,
            "reason": f"PROVISIONING_STATE_NOT_SUCCEEDED:{state}",
            "name": name,
            "id": env_id,
            "location": raw_loc,
            "norm_location": norm_loc,
            "provisioning_state": state,
            "environment_mode": resolved_mode,
            "has_consumption_profile": True
        }

    return {
        "decision": "ACCEPT",
        "compatible": True,
        "reason": "STANDARD_WORKLOAD_PROFILES",
        "name": name,
        "id": env_id,
        "location": raw_loc,
        "norm_location": norm_loc,
        "provisioning_state": state,
        "environment_mode": resolved_mode,
        "has_consumption_profile": True
    }


def validate_env_creation_args(args_list, supports_environment_mode_flag, target_env_name, legacy_env_name, expected_location):
    """
    Validates the az containerapp env create argument vector before execution.
    Ensures Standard Workload Profiles creation flags are explicitly configured and
    cannot create an Express or ConsumptionOnly environment.
    """
    if not isinstance(args_list, list) or not args_list:
        return {"valid": False, "reason": "EMPTY_ARGS"}

    def get_flag_val(flag):
        for i, token in enumerate(args_list):
            if token == flag and i + 1 < len(args_list):
                return args_list[i + 1]
        return None

    name_val = get_flag_val("--name")
    if not name_val or name_val != target_env_name or name_val == legacy_env_name:
        return {"valid": False, "reason": f"INVALID_TARGET_ENV_NAME:{name_val}"}

    loc_val = get_flag_val("--location") or ""
    if loc_val.strip().lower().replace(" ", "") != expected_location.strip().lower().replace(" ", ""):
        return {"valid": False, "reason": f"INVALID_LOCATION:{loc_val}"}

    if "--enable-workload-profiles" not in args_list:
        return {"valid": False, "reason": "MISSING_ENABLE_WORKLOAD_PROFILES_FLAG"}

    wp_idx = args_list.index("--enable-workload-profiles")
    if wp_idx + 1 < len(args_list):
        next_tok = str(args_list[wp_idx + 1]).strip().lower()
        if next_tok in ("false", "0", "no"):
            return {"valid": False, "reason": "WORKLOAD_PROFILES_EXPLICITLY_DISABLED"}

    if supports_environment_mode_flag:
        mode_val = get_flag_val("--environment-mode")
        if mode_val != "WorkloadProfiles":
            return {"valid": False, "reason": f"MISSING_OR_INVALID_ENVIRONMENT_MODE_FLAG:{mode_val}"}
    else:
        mode_val = get_flag_val("--environment-mode")
        if mode_val is not None and mode_val != "WorkloadProfiles":
            return {"valid": False, "reason": f"INVALID_ENVIRONMENT_MODE_FLAG:{mode_val}"}

    return {"valid": True, "reason": "OK"}
# END_ACA_ENV_CLASSIFIER
PYEOF
}

write_env_classifier_module

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
echo " Authoritative API:    Microsoft.App/managedEnvironments@${ARM_ENV_API_VERSION}"
echo " Feature Gates:        YouTube=ON, Twitter/X=ON, Pinterest=ON, Generic=ON"
echo "                       Instagram=OFF, TikTok=OFF, Facebook=OFF, AudioOnly=OFF"
echo "=================================================================="

# ------------------------------------------------------------------------------
# PHASE 1: AZURE CLI & CONTAINERAPPS EXTENSION (1.3.0b5+) COMPATIBILITY GATE
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

ACA_EXT_VERSION=$(az extension show --name containerapp --query "version" -o tsv 2>/dev/null | tr -d '\r' || echo "builtin/unknown")
echo "Detected containerapp CLI extension version: ${ACA_EXT_VERSION}"

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

# In preview extension 1.3.0b4/1.3.0b5+, --environment-mode is supported and sets properties.environmentMode
SUPPORTS_ENV_MODE_FLAG="false"
if echo "$ENV_CREATE_HELP" | grep -q -- "--environment-mode"; then
    SUPPORTS_ENV_MODE_FLAG="true"
    echo "Detected preview flag '--environment-mode' in 'az containerapp env create' (extension ${ACA_EXT_VERSION}); will enforce '--environment-mode WorkloadProfiles'."
fi

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
# PHASE 2: AUTHORITATIVE ARM ENVIRONMENT DISCOVERY & CREATION
# ------------------------------------------------------------------------------
echo ""
echo "--> [Phase 2] Checking Azure provider registration and auditing environments via ARM ${ARM_ENV_API_VERSION}..."

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

echo "Listing Container Apps Environments in resource group '${RESOURCE_GROUP}'..."
az containerapp env list --resource-group "${RESOURCE_GROUP}" -o json > "${TMP_DIR}/envs.json"

# Extract environment resource IDs so we can query authoritative ARM metadata (api-version=2026-07-01) for each
ENV_RESOURCE_IDS=$(python3 - "${TMP_DIR}/envs.json" << 'PYEOF'
import json, sys

with open(sys.argv[1], "r", encoding="utf-8") as f:
    envs = json.load(f)

if not isinstance(envs, list):
    print("ERROR: Unexpected response format from az containerapp env list.", file=sys.stderr)
    sys.exit(1)

for e in envs:
    eid = (e.get("id") or "").strip()
    if not eid:
        print(f"ERROR: Environment '{e.get('name')}' is missing resource id.", file=sys.stderr)
        sys.exit(1)
    print(eid)
PYEOF
)

echo "{}" > "${TMP_DIR}/auth_envs_map.json"
while IFS= read -r ENVIRONMENT_RESOURCE_ID; do
    ENVIRONMENT_RESOURCE_ID=$(echo "${ENVIRONMENT_RESOURCE_ID}" | tr -d '\r')
    if [ -z "${ENVIRONMENT_RESOURCE_ID}" ]; then
        continue
    fi
    echo "Fetching authoritative ARM metadata (${ARM_ENV_API_VERSION}) for ${ENVIRONMENT_RESOURCE_ID}..."
    fetch_authoritative_env_arm_json "${ENVIRONMENT_RESOURCE_ID}" "${TMP_DIR}/single_env_arm.json"
    python3 - "${TMP_DIR}/auth_envs_map.json" "${ENVIRONMENT_RESOURCE_ID}" "${TMP_DIR}/single_env_arm.json" << 'PYEOF'
import json, sys

map_path, env_id, single_path = sys.argv[1], sys.argv[2], sys.argv[3]
with open(map_path, "r", encoding="utf-8") as f:
    m = json.load(f)
with open(single_path, "r", encoding="utf-8") as f:
    arm_obj = json.load(f)

m[env_id.lower()] = arm_obj
with open(map_path, "w", encoding="utf-8") as f:
    json.dump(m, f)
PYEOF
done <<< "${ENV_RESOURCE_IDS}"

ENV_EVAL=$(python3 - "${TMP_DIR}/aca_env_classifier.py" "${TMP_DIR}/envs.json" "${TMP_DIR}/auth_envs_map.json" "${LOCATION}" "${STANDARD_ENV_NAME}" "${LEGACY_EXPRESS_ENV_NAME}" << 'PYEOF'
import importlib.util, json, sys

mod_path, envs_path, auth_map_path, expected_loc, target_env_name, legacy_env_name = sys.argv[1:7]
spec = importlib.util.spec_from_file_location("aca_env_classifier", mod_path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

with open(envs_path, "r", encoding="utf-8") as f:
    envs = json.load(f)
with open(auth_map_path, "r", encoding="utf-8") as f:
    auth_map = json.load(f)

classified = []
for e in envs:
    eid = (e.get("id") or "").strip().lower()
    auth_obj = auth_map.get(eid)
    res = mod.classify_aca_environment(
        e,
        authoritative_arm_env=auth_obj,
        expected_location=expected_loc,
        require_succeeded=True,
        require_authoritative=True
    )
    classified.append(res)
    preserved_note = " [preserved legacy Express resource]" if res["name"] == legacy_env_name else ""
    print(
        f"  [Env Audit] Name: {res['name']} | Location: {res['location']} | State: {res['provisioning_state']} | "
        f"AuthoritativeMode: {res['environment_mode'] or 'MISSING'} | ConsumptionProfile: {res['has_consumption_profile']} "
        f"-> {res['decision']} ({res['reason']}){preserved_note}",
        file=sys.stderr
    )

# Check if another ACCEPTED standard environment exists with a name other than target_env_name
other_standard_envs = [
    c for c in classified
    if c["decision"] == "ACCEPT" and c["name"] != target_env_name
]
target_matches = [c for c in classified if c["name"] == target_env_name]

if len(other_standard_envs) > 0 and len(target_matches) == 0:
    print(
        f"ERROR: Found existing compatible standard environment(s) {[c['name'] for c in other_standard_envs]} "
        f"not matching target '{target_env_name}'. Refusing to arbitrarily reuse one.",
        file=sys.stderr
    )
    sys.exit(1)

if len(target_matches) == 0:
    print("CREATE_NEEDED")
    sys.exit(0)

t = target_matches[0]
if t["decision"] != "ACCEPT":
    print(
        f"ERROR: Existing target environment '{target_env_name}' was REJECTED by authoritative ARM metadata validation: "
        f"reason='{t['reason']}', environmentMode='{t['environment_mode']}', "
        f"hasConsumptionProfile={t['has_consumption_profile']}, state='{t['provisioning_state']}', location='{t['location']}'.",
        file=sys.stderr
    )
    sys.exit(1)

print(f"VERIFIED|{t['name']}|{t['id']}|{t['location']}")
PYEOF
)

if [ "$ENV_EVAL" = "CREATE_NEEDED" ]; then
    echo "Preparing creation configuration for Standard Workload Profiles environment '${STANDARD_ENV_NAME}'..."

    CREATE_ENV_ARGS=(
        --name "${STANDARD_ENV_NAME}"
        --resource-group "${RESOURCE_GROUP}"
        --location "${LOCATION}"
        --enable-workload-profiles
    )
    if [ "${SUPPORTS_ENV_MODE_FLAG}" = "true" ]; then
        CREATE_ENV_ARGS+=(--environment-mode WorkloadProfiles)
    fi

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

    # Validate the creation configuration BEFORE executing az containerapp env create
    python3 - "${TMP_DIR}/aca_env_classifier.py" "${SUPPORTS_ENV_MODE_FLAG}" "${STANDARD_ENV_NAME}" "${LEGACY_EXPRESS_ENV_NAME}" "${LOCATION}" "${CREATE_ENV_ARGS[@]}" << 'PYEOF'
import importlib.util, sys

mod_path = sys.argv[1]
supports_env_mode = sys.argv[2].lower() == "true"
target_env = sys.argv[3]
legacy_env = sys.argv[4]
expected_loc = sys.argv[5]
create_args = sys.argv[6:]

spec = importlib.util.spec_from_file_location("aca_env_classifier", mod_path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

res = mod.validate_env_creation_args(
    create_args,
    supports_environment_mode_flag=supports_env_mode,
    target_env_name=target_env,
    legacy_env_name=legacy_env,
    expected_location=expected_loc
)
if not res.get("valid"):
    print(f"ERROR: Environment creation configuration validation failed: {res.get('reason')}", file=sys.stderr)
    sys.exit(1)

print(f"Validated environment creation configuration for '{target_env}' (supports_environment_mode={supports_env_mode}).")
PYEOF

    echo "Creating Standard Workload Profiles environment '${STANDARD_ENV_NAME}' in '${LOCATION}'..."
    az containerapp env create "${CREATE_ENV_ARGS[@]}"

    # Retrieve CLI environment object and authoritative ARM metadata (api-version=2026-07-01)
    az containerapp env show \
        --name "${STANDARD_ENV_NAME}" \
        --resource-group "${RESOURCE_GROUP}" \
        -o json > "${TMP_DIR}/created_env_cli.json"

    CREATED_ENV_ID=$(python3 -c 'import json, sys; print((json.load(open(sys.argv[1], encoding="utf-8")).get("id") or "").strip())' "${TMP_DIR}/created_env_cli.json" | tr -d '\r')
    if [ -z "${CREATED_ENV_ID}" ]; then
        echo "ERROR: Failed to retrieve resource ID for newly created environment '${STANDARD_ENV_NAME}'." >&2
        exit 1
    fi

    echo "Verifying newly created environment '${STANDARD_ENV_NAME}' via authoritative ARM API (${ARM_ENV_API_VERSION})..."
    ENVIRONMENT_RESOURCE_ID="${CREATED_ENV_ID}"
    fetch_authoritative_env_arm_json "${ENVIRONMENT_RESOURCE_ID}" "${TMP_DIR}/created_env_arm.json"

    ENV_ID=$(python3 - "${TMP_DIR}/aca_env_classifier.py" "${TMP_DIR}/created_env_cli.json" "${TMP_DIR}/created_env_arm.json" "${LOCATION}" << 'PYEOF'
import importlib.util, json, sys

mod_path, cli_path, arm_path, expected_loc = sys.argv[1:5]
spec = importlib.util.spec_from_file_location("aca_env_classifier", mod_path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

with open(cli_path, "r", encoding="utf-8") as f:
    cli_obj = json.load(f)
with open(arm_path, "r", encoding="utf-8") as f:
    arm_obj = json.load(f)

res = mod.classify_aca_environment(
    cli_obj,
    authoritative_arm_env=arm_obj,
    expected_location=expected_loc,
    require_succeeded=True,
    require_authoritative=True
)
if res["decision"] != "ACCEPT":
    print(
        f"ERROR: Newly created environment '{res['name']}' was REJECTED by authoritative ARM verification "
        f"(decision={res['decision']}, reason={res['reason']}, environmentMode='{res['environment_mode']}', "
        f"hasConsumptionProfile={res['has_consumption_profile']}, state='{res['provisioning_state']}').",
        file=sys.stderr
    )
    sys.exit(1)

print(res["id"])
PYEOF
    )
    ENV_ID=$(echo "$ENV_ID" | tr -d '\r')
    echo "Verified new Standard Workload Profiles environment via ARM ${ARM_ENV_API_VERSION}: '${STANDARD_ENV_NAME}' (${ENV_ID}, environmentMode=WorkloadProfiles, workloadProfile=Consumption)."
else
    IFS='|' read -r _ _ ENV_ID ENV_RAW_LOC <<< "$ENV_EVAL"
    echo "Verified existing Standard Workload Profiles environment via ARM ${ARM_ENV_API_VERSION}: '${STANDARD_ENV_NAME}' (Location: ${ENV_RAW_LOC}, environmentMode=WorkloadProfiles, workloadProfile=Consumption)."
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
    echo "Existing Container App '${APP_NAME}' detected. Auditing bound environment via authoritative ARM metadata..."
    EXISTING_APP_ENV_ID=$(python3 -c 'import json, sys; p = json.load(open(sys.argv[1], encoding="utf-8")).get("properties") or {}; print((p.get("environmentId") or p.get("managedEnvironmentId") or "").strip())' "${TMP_DIR}/existing_app.json" | tr -d '\r')
    if [ -z "${EXISTING_APP_ENV_ID}" ]; then
        echo "ERROR: Existing Container App '${APP_NAME}' does not have an environmentId." >&2
        exit 1
    fi

    fetch_authoritative_env_arm_json "${EXISTING_APP_ENV_ID}" "${TMP_DIR}/existing_app_env_arm.json"

    python3 - "${TMP_DIR}/aca_env_classifier.py" "${TMP_DIR}/existing_app.json" "${TMP_DIR}/existing_app_env_arm.json" "${ENV_ID}" "${WORKLOAD_PROFILE_NAME}" "${LOCATION}" << 'PYEOF'
import importlib.util, json, sys

mod_path, app_path, app_env_arm_path, expected_env_id, expected_wp, expected_loc = sys.argv[1:7]
spec = importlib.util.spec_from_file_location("aca_env_classifier", mod_path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

with open(app_path, "r", encoding="utf-8") as f:
    app = json.load(f)
with open(app_env_arm_path, "r", encoding="utf-8") as f:
    app_env_arm = json.load(f)

props = app.get("properties") or {}
actual_env_id = (props.get("environmentId") or props.get("managedEnvironmentId") or "").strip()
if actual_env_id.lower() != expected_env_id.lower():
    print(
        f"ERROR: Existing Container App '{app.get('name')}' is bound to environment '{actual_env_id}', "
        f"which does NOT match standard environment '{expected_env_id}'. "
        f"Refusing to modify an app on an incompatible environment.",
        file=sys.stderr
    )
    sys.exit(1)

# Never infer Standard environment from app.workloadProfileName == Consumption; verify authoritative ARM metadata
env_eval = mod.classify_aca_environment(
    app_env_arm,
    authoritative_arm_env=app_env_arm,
    expected_location=expected_loc,
    require_succeeded=True,
    require_authoritative=True
)
if env_eval["decision"] != "ACCEPT":
    print(
        f"ERROR: Existing Container App '{app.get('name')}' is bound to an environment rejected by authoritative ARM metadata: "
        f"reason='{env_eval['reason']}', environmentMode='{env_eval['environment_mode']}'.",
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
print("  [Audit] Authoritative Mode:  ", env_eval["environment_mode"])
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
echo " Standard Environment:   ${STANDARD_ENV_NAME} (environmentMode=WorkloadProfiles)"
echo " Container App:          ${APP_NAME}"
echo " Active Revision:        ${ACTIVE_REVISION}"
echo " Deployed Image:         ${DEPLOYED_IMAGE}"
echo " Image Digest:           ${EXPECTED_IMAGE_DIGEST}"
echo " Public Mobile Test URL: ${PUBLIC_URL}"
echo " Health Endpoint:        ${PUBLIC_URL}/health"
echo " Readiness Endpoint:     ${PUBLIC_URL}/ready"
echo " Capabilities Endpoint:  ${PUBLIC_URL}/api/capabilities"
echo "=================================================================="
