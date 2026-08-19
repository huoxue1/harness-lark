#!/bin/bash
# One-shot install of the harness-lark Feishu plugin into a dsh profile.
#
# Usage:
#   export FEISHU_APP_ID=cli_xxx
#   export FEISHU_APP_SECRET=your_secret
#   bash scripts/install-dsh.sh [profile] [plugin-source]
#
#   profile:      dsh profile name (default: web)
#   plugin-source: npm package name or local path; defaults to `harness-lark`
#                  (published npm package). For a local checkout use the repo
#                  path, e.g. `bash scripts/install-dsh.sh web .`
#
# The script:
#   1. installs the plugin into the profile (`dsh plugin --profile <p> add <src>`).
#      Because harness-lark declares `dsh.bundle.patch`, the plugin's own
#      cordis.patch.yml is applied automatically as a bundle layer — no manual
#      patch editing is needed; credentials come from the environment.
#   2. starts `dsh --profile <p>` with optional --trusted-host args
#
# Prereqs: a working `dsh` CLI on PATH, and the profile's runtime deps
# (node >= 22, pnpm for out-of-tree installs).
set -e

PROFILE="${1:-web}"
PLUGIN_SOURCE="${2:-harness-lark}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"

if [ -z "$FEISHU_APP_ID" ] || [ -z "$FEISHU_APP_SECRET" ]; then
  echo "error: FEISHU_APP_ID and FEISHU_APP_SECRET must be set" >&2
  exit 1
fi

echo "[harness-lark] installing plugin into profile '$PROFILE' from '$PLUGIN_SOURCE'..."
dsh plugin --profile "$PROFILE" add "$PLUGIN_SOURCE"

echo "[harness-lark] starting dsh --profile $PROFILE..."
TRUSTED_ARGS=()
for authority in ${DSH_TRUSTED_HOSTS:-}; do
  TRUSTED_ARGS+=(--trusted-host "$authority")
done
exec dsh --profile "$PROFILE" "${TRUSTED_ARGS[@]}"
