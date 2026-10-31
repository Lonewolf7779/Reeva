# Azure OIDC & GitHub Actions Deployment Setup Guide
## Azure Container Registry Build & Push (Passwordless OIDC)

---

### Overview

This guide details the exact steps required to configure **OpenID Connect (OIDC)** authentication between **GitHub Actions** and **Microsoft Azure**.

This allows GitHub-hosted runners to build the `linux/amd64` Docker image and push directly to `reevaacr20261031-hpg2jgtbxb6c5hv.azurecr.io/reeva:mobile-test` **without requiring Azure Container Registry admin user credentials, permanent passwords, or long-lived client secrets**.

---

### 1. Azure Federated Identity Configuration (OIDC)

You need either an **Azure User-Assigned Managed Identity** (recommended) or a **Microsoft Entra ID App Registration**.

#### Option A: User-Assigned Managed Identity (Recommended)

1. **Create the Managed Identity** (in resource group `reeva-rg`):
   ```bash
   az identity create \
     --name reeva-gh-actions-identity \
     --resource-group reeva-rg
   ```
2. **Note the Identity IDs**:
   ```bash
   # Retrieve Client ID and Principal (Object) ID
   az identity show \
     --name reeva-gh-actions-identity \
     --resource-group reeva-rg \
     --query "{clientId: clientId, principalId: principalId, tenantId: tenantId}" \
     --output json
   ```
3. **Add the Federated Credential for GitHub Actions**:
   ```bash
   az identity federated-credential create \
     --name reeva-gh-actions-fedcred \
     --identity-name reeva-gh-actions-identity \
     --resource-group reeva-rg \
     --issuer "https://token.actions.githubusercontent.com" \
     --subject "repo:Lonewolf7779/Reeva:ref:refs/heads/phase-4.2-production-platform-gates" \
     --audience "api://AzureADTokenExchange"
   ```
   *(Note: To also allow workflow dispatch from a pull request or any branch, you can create a second credential with subject `repo:Lonewolf7779/Reeva:job_workflow_ref:...` or a branch wildcard).*

---

### 2. Minimum Azure RBAC Permissions

The managed identity only needs permission to push images into the `reevaacr20261031` registry.

1. **Get the Resource ID of the Container Registry**:
   ```bash
   ACR_ID=$(az acr show \
     --name reevaacr20261031 \
     --resource-group reeva-rg \
     --query id \
     --output tsv)
   ```

2. **Assign the `AcrPush` Role** to the Managed Identity:
   ```bash
   IDENTITY_PRINCIPAL_ID=$(az identity show \
     --name reeva-gh-actions-identity \
     --resource-group reeva-rg \
     --query principalId \
     --output tsv)

   az role assignment create \
     --assignee "$IDENTITY_PRINCIPAL_ID" \
     --role "AcrPush" \
     --scope "$ACR_ID"
   ```

3. **(Optional) Reader on Resource Group**:
   If needed by Azure CLI to resolve the ACR instance:
   ```bash
   RG_ID=$(az group show --name reeva-rg --query id --output tsv)
   az role assignment create \
     --assignee "$IDENTITY_PRINCIPAL_ID" \
     --role "Reader" \
     --scope "$RG_ID"
   ```

---

### 3. GitHub Repository Secrets Configuration

Navigate to **GitHub** -> `Lonewolf7779/Reeva` -> **Settings** -> **Secrets and variables** -> **Actions** -> **New repository secret**:

| Secret Name | Source / Value | Description |
| :--- | :--- | :--- |
| `AZURE_CLIENT_ID` | Output from step 1 (`clientId`) | Application / Client ID of the Managed Identity |
| `AZURE_TENANT_ID` | Output from step 1 (`tenantId`) | Microsoft Entra ID Directory / Tenant ID |
| `AZURE_SUBSCRIPTION_ID` | `az account show --query id -o tsv` | Azure Subscription ID (Azure for Students) |

---

### 4. Workflow Execution via `workflow_dispatch`

Once secrets are configured and the workflow is committed:

1. Navigate to the **Actions** tab in GitHub (`Lonewolf7779/Reeva/actions`).
2. Select **"Build and Push to Azure Container Registry"** on the left.
3. Click **"Run workflow"**.
4. Choose Branch: `phase-4.2-production-platform-gates`.
5. Enter Image Tag (defaults to `mobile-test`).
6. Click **"Run workflow"**.

The workflow will:
1. Verify runner architecture is `linux/amd64`.
2. Run automated test suites (`node scripts/run-tests.cjs`).
3. Connect securely via OIDC.
4. Authenticate to `reevaacr20261031` via Azure CLI.
5. Build the multi-stage Dockerfile for `linux/amd64`.
6. Push `reevaacr20261031-hpg2jgtbxb6c5hv.azurecr.io/reeva:mobile-test`.
