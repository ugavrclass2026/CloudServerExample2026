#!/usr/bin/env bash
# Turns this Google Cloud VM into your VR server. Run it from this folder:   ./setup.sh
#   - installs Node (Debian's) and Caddy (from Caddy's own repository; Debian's is too old for IP certificates)
#   - runs server.mjs as a service that restarts on its own and starts at boot
#   - puts Caddy in front on ports 80 and 443 with an HTTPS certificate for this VM's IP address (Let's Encrypt)
# Safe to run again, for example after the VM gets a new IP address.
set -euo pipefail
cd "$(dirname "$0")"

meta() { curl -sf -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/$1"; }
IP=$(meta instance/network-interfaces/0/access-configs/0/external-ip) || { echo "No external IP: give the VM an external IPv4 address"; exit 1; }
PROJECT=$(meta project/project-id)
SCOPES=$(meta instance/service-accounts/default/scopes || true)
echo "== VM $IP in project $PROJECT"
if ! grep -q cloud-platform <<<"$SCOPES"; then
  echo "!! This VM can't call Google APIs (Gemini) yet: stop it, Edit > Access scopes > Allow full access to all Cloud APIs."
  echo "   The web server and the room still work; /api/chat will fail until then."
fi

echo "== installing Node and Caddy (a minute or two)"
sudo apt-get update -qq
sudo apt-get install -y -qq nodejs npm curl gpg debian-keyring debian-archive-keyring apt-transport-https >/dev/null
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 20 ]; then echo "!! Node $NODE_MAJOR is too old (need 20+): make the VM with Debian 13"; exit 1; fi
if ! command -v caddy >/dev/null || ! apt-cache policy caddy | grep -q cloudsmith; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  sudo apt-get update -qq
  sudo apt-get install -y -qq caddy >/dev/null
fi
echo "   node $(node --version), $(caddy version | cut -d' ' -f1)"

echo "== installing the server's packages"
npm install --omit=dev --no-audit --no-fund --loglevel=error

echo "== starting the server as a service"
sudo tee /etc/systemd/system/vrserver.service >/dev/null <<EOF
[Unit]
Description=VR class server (server.mjs)
After=network-online.target

[Service]
User=$USER
WorkingDirectory=$PWD
Environment=GOOGLE_CLOUD_PROJECT=$PROJECT
ExecStart=$(command -v node) server.mjs
Restart=always

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now vrserver >/dev/null 2>&1
sudo systemctl restart vrserver

echo "== HTTPS for $IP"
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
# Caddy: HTTPS for this VM's address, then everything goes to server.mjs on port 8080.
{
	# browsers send no name when you type an IP address; without this Caddy can't pick the certificate
	default_sni $IP
}

https://$IP {
	tls {
		issuer acme {
			# Let's Encrypt only gives IP addresses its 6-day certificates; Caddy renews them on its own
			profile shortlived
		}
	}
	reverse_proxy localhost:8080
}
EOF
sudo systemctl restart caddy

echo -n "   waiting for the certificate"
for i in $(seq 1 45); do
  # connect locally but check the real certificate for https://$IP (a VM can't always reach its own public IP)
  if curl -sf --max-time 3 --connect-to "$IP:443:127.0.0.1:443" "https://$IP/api/health" >/dev/null 2>&1; then
    echo; echo; echo "   Your server:  https://$IP"; echo
    exit 0
  fi
  echo -n "."; sleep 2
done
echo
echo "!! No HTTPS yet. Check:"
echo "   - the VM allows HTTP and HTTPS traffic (Edit > Networking > Firewalls: both boxes)"
echo "   - Caddy's log:  sudo journalctl -u caddy -n 30 --no-pager"
echo "   Plan B (works without a certificate):  ./tunnel.sh"
exit 1
