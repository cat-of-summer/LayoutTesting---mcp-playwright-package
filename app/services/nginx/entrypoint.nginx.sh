#!/bin/sh
set -e

CONF="${NGINX_CONF:-playwright}"
TPL="/etc/nginx/configs/nginx.${CONF}.conf"

if [ ! -f "$TPL" ]; then
  echo "[nginx] Нет шаблона $TPL. Доступные NGINX_CONF:"
  ls /etc/nginx/configs/ | sed 's/^nginx\.//; s/\.conf$//; s/^/  /'
  exit 1
fi

DOCKER_NETWORK="$(ip route | grep -v default | awk '{print $1}' | head -1)"
[ -n "$DOCKER_NETWORK" ] || DOCKER_NETWORK="172.16.0.0/12"

if [ -n "${HTTP_LOGIN}" ] && [ -n "${HTTP_PASSWORD}" ]; then
  printf '%s:%s\n' "${HTTP_LOGIN}" "$(openssl passwd -apr1 "${HTTP_PASSWORD}")" > /etc/nginx/.htpasswd
  AUTH_BASIC="Restricted"
else
  : > /etc/nginx/.htpasswd
  AUTH_BASIC="off"
fi

INSTANCE="${INSTANCE:-}"
DIST_PATH="${DIST_PATH:-artifacts}"
MCP_PORT="${MCP_PORT:-8931}"
CLIENT_MAX_BODY_SIZE="${CLIENT_MAX_BODY_SIZE:-64M}"

export DOCKER_NETWORK AUTH_BASIC INSTANCE DIST_PATH MCP_PORT CLIENT_MAX_BODY_SIZE

defined=$(printenv | cut -d= -f1 | sed 's/^/${/; s/$/}/' | tr '\n' ' ')

mkdir -p /etc/nginx/snippets
for s in /etc/nginx/configs/snippets/*.conf; do
  [ -f "$s" ] || continue
  envsubst "$defined" < "$s" > "/etc/nginx/snippets/$(basename "$s")"
done

envsubst "$defined" < "$TPL" > /etc/nginx/conf.d/default.conf

echo "[nginx] NGINX_CONF=${CONF}"

exec "$@"
