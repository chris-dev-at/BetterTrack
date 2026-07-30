# Edge-secret gate — DISABLED stub (the compose default).
#
# `$bt_edge_ok` is always 1 here, so infra/devbox/edge/bt-devbox-edge.conf lets
# every request through. This file exists so the edge conf's
# `include /etc/nginx/conf.d/edge-secret.inc` always resolves: a missing include
# makes nginx refuse to boot.
#
# NO SECRET EVER GOES IN THIS FILE — it is version-controlled. To ENFORCE the
# gate, copy edge-secret.enabled.inc.example to a path OUTSIDE this repo, put the
# real secret in it, and point compose at it:
#
#   BT_DEVBOX_EDGE_SECRET_INC=/absolute/path/outside/repo/edge-secret.inc
#
# See docs/deploy/devbox.md "Exposure" for the matching Cloudflare transform rule.
map $http_x_bt_edge $bt_edge_ok {
    default 1;
}
