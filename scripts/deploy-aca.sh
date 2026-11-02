#!/usr/bin/env bash
# ==============================================================================
# Reeva — Azure Container Apps Production Deployment Script
# Subscription: Azure for Students | RG: reeva-rg | Region: Central India
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
    echo " Fetching diagnostic state for '${APP_NAME:-reeva-mobile-test}' in '${RESOURCE_GROUP:-reeva-rg}'..." >&2
    echo "==================================================================" >&2
    if command -v az >/dev/null 2>&1; then
        az containerapp revision list \
            --name "${APP_NAME:-reeva-mobile-test}" \
            --resource-group "${RESOURCE_GROUP:-reeva-rg}" \
            --query "[].{Name:name,Active:properties.active,Health:properties.healthState,Provisioning:properties.provisioningState,Details:properties.runningStateDetails}" \
            -o table 2>/dev/null || true
        az containerapp logs show \
            --name "${APP_NAME:-reeva-mobile-test}" \
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
APP_NAME="reeva-mobile-test"
ACR_NAME="reevaacr20261031"
ACR_LOGIN_SERVER="reevaacr20261031-hpg2gjgtbxb6c5hv.azurecr.io"
IMAGE_TAG="mobile-test"
FULL_IMAGE="${ACR_LOGIN_SERVER}/reeva:${IMAGE_TAG}"
TARGET_PORT=3000

echo "=================================================================="
echo " Starting Reeva Azure Container Apps Deployment"
echo " Resource Group: ${RESOURCE_GROUP}"
echo " Region:         ${LOCATION} (Central India)"
echo " Container App:  ${APP_NAME}"
echo " Target Image:   ${FULL_IMAGE}"
echo " Target Port:    ${TARGET_PORT}"
echo " Feature Gates:  YouTube=ON, Twitter/X=ON, Pinterest=ON, Generic=ON"
echo "                 Instagram=OFF, TikTok=OFF, Facebook=OFF, AudioOnly=OFF"
echo "=================================================================="

# Ensure Azure CLI installs missing extensions non-interactively
az config set extension.use_dynamic_install=yes_without_prompt >/dev/null 2>&1 || true

# ------------------------------------------------------------------------------
# PHASE 2: AZURE RESOURCE & ENVIRONMENT VALIDATION
# ------------------------------------------------------------------------------
echo ""
echo "--> [Phase 2] Checking Azure provider registration and environment..."

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

echo "Inspecting Container Apps Environments in resource group '${RESOURCE_GROUP}'..."
az containerapp env list --resource-group "${RESOURCE_GROUP}" -o json > "${TMP_DIR}/envs.json"

ENV_EVAL=$(python3 - "${TMP_DIR}/envs.json" "${LOCATION}" << 'PYEOF'
import json, sys

envs_path, expected_loc = sys.argv[1], sys.argv[2].lower().replace(" ", "")
with open(envs_path, "r", encoding="utf-8") as f:
    envs = json.load(f)

if not isinstance(envs, list):
    print("ERROR: Unexpected response format from az containerapp env list.", file=sys.stderr)
    sys.exit(1)

if len(envs) > 1:
    print(f"ERROR: Multiple ({len(envs)}) Container Apps Environments found in resource group. Refusing to arbitrarily select one:", file=sys.stderr)
    for e in envs:
        name = e.get("name")
        loc = e.get("location")
        state = (e.get("properties") or {}).get("provisioningState")
        print(f"  - Name: {name} | Location: {loc} | State: {state}", file=sys.stderr)
    sys.exit(1)

if len(envs) == 0:
    print("NONE")
    sys.exit(0)

env = envs[0]
name = env.get("name", "")
env_id = env.get("id", "")
raw_loc = env.get("location", "")
norm_loc = raw_loc.lower().replace(" ", "")
props = env.get("properties") or {}
state = props.get("provisioningState", "")
profiles = props.get("workloadProfiles")

if norm_loc != expected_loc:
    print(f"ERROR: Existing environment '{name}' is in location '{raw_loc}' (normalized: '{norm_loc}'), expected '{expected_loc}' (Central India).", file=sys.stderr)
    sys.exit(1)

if state != "Succeeded":
    print(f"ERROR: Existing environment '{name}' has provisioningState='{state}' (expected 'Succeeded').", file=sys.stderr)
    sys.exit(1)

# Validate Consumption compatibility:
# Either workloadProfiles is None/empty (Consumption-only environment) or contains a Consumption profile
has_consumption = False
if not profiles:
    has_consumption = True
elif isinstance(profiles, list):
    for p in profiles:
        if (p.get("workloadProfileType") or "").lower() == "consumption" or (p.get("name") or "").lower() == "consumption":
            has_consumption = True
            break

if not has_consumption:
    print(f"ERROR: Existing environment '{name}' does not support a Consumption workload profile. Found profiles: {json.dumps(profiles)}", file=sys.stderr)
    sys.exit(1)

print(f"FOUND|{name}|{env_id}|{raw_loc}")
PYEOF
)

if [ "$ENV_EVAL" = "NONE" ]; then
    ENV_NAME="reeva-env"
    echo "No existing environment found in '${RESOURCE_GROUP}'. Creating Consumption environment '${ENV_NAME}' in '${LOCATION}'..."
    az containerapp env create \
        --name "${ENV_NAME}" \
        --resource-group "${RESOURCE_GROUP}" \
        --location "${LOCATION}"
    ENV_ID=$(az containerapp env show --name "${ENV_NAME}" --resource-group "${RESOURCE_GROUP}" --query "id" -o tsv | tr -d '\r')
else
    IFS='|' read -r _ ENV_NAME ENV_ID ENV_RAW_LOC <<< "$ENV_EVAL"
    echo "Verified existing compatible Container Apps Environment: '${ENV_NAME}' (Location: ${ENV_RAW_LOC}, Consumption-ready)."
fi

# ------------------------------------------------------------------------------
# PHASE 3: PRIVATE REGISTRY AUTHENTICATION & EXISTING APP SAFETY AUDIT
# ------------------------------------------------------------------------------
echo ""
echo "--> [Phase 3] Validating ACR metadata and existing Container App state..."

ACR_ID=$(az acr show --name "${ACR_NAME}" --resource-group "${RESOURCE_GROUP}" --query id -o tsv | tr -d '\r')
DISCOVERED_SERVER=$(az acr show --name "${ACR_NAME}" --resource-group "${RESOURCE_GROUP}" --query loginServer -o tsv | tr -d '\r')

if [ "${DISCOVERED_SERVER}" != "${ACR_LOGIN_SERVER}" ]; then
    echo "ERROR: Discovered ACR login server (${DISCOVERED_SERVER}) does not match expected (${ACR_LOGIN_SERVER})!" >&2
    exit 1
fi
echo "Verified ACR: ${ACR_NAME} (${ACR_LOGIN_SERVER})"

if az containerapp show --name "${APP_NAME}" --resource-group "${RESOURCE_GROUP}" -o json > "${TMP_DIR}/existing_app.json" 2>/dev/null; then
    echo "Existing Container App '${APP_NAME}' detected. Auditing current configuration before modification..."
    python3 - "${TMP_DIR}/existing_app.json" "${ENV_ID}" << 'PYEOF'
import json, sys

app_path, expected_env_id = sys.argv[1], sys.argv[2]
with open(app_path, "r", encoding="utf-8") as f:
    app = json.load(f)

props = app.get("properties") or {}
actual_env_id = props.get("environmentId") or props.get("managedEnvironmentId") or ""
if actual_env_id and expected_env_id and actual_env_id.lower() != expected_env_id.lower():
    print(f"ERROR: Existing app belongs to environment '{actual_env_id}', expected '{expected_env_id}'.", file=sys.stderr)
    sys.exit(1)

identity = app.get("identity") or {}
config = props.get("configuration") or {}
ingress = config.get("ingress") or {}
template = props.get("template") or {}
scale = template.get("scale") or {}
containers = template.get("containers") or []
env_names = []
if containers:
    env_names = [e.get("name") for e in (containers[0].get("env") or []) if e.get("name")]

print("  [Audit] Identity Type:       ", identity.get("type", "None"))
print("  [Audit] Principal ID:        ", identity.get("principalId", "None"))
print("  [Audit] Active Revisions:    ", config.get("activeRevisionsMode", "Single"))
print("  [Audit] Latest Revision:     ", props.get("latestRevisionName", "None"))
print("  [Audit] Ingress External:    ", ingress.get("external"))
print("  [Audit] Ingress TargetPort:  ", ingress.get("targetPort"))
print("  [Audit] Ingress AllowInsec:  ", ingress.get("allowInsecure"))
print("  [Audit] Ingress FQDN:        ", ingress.get("fqdn", "None"))
print("  [Audit] Scale Min/Max:       ", f"{scale.get('minReplicas')} / {scale.get('maxReplicas')}")
print("  [Audit] Existing Env Keys:   ", ", ".join(env_names) if env_names else "(none)")
PYEOF
else
    echo "Container App '${APP_NAME}' does not exist yet. Creating with bootstrap container to establish System Managed Identity..."
    az containerapp create \
        --name "${APP_NAME}" \
        --resource-group "${RESOURCE_GROUP}" \
        --environment "${ENV_NAME}" \
        --system-assigned \
        --image "mcr.microsoft.com/k8se/quickstart:latest" \
        --target-port "${TARGET_PORT}" \
        --ingress external \
        --min-replicas 0 \
        --max-replicas 1 \
        --cpu 0.5 \
        --memory 1.0Gi
fi

echo "Retrieving System-Assigned Managed Identity Principal ID..."
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

echo "Verifying / granting least-privilege 'AcrPull' role assignment on ${ACR_NAME}..."
EXISTING_ROLE=$(az role assignment list \
    --assignee "${PRINCIPAL_ID}" \
    --scope "${ACR_ID}" \
    --query "[?roleDefinitionName=='AcrPull'].id" -o tsv 2>/dev/null | tr -d '\r' || true)

if [ -z "$EXISTING_ROLE" ]; then
    echo "Creating AcrPull role assignment for Managed Identity (ServicePrincipal)..."
    az role assignment create \
        --assignee-object-id "${PRINCIPAL_ID}" \
        --assignee-principal-type ServicePrincipal \
        --role "AcrPull" \
        --scope "${ACR_ID}"

    echo "Polling Azure RBAC for AcrPull role propagation..."
    MAX_ATTEMPTS=12
    ATTEMPT=1
    ROLE_CONFIRMED=""
    while [ $ATTEMPT -le $MAX_ATTEMPTS ]; do
        ROLE_CONFIRMED=$(az role assignment list \
            --assignee "${PRINCIPAL_ID}" \
            --scope "${ACR_ID}" \
            --query "[?roleDefinitionName=='AcrPull'].id" -o tsv 2>/dev/null | tr -d '\r' || true)
        if [ -n "$ROLE_CONFIRMED" ]; then
            echo "AcrPull role verified in ARM on attempt ${ATTEMPT}."
            break
        fi
        echo "Waiting for role assignment visibility (attempt ${ATTEMPT}/${MAX_ATTEMPTS})..."
        sleep 5
        ATTEMPT=$((ATTEMPT + 1))
    done

    if [ -z "$ROLE_CONFIRMED" ]; then
        echo "ERROR: AcrPull role assignment did not propagate within 60 seconds." >&2
        exit 1
    fi

    echo "Allowing 20s buffer for ACR data-plane token cache propagation..."
    sleep 20
else
    echo "AcrPull role assignment already confirmed present (${EXISTING_ROLE})."
fi

echo "Configuring Container App registry settings with system managed identity..."
REG_SET_OK=false
for attempt in 1 2 3; do
    if az containerapp registry set \
        --name "${APP_NAME}" \
        --resource-group "${RESOURCE_GROUP}" \
        --server "${ACR_LOGIN_SERVER}" \
        --identity system; then
        REG_SET_OK=true
        break
    fi
    echo "Registry binding encountered transient propagation delay (attempt ${attempt}/3). Retrying in 15s..."
    sleep 15
done

if [ "$REG_SET_OK" != true ]; then
    echo "ERROR: Failed to bind ACR registry '${ACR_LOGIN_SERVER}' using system identity." >&2
    exit 1
fi

# ------------------------------------------------------------------------------
# PHASE 4: DECLARATIVE DEPLOYMENT WITH PROBES & SAFE CONFIG MERGE
# ------------------------------------------------------------------------------
echo ""
echo "--> [Phase 4] Preparing declarative YAML update with /health & /ready probes and selective gates..."

az containerapp show \
    --name "${APP_NAME}" \
    --resource-group "${RESOURCE_GROUP}" \
    -o json > "${TMP_DIR}/current_app_pre_update.json"

python3 - "${TMP_DIR}/current_app_pre_update.json" "${TMP_DIR}/reeva_update.yaml" "${FULL_IMAGE}" "${TARGET_PORT}" << 'PYEOF'
import json, sys

src_json, dst_yaml, full_image, target_port_str = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
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

container["name"] = container.get("name") or app.get("name") or "reeva-mobile-test"
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
        "configuration": {
            "ingress": ingress
        },
        "template": {
            "containers": [container],
            "scale": scale
        }
    }
}
if template.get("volumes"):
    update_payload["properties"]["template"]["volumes"] = template["volumes"]

try:
    import yaml
    with open(dst_yaml, "w", encoding="utf-8") as out:
        yaml.safe_dump(update_payload, out, default_flow_style=False, sort_keys=False)
except ImportError:
    # JSON is valid YAML 1.2
    with open(dst_yaml, "w", encoding="utf-8") as out:
        json.dump(update_payload, out, indent=2)
PYEOF

echo "Applying declarative update to '${APP_NAME}'..."
DEPLOY_OK=false
for attempt in 1 2 3; do
    if az containerapp update \
        --name "${APP_NAME}" \
        --resource-group "${RESOURCE_GROUP}" \
        --yaml "${TMP_DIR}/reeva_update.yaml"; then
        DEPLOY_OK=true
        break
    fi
    echo "Container update encountered transient propagation delay (attempt ${attempt}/3). Retrying in 15s..."
    sleep 15
done

if [ "$DEPLOY_OK" != true ]; then
    echo "ERROR: Failed to update Container App '${APP_NAME}' with image '${FULL_IMAGE}'." >&2
    exit 1
fi

# ------------------------------------------------------------------------------
# PHASE 5: LIVE VERIFICATION, PROBE AUDIT & CAPABILITY CHECKS
# ------------------------------------------------------------------------------
echo ""
echo "--> [Phase 5] Running live verification..."

az containerapp show \
    --name "${APP_NAME}" \
    --resource-group "${RESOURCE_GROUP}" \
    -o json > "${TMP_DIR}/post_update_app.json"

FQDN=$(python3 - "${TMP_DIR}/post_update_app.json" "${TARGET_PORT}" << 'PYEOF'
import json, sys

app_path, target_port = sys.argv[1], int(sys.argv[2])
with open(app_path, "r", encoding="utf-8") as f:
    app = json.load(f)

props = app.get("properties") or {}
state = props.get("provisioningState")
if state != "Succeeded":
    print(f"ERROR: Container App provisioningState is '{state}' (expected 'Succeeded').", file=sys.stderr)
    sys.exit(1)

ingress = (props.get("configuration") or {}).get("ingress") or {}
if not ingress.get("external") or ingress.get("targetPort") != target_port or ingress.get("allowInsecure"):
    print(f"ERROR: Ingress verification failed: {json.dumps(ingress)}", file=sys.stderr)
    sys.exit(1)

containers = (props.get("template") or {}).get("containers") or []
probes = {p.get("type"): p for p in (containers[0].get("probes") or [])} if containers else {}

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

print(fqdn)
PYEOF
)
FQDN=$(echo "$FQDN" | tr -d '\r')

PUBLIC_URL="https://${FQDN}"
echo "Verified Container App Provisioning State: Succeeded"
echo "Verified Platform Probes: Liveness (GET /health:3000), Readiness (GET /ready:3000), Startup (GET /ready:3000)"
echo "Public Application HTTPS URL: ${PUBLIC_URL}"

echo "Polling application readiness probe (${PUBLIC_URL}/ready)..."
READY=false
for i in {1..15}; do
    STATUS_CODE=$(curl -s -o "${TMP_DIR}/reeva_ready.json" -w "%{http_code}" "${PUBLIC_URL}/ready" || echo "000")
    if [ "$STATUS_CODE" = "200" ]; then
        echo "Application reported HTTP 200 (READY) on attempt $i."
        READY=true
        break
    else
        echo "Waiting for application startup preflight (HTTP ${STATUS_CODE}, attempt $i/15)..."
        sleep 5
    fi
done

if [ "$READY" != true ]; then
    echo "ERROR: Application /ready endpoint did not return HTTP 200 within 75 seconds." >&2
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

echo ""
echo "Fetching recent application container logs..."
az containerapp logs show \
    --name "${APP_NAME}" \
    --resource-group "${RESOURCE_GROUP}" \
    --tail 30 || true

echo ""
echo "=================================================================="
echo " Deployment Succeeded & Verified Live!"
echo " Public Mobile Test URL: ${PUBLIC_URL}"
echo " Health Endpoint:        ${PUBLIC_URL}/health"
echo " Readiness Endpoint:     ${PUBLIC_URL}/ready"
echo " Capabilities Endpoint:  ${PUBLIC_URL}/api/capabilities"
echo "=================================================================="
