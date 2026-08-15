#!/bin/bash
# First-run installer for the harness-lark plugin, then boot dsh web.
#
# The profile lives in the DSH_HOME volume (/root/.dsh), which starts empty on
# a fresh volume, so the plugin is installed at first start (not baked in).
# The marker file skips re-installation on later restarts; the generated
# profile patch (cordis.patch.yml) is the source of truth and can be edited
# afterwards — the entrypoint never overwrites it once created.
set -e

export DSH_HOME=${DSH_HOME:-/root/.dsh}
PROFILE_DIR="$DSH_HOME/profiles/web"
PROFILE_PATCH="$PROFILE_DIR/cordis.patch.yml"
PLUGIN_SRC=/plugins/harness-lark

if [ ! -f "$PROFILE_DIR/.harness-lark-installed" ]; then
  echo '[entrypoint] installing harness-lark plugin...'
  dsh plugin --profile web add "file:$PLUGIN_SRC" > /tmp/plugin-install.log 2>&1 || {
    echo '[entrypoint] plugin add failed:'
    tail -5 /tmp/plugin-install.log
  }
  mkdir -p "$PROFILE_DIR"
  cat > "$PROFILE_PATCH" << 'PATCH'
# harness-lark Feishu channel (managed by docker-entrypoint.sh)
- id: lark
  config:
    appId: !!js process.env.FEISHU_APP_ID
    appSecret: !!js process.env.FEISHU_APP_SECRET
    brand: feishu
    connectionMode: websocket
    dmPolicy: open
    groupPolicy: open
    requireMentionInGroups: true
    respondToMentionAll: false
    replyMode: streaming
    topicSeparateSession: true
PATCH
  touch "$PROFILE_DIR/.harness-lark-installed"
  echo '[entrypoint] harness-lark configured (streaming group replies)'
fi

echo '[entrypoint] starting dsh web...'
exec dsh --profile web
