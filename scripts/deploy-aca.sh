#!/usr/bin/env bash
# ==============================================================================
# Reeva — Azure Container Apps Production Deployment Script
# Subscription: Azure for Students | RG: reeva-rg | Region: Central India
# ==============================================================================

set -euo pipefail

# ------------------------------------------------------------------------------
# Error Trap & Diagnostic Handler
# ------------------------------------------------------------------------------
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
echo " Region:         ${LOCATION}"
echo " Container App:  ${APP_NAME}"
echo " Target Image:   ${FULL_IMAGE}"
echo " Target Port:    ${TARGET_PORT}"
echo " Feature Gates:  YouTube=ON, Twitter/X=ON, Pinterest=ON, Generic=ON"
echo "                 Instagram=OFF, TikTok=OFF, Facebook=OFF"
echo "=================================================================="

# Ensure Azure CLI installs missing extensions non-interactively
az config set extension.use_dynamic_install=yes_without_prompt >/dev/null 2>&1 || true

# ------------------------------------------------------------------------------
# PHASE 2: AZURE RESOURCE VALIDATION
# ------------------------------------------------------------------------------
echo ""
echo "--> [Phase 2] Checking Azure provider registration..."

# Ensure Microsoft.App and Microsoft.OperationalInsights are registered
for NS in Microsoft.App Microsoft.OperationalInsights; do
    STATE=$(az provider show -n "$NS" --query "registrationState" -o tsv 2>/dev/null | tr -d '\r' || echo "NotRegistered")
    if [ "$STATE" != "Registered" ]; then
        echo "Registering provider $NS..."
        az provider register --namespace "$NS" --wait
    else
        echo "Provider $NS is Registered."
    fi
done

# Verify resource group exists
RG_EXISTS=$(az group show --name "${RESOURCE_GROUP}" --query "name" -o tsv 2>/dev/null | tr -d '\r' || true)
if [ -z "$RG_EXISTS" ]; then
    echo "ERROR: Target resource group '${RESOURCE_GROUP}' does not exist." >&2
    exit 1
fi

# Check or discover Container Apps Environment in reeva-rg
echo "Checking for existing Container Apps Environment in ${RESOURCE_GROUP}..."
ENV_NAME=$(az containerapp env list --resource-group "${RESOURCE_GROUP}" --query "[0].name" -o tsv 2>/dev/null | tr -d '\r' || true)

if [ -z "$ENV_NAME" ]; then
    ENV_NAME="reeva-env"
    echo "No existing environment found. Creating Consumption environment '${ENV_NAME}' in ${LOCATION}..."
    az containerapp env create \
        --name "${ENV_NAME}" \
        --resource-group "${RESOURCE_GROUP}" \
        --location "${LOCATION}"
else
    echo "Using existing Container Apps Environment: '${ENV_NAME}'"
fi

# ------------------------------------------------------------------------------
# PHASE 3: PRIVATE REGISTRY AUTHENTICATION (System-Assigned Managed Identity)
# ------------------------------------------------------------------------------
echo ""
echo "--> [Phase 3] Configuring ACR metadata & authentication..."

# Validate target ACR
ACR_ID=$(az acr show --name "${ACR_NAME}" --resource-group "${RESOURCE_GROUP}" --query id -o tsv | tr -d '\r')
DISCOVERED_SERVER=$(az acr show --name "${ACR_NAME}" --resource-group "${RESOURCE_GROUP}" --query loginServer -o tsv | tr -d '\r')

if [ "${DISCOVERED_SERVER}" != "${ACR_LOGIN_SERVER}" ]; then
    echo "ERROR: Discovered ACR login server (${DISCOVERED_SERVER}) does not match expected (${ACR_LOGIN_SERVER})!" >&2
    exit 1
fi
echo "Verified ACR: ${ACR_NAME} (${ACR_ID})"

# Check if Container App already exists
APP_EXISTS=$(az containerapp show --name "${APP_NAME}" --resource-group "${RESOURCE_GROUP}" --query "name" -o tsv 2>/dev/null | tr -d '\r' || true)

if [ -z "$APP_EXISTS" ]; then
    echo "Creating Container App '${APP_NAME}' with bootstrap container to establish System Managed Identity..."
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

# Retrieve System-Assigned Managed Identity Principal ID
echo "Retrieving System-Assigned Managed Identity Principal ID..."
PRINCIPAL_ID=$(az containerapp identity show \
    --name "${APP_NAME}" \
    --resource-group "${RESOURCE_GROUP}" \
    --query principalId -o tsv 2>/dev/null | tr -d '\r' || true)

if [ -z "$PRINCIPAL_ID" ] || [ "$PRINCIPAL_ID" = "null" ]; then
    echo "Enabling System-Assigned Managed Identity on ${APP_NAME}..."
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

# Grant AcrPull role to the Container App's System-Assigned Identity on the ACR
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

# Link Container App to ACR using the System Identity (Zero passwords) with retry for RBAC propagation
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
# PHASE 4: DEPLOYMENT WITH PRODUCTION HARDENING
# ------------------------------------------------------------------------------
echo ""
echo "--> [Phase 4] Deploying Reeva production image and environment configuration..."

DEPLOY_OK=false
for attempt in 1 2 3; do
    if az containerapp update \
        --name "${APP_NAME}" \
        --resource-group "${RESOURCE_GROUP}" \
        --image "${FULL_IMAGE}" \
        --min-replicas 0 \
        --max-replicas 1 \
        --set-env-vars \
            NODE_ENV=production \
            PORT=3000 \
            TRUST_PROXY=1 \
            REEVA_ENABLE_YOUTUBE=true \
            REEVA_ENABLE_TWITTER=true \
            REEVA_ENABLE_X=true \
            REEVA_ENABLE_PINTEREST=true \
            REEVA_ENABLE_GENERIC=true \
            REEVA_ENABLE_MORE_SITES=true \
            REEVA_ENABLE_INSTAGRAM=false \
            REEVA_ENABLE_TIKTOK=false \
            REEVA_ENABLE_FACEBOOK=false \
            REEVA_ENABLE_AUDIO_ONLY=true; then
        DEPLOY_OK=true
        break
    fi
    echo "Container image pull/update encountered transient propagation delay (attempt ${attempt}/3). Retrying in 15s..."
    sleep 15
done

if [ "$DEPLOY_OK" != true ]; then
    echo "ERROR: Failed to update Container App '${APP_NAME}' with image '${FULL_IMAGE}'." >&2
    exit 1
fi

# ------------------------------------------------------------------------------
# PHASE 5: LIVE VERIFICATION & HEALTH CHECKS
# ------------------------------------------------------------------------------
echo ""
echo "--> [Phase 5] Running live verification..."

PROVISIONING_STATE=$(az containerapp show \
    --name "${APP_NAME}" \
    --resource-group "${RESOURCE_GROUP}" \
    --query "properties.provisioningState" -o tsv | tr -d '\r')

echo "Container App Provisioning State: ${PROVISIONING_STATE}"
if [ "${PROVISIONING_STATE}" != "Succeeded" ]; then
    echo "ERROR: Container App provisioning state is '${PROVISIONING_STATE}' (expected 'Succeeded')." >&2
    exit 1
fi

FQDN=$(az containerapp show \
    --name "${APP_NAME}" \
    --resource-group "${RESOURCE_GROUP}" \
    --query "properties.configuration.ingress.fqdn" -o tsv | tr -d '\r')

if [ -z "$FQDN" ] || [ "$FQDN" = "null" ]; then
    echo "ERROR: Failed to resolve public ingress FQDN for '${APP_NAME}'." >&2
    exit 1
fi

PUBLIC_URL="https://${FQDN}"
echo "Public Application HTTPS URL: ${PUBLIC_URL}"

echo "Polling application readiness probe (${PUBLIC_URL}/ready)..."
READY=false
for i in {1..15}; do
    STATUS_CODE=$(curl -s -o /tmp/reeva_ready.json -w "%{http_code}" "${PUBLIC_URL}/ready" || echo "000")
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
HEALTH_CODE=$(curl -s -o /tmp/reeva_health.json -w "%{http_code}" "${PUBLIC_URL}/health" || echo "000")
cat /tmp/reeva_health.json
echo ""
if [ "$HEALTH_CODE" != "200" ]; then
    echo "ERROR: Liveness probe /health returned HTTP ${HEALTH_CODE} (expected 200)." >&2
    exit 1
fi

echo ""
echo "Verifying Readiness Probe (${PUBLIC_URL}/ready):"
cat /tmp/reeva_ready.json
echo ""

echo ""
echo "Verifying Production Feature Gates (${PUBLIC_URL}/api/capabilities):"
CAP_CODE=$(curl -s -o /tmp/reeva_caps.json -w "%{http_code}" "${PUBLIC_URL}/api/capabilities" || echo "000")
cat /tmp/reeva_caps.json
echo ""
if [ "$CAP_CODE" != "200" ]; then
    echo "ERROR: Capabilities endpoint /api/capabilities returned HTTP ${CAP_CODE} (expected 200)." >&2
    exit 1
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
echo " Public Mobile Test URL: ${PUBLIC_URL}"
echo " Health Endpoint:        ${PUBLIC_URL}/health"
echo " Readiness Endpoint:     ${PUBLIC_URL}/ready"
echo " Capabilities Endpoint:  ${PUBLIC_URL}/api/capabilities"
echo "=================================================================="
