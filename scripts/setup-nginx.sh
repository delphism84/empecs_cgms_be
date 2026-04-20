#!/bin/bash
# empecs CGMS nginx — 저장소의 단일 소스: nginx/empecs.lunarsystem.co.kr.conf
# 사용법:
#   sudo cp nginx/empecs.lunarsystem.co.kr.conf /etc/nginx/sites-available/empecs
#   sudo nginx -t && sudo systemctl reload nginx
#
# 포트: Admin FE(Next) 63103 · BE(Express) 63101 · Mongo 호스트 47011 (docker-compose.yml)

set -e
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONF_SRC="$REPO_ROOT/nginx/empecs.lunarsystem.co.kr.conf"
NGINX_CONF="/etc/nginx/sites-available/empecs"

if [ ! -f "$CONF_SRC" ]; then
  echo "[empecs Nginx] 없음: $CONF_SRC"
  exit 1
fi

echo "[empecs Nginx] $CONF_SRC → $NGINX_CONF"
sudo cp "$CONF_SRC" "$NGINX_CONF"

if [ ! -L "/etc/nginx/sites-enabled/empecs" ]; then
  sudo ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/empecs
fi

sudo nginx -t
sudo systemctl reload nginx
echo "[empecs Nginx] 완료 — https://empecs.lunarsystem.co.kr/ → FE:63103, /api → BE:63101"
