#!/bin/bash
# empecs.lunarsystem.co.kr Let's Encrypt SSL 인증서 발급
# 사용법: sudo ./scripts/setup-ssl.sh
#
# 사전조건: empecs.lunarsystem.co.kr DNS가 이 서버 IP로 연결되어 있어야 함

set -e

DOMAIN="empecs.lunarsystem.co.kr"
EMAIL="admin@lunarsystem.co.kr"

echo "[empecs SSL] Let's Encrypt 인증서 발급"
echo "[empecs SSL] 도메인: $DOMAIN"

if ! command -v certbot &> /dev/null; then
    echo "[empecs SSL] certbot 설치 중..."
    sudo apt-get update
    sudo apt-get install -y certbot
fi

# 기존 nginx가 80 포트 사용 중이면 certbot --nginx 사용
if command -v nginx &> /dev/null && sudo systemctl is-active --quiet nginx 2>/dev/null; then
    echo "[empecs SSL] nginx 플러그인으로 인증서 발급..."
    sudo certbot certonly --nginx -d "$DOMAIN" --email "$EMAIL" --agree-tos --non-interactive
else
    echo "[empecs SSL] standalone 모드로 인증서 발급 (nginx 중지 필요 시 안내)"
    sudo certbot certonly --standalone -d "$DOMAIN" --email "$EMAIL" --agree-tos --non-interactive --preferred-challenges http
fi

CERT_PATH="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
KEY_PATH="/etc/letsencrypt/live/$DOMAIN/privkey.pem"

if [ -f "$CERT_PATH" ] && [ -f "$KEY_PATH" ]; then
    echo "[empecs SSL] 인증서 발급 완료!"
    echo "[empecs SSL] 이후 sudo ./scripts/setup-nginx.sh 실행"
else
    echo "[empecs SSL] 오류: 인증서 파일을 찾을 수 없습니다."
    exit 1
fi
