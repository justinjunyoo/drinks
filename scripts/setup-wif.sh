#!/usr/bin/env bash
#
# One-time setup: lets this GitHub repo deploy to Cloud Run via GitHub Actions
# using Workload Identity Federation (WIF) — keyless, no service-account JSON.
#
# Run this ONCE, locally or in Google Cloud Shell, from an account with
# Owner/Editor on the project. It is safe to re-run (commands are idempotent-ish;
# "already exists" errors can be ignored).
#
# Usage:
#   PROJECT_ID=your-project-id ./scripts/setup-wif.sh
#
# When it finishes it prints the exact values to paste into
# GitHub -> repo Settings -> Secrets and variables -> Actions.

set -euo pipefail

# ---- Config (override via env vars) ----------------------------------------
PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID=your-gcp-project-id}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-drink-counter}"
GITHUB_REPO="${GITHUB_REPO:-justinjunyoo/drinks}"   # owner/repo allowed to deploy

POOL="${POOL:-github-pool}"
PROVIDER="${PROVIDER:-github-provider}"
DEPLOYER_SA_NAME="${DEPLOYER_SA_NAME:-github-deployer}"
# ----------------------------------------------------------------------------

echo ">> Project: $PROJECT_ID   Region: $REGION   Service: $SERVICE"
echo ">> Allowed GitHub repo: $GITHUB_REPO"
gcloud config set project "$PROJECT_ID" >/dev/null

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
DEPLOYER_SA="${DEPLOYER_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"  # Cloud Run default runtime SA

echo ">> Enabling required APIs..."
gcloud services enable \
  run.googleapis.com \
  firestore.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  iamcredentials.googleapis.com \
  iam.googleapis.com

echo ">> Creating deployer service account ($DEPLOYER_SA)..."
gcloud iam service-accounts create "$DEPLOYER_SA_NAME" \
  --display-name="GitHub Actions Cloud Run deployer" 2>/dev/null || echo "   (already exists)"

echo ">> Granting the deployer the roles needed for 'gcloud run deploy --source'..."
for ROLE in \
  roles/run.admin \
  roles/cloudbuild.builds.editor \
  roles/artifactregistry.admin \
  roles/storage.admin \
  roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${DEPLOYER_SA}" \
    --role="$ROLE" --condition=None >/dev/null
  echo "   + $ROLE"
done

echo ">> Letting the runtime service account read/write Firestore..."
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role="roles/datastore.user" --condition=None >/dev/null

echo ">> Creating Workload Identity Pool + GitHub OIDC provider..."
gcloud iam workload-identity-pools create "$POOL" \
  --location=global --display-name="GitHub Actions pool" 2>/dev/null || echo "   (pool already exists)"

# The attribute-condition restricts token exchange to THIS repo only —
# without it, any GitHub repo in the world could impersonate the deployer.
gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
  --location=global \
  --workload-identity-pool="$POOL" \
  --display-name="GitHub OIDC" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
  --attribute-condition="assertion.repository=='${GITHUB_REPO}'" 2>/dev/null \
  || echo "   (provider already exists — delete it first if you need to change the repo condition)"

echo ">> Allowing '$GITHUB_REPO' to impersonate the deployer service account..."
gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER_SA" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${GITHUB_REPO}" >/dev/null

WIF_PROVIDER="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}"

cat <<EOF

============================================================================
 Setup complete. Add these in GitHub:
 repo -> Settings -> Secrets and variables -> Actions
============================================================================

 SECRETS (New repository secret):
   GCP_WIF_PROVIDER = ${WIF_PROVIDER}
   GCP_DEPLOY_SA    = ${DEPLOYER_SA}

 VARIABLES (Variables tab -> New repository variable):
   GCP_PROJECT_ID    = ${PROJECT_ID}
   GCP_REGION        = ${REGION}
   CLOUD_RUN_SERVICE = ${SERVICE}

 (First-time only) create the Firestore database if you haven't:
   gcloud firestore databases create --location=nam5

 Then push to 'main' (or run the workflow manually from the Actions tab)
 and GitHub will deploy to Cloud Run.
============================================================================
EOF
