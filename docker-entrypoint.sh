#!/bin/bash
# First-run installer for the harness-lark plugin, then boot dsh web.
#
# The profile lives in the DSH_HOME volume (/root/.dsh), which starts empty on
# a fresh volume, so the plugin is installed at first start (not baked in).
# The marker file skips re-installation on later restarts. The plugin declares
# `dsh.bundle.patch`, so `dsh plugin add` applies its cordis.patch.yml
# automatically as a bundle layer — no profile patch is written here. The
# profile's own cordis.patch.yml (if any) is the user's override layer and is
# never touched.
set -e

export DSH_HOME=${DSH_HOME:-/root/.dsh}
PROFILE_DIR="$DSH_HOME/profiles/web"
PLUGIN_SRC=/plugins/harness-lark

# dsh web binds the container loopback by design (safety). Docker's published
# port reaches the container's bridge IP, not its loopback, so expose the UI
# through a tiny TCP forwarder on the container's own IP. Disable with
# DSH_WEB_FORWARD=0.
if [ "${DSH_WEB_FORWARD:-1}" != "0" ] && [ -f /usr/local/bin/dsh-port-forward.js ]; then
  node /usr/local/bin/dsh-port-forward.js 3080 &
fi

install_plugin() {
  dsh plugin --profile web add "file:$PLUGIN_SRC" > /tmp/plugin-install.log 2>&1
}

if [ ! -f "$PROFILE_DIR/.harness-lark-installed" ]; then
  echo '[entrypoint] installing harness-lark plugin...'
  if ! install_plugin; then
    # The npm dsh profile template leaves `allowBuilds.protobufjs` as the
    # placeholder text "set this to true or false"; pnpm then blocks that
    # build script and plugin add fails. Protobufjs's postinstall is a
    # harmless regeneration (production profiles set it to true), so patch
    # the value and retry once before giving up loud.
    echo '[entrypoint] plugin add failed, patching allowBuilds.protobufjs and retrying...'
    sed -i 's/^\([[:space:]]*protobufjs:\).*$/\1 true/' "$PROFILE_DIR/pnpm-workspace.yaml" || true
    if ! install_plugin; then
      echo '[entrypoint] FATAL: harness-lark plugin install failed:'
      tail -10 /tmp/plugin-install.log
      exit 1
    fi
  fi
  touch "$PROFILE_DIR/.harness-lark-installed"
  echo '[entrypoint] harness-lark installed (plugin cordis.patch.yml applied as bundle layer)'
fi

echo '[entrypoint] starting dsh web...'
# dsh's /api trust fence rejects browsers whose Host is not explicitly trusted
# (it refuses binding 0.0.0.0, so LAN addresses are never auto-trusted). Pass
# every authority from DSH_TRUSTED_HOSTS (space-separated host or host:port).
TRUSTED_ARGS=()
for authority in ${DSH_TRUSTED_HOSTS:-}; do
  TRUSTED_ARGS+=(--trusted-host "$authority")
done
exec dsh --profile web "${TRUSTED_ARGS[@]}"
