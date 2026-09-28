#!/usr/bin/env bash
# Setup de "Quitar fondo" en Ubuntu 22.04/24.04 (EC2).
# Uso:
#   1) Copia el proyecto a /opt/quitar-fondo (scp o git).
#      Ej: scp -r -i clave.pem . ubuntu@TU_IP:/tmp/app && ssh -i clave.pem ubuntu@TU_IP "sudo mkdir -p /opt/quitar-fondo && sudo cp -r /tmp/app/* /opt/quitar-fondo/ && sudo chown -R ubuntu:ubuntu /opt/quitar-fondo"
#   2) ssh -i clave.pem ubuntu@TU_IP "sudo bash /opt/quitar-fondo/deploy/aws-setup.sh"
#   3) Entra a http://TU_IP/  (y http://TU_IP/api/health)
set -euo pipefail
APP_DIR=/opt/quitar-fondo

echo "==> Node.js 22..."
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node --version

echo "==> Dependencias del sistema (sharp/onnx)..."
apt-get update -y
apt-get install -y nginx curl ca-certificates

echo "==> App..."
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

echo "==> systemd..."
cp "$APP_DIR/deploy/quitar-fondo.service" /etc/systemd/system/quitar-fondo.service
systemctl daemon-reload
systemctl enable --now quitar-fondo
sleep 3
systemctl status quitar-fondo --no-pager || true

echo "==> nginx (:80 -> :3000)..."
cp "$APP_DIR/deploy/nginx-quitar-fondo.conf" /etc/nginx/sites-available/quitar-fondo
ln -sf /etc/nginx/sites-available/quitar-fondo /etc/nginx/sites-enabled/quitar-fondo
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable --now nginx
systemctl reload nginx

echo "==> firewall..."
ufw allow 80/tcp || true
ufw allow 22/tcp || true
ufw --force enable || true

echo "==> Listo. Prueba:"
echo "    curl http://localhost:3000/api/health"
echo "    Desde tu PC: http://TU_IP/  y http://TU_IP/api/health"
echo "    (La 1ª vez descarga el modelo ~977 MB y puede tardar varios minutos.)"
