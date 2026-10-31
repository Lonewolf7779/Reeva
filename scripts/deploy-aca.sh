#!/usr/bin/env bash
# ==============================================================================
# Reeva — Azure Container Apps Production Deployment Script
# Subscription: Azure for Students | RG: reeva-rg | Region: Central India
# ==============================================================================

set -euo pipefail

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
echo " Feature Gates:  YouTube=ON, Twitter=ON, Pinterest=ON, Generic=ON"
echo "                 Instagram=OFF, TikTok=OFF, Facebook=OFF"
echo "=================================================================="

# ------------------------------------------------------------------------------
# PHASE 2: AZURE RESOURCE VALIDATION
# ------------------------------------------------------------------------------
echo ""
echo "--> [Phase 2] Checking Azure provider registration..."

# Ensure Microsoft.App and Microsoft.OperationalInsights are registered
for NS in Microsoft.App Microsoft.OperationalInsights; do
    STATE=$(az provider show -n "$NS" --query "registrationState" -o tsv 2>/dev/null || echo "NotRegistered")
    if [ "$STATE" != "Registered" ]; then
        echo "Registering provider $NS..."
        az provider register --namespace "$NS" --wait
    else
        echo "Provider $NS is Registered."
    fi
done

# Check or discover Container Apps Environment
echo "Checking for existing Container Apps Environment in ${RESOURCE_GROUP}..."
ENV_NAME=$(az containerapp env list --resource-group "${RESOURCE_GROUP}" --query "[0].name" -o tsv 2>/dev/null || true)

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
ACR_ID=$(az acr show --name "${ACR_NAME}" --resource-group "${RESOURCE_GROUP}" --query id -o tsv)
DISCOVERED_SERVER=$(az acr show --name "${ACR_NAME}" --resource-group "${RESOURCE_GROUP}" --query loginServer -o tsv)

if [ "${DISCOVERED_SERVER}" != "${ACR_LOGIN_SERVER}" ]; then
    echo "ERROR: Discovered ACR login server (${DISCOVERED_SERVER}) does not match expected (${ACR_LOGIN_SERVER})!" >&2
    exit 1
fi
echo "Verified ACR: ${ACR_NAME} (${ACR_ID})"

# Check if Container App already exists
APP_EXISTS=$(az containerapp show --name "${APP_NAME}" --resource-group "${RESOURCE_GROUP}" --query "name" -o tsv 2>/dev/null || true)

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
    --query principalId -o tsv)

if [ -z "$PRINCIPAL_ID" ] || [ "$PRINCIPAL_ID" == "null" ]; then
    echo "Enabling System-Assigned Managed Identity on ${APP_NAME}..."
    az containerapp identity assign \
        --name "${APP_NAME}" \
        --resource-group "${RESOURCE_GROUP}" \
        --system-assigned
    PRINCIPAL_ID=$(az containerapp identity show \
        --name "${APP_NAME}" \
        --resource-group "${RESOURCE_GROUP}" \
        --query principalId -o tsv)
fi

echo "System-Assigned Principal ID: ${PRINCIPAL_ID}"

# Grant AcrPull role to the Container App's System-Assigned Identity on the ACR
echo "Verifying / granting 'AcrPull' role assignment on ${ACR_NAME}..."
EXISTING_ROLE=$(az role assignment list \
    --assignee "${PRINCIPAL_ID}" \
    --scope "${ACR_ID}" \
    --query "[?roleDefinitionName=='AcrPull'].id" -o tsv 2>/dev/null || true)

if [ -z "$EXISTING_ROLE" ]; then
    echo "Creating AcrPull role assignment for Managed Identity..."
    az role assignment create \
        --assignee "${PRINCIPAL_ID}" \
        --role "AcrPull" \
        --scope "${ACR_ID}"
    
    echo "Waiting for Azure RBAC propagation across regional endpoints..."
    MAX_ATTEMPTS=12
    ATTEMPT=1
    while [ $ATTEMPT -le $MAX_ATTEMPTS ]; do
        ROLE_CONFIRMED=$(az role assignment list \
            --assignee "${PRINCIPAL_ID}" \
            --scope "${ACR_ID}" \
            --query "[?roleDefinitionName=='AcrPull'].id" -o tsv 2>/dev/null || true)
        if [ -n "$ROLE_CONFIRMED" ]; then
            echo "AcrPull role verified on attempt ${ATTEMPT}."
            break
        fi
        echo "Waiting for role assignment visibility (attempt ${ATTEMPT}/${MAX_ATTEMPTS})..."
        sleep 5
        ATTEMPT=$((ATTEMPT + 1))
    done
    echo "Allowing 15s buffer for ACR data-plane token issuance cache..."
    sleep 15
else
    echo "AcrPull role assignment already confirmed present."
fi

# Link Container App to ACR using the System Identity (Zero passwords)
echo "Configuring Container App registry settings with managed identity..."
az containerapp registry set \
    --name "${APP_NAME}" \
    --resource-group "${RESOURCE_GROUP}" \
    --server "${ACR_LOGIN_SERVER}" \
    --identity system

# ------------------------------------------------------------------------------
# PHASE 4: DEPLOYMENT WITH PRODUCTION HARDENING
# ------------------------------------------------------------------------------
echo ""
echo "--> [Phase 4] Deploying Reeva production image and environment configuration..."

az containerapp update \
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
        REEVA_ENABLE_PINTEREST=true \
        REEVA_ENABLE_GENERIC=true \
        REEVA_ENABLE_INSTAGRAM=false \
        REEVA_ENABLE_TIKTOK=false \
        REEVA_ENABLE_FACEBOOK=false \
        REEVA_ENABLE_AUDIO_ONLY=true

# ------------------------------------------------------------------------------
# PHASE 5: LIVE VERIFICATION & HEALTH CHECKS
# ------------------------------------------------------------------------------
echo ""
echo "--> [Phase 5] Running live verification..."

PROVISIONING_STATE=$(az containerapp show \
    --name "${APP_NAME}" \
    --resource-group "${RESOURCE_GROUP}" \
    --query "properties.provisioningState" -o tsv)

echo "Container App Provisioning State: ${PROVISIONING_STATE}"

FQDN=$(az containerapp show \
    --name "${APP_NAME}" \
    --resource-group "${RESOURCE_GROUP}" \
    --query "properties.configuration.ingress.fqdn" -o tsv)

PUBLIC_URL="https://${FQDN}"
echo "Public Application HTTPS URL: ${PUBLIC_URL}"

echo "Polling application readiness probe (/ready)..."
READY=false
for i in {1..12}; do
    STATUS_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${PUBLIC_URL}/ready" || echo "000")
    if [ "$STATUS_CODE" -eq 200 ]; then
        echo "Application reported HTTP 200 (READY) on attempt $i."
        READY=true
        break
    else
        echo "Waiting for application startup preflight (HTTP ${STATUS_CODE}, attempt $i/12)..."
        sleep 5
    fi
done

echo ""
echo "Verifying Liveness Probe (/health):"
curl -sS "${PUBLIC_URL}/health" || echo "Health probe failed"
echo ""

echo "Verifying Readiness Probe (/ready):"
curl -sS "${PUBLIC_URL}/ready" || echo "Ready probe failed"
echo ""

echo "Fetching recent application container logs..."
az containerapp logs show \
    --name "${APP_NAME}" \
    --resource-group "${RESOURCE_GROUP}" \
    --tail 30 || true

echo ""
echo "=================================================================="
if [ "$READY" = true ]; then
    echo " Deployment Succeeded & Ready for Testing!"
    echo " Mobile Test URL: ${PUBLIC_URL}"
else
    echo " Deployment completed but /ready returned non-200. Inspect logs above."
    echo " Mobile Test URL: ${PUBLIC_URL}"
fi
echo "=================================================================="
