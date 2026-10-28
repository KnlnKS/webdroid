export function bootstrap(arch: "arm64" | "x64"): string {
  return `#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl xz-utils caddy iproute2 iptables-persistent
useradd --system --home /var/lib/webdroid --create-home --shell /usr/sbin/nologin webdroid
install -d -o webdroid -g webdroid /opt/webdroid
curl -fsSLO https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-${arch}.tar.xz
curl -fsSL https://nodejs.org/dist/v24.22.1/SHASUMS256.txt | grep ' node-v24.22.1-linux-${arch}.tar.xz$' | sha256sum -c -
tar -xJf node-v24.22.1-linux-${arch}.tar.xz -C /usr/local --strip-components=1
rm node-v24.22.1-linux-${arch}.tar.xz
cat > /etc/systemd/system/webdroid.service <<'SERVICE'
[Unit]
Description=Webdroid backend
After=network-online.target webdroid-bandwidth.service
Requires=webdroid-bandwidth.service
Wants=network-online.target
ConditionPathExists=/opt/webdroid/server.mjs
[Service]
User=webdroid
Group=webdroid
EnvironmentFile=/etc/webdroid.env
ExecStart=/usr/local/bin/node /opt/webdroid/server.mjs
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
LimitNOFILE=16384
[Install]
WantedBy=multi-user.target
SERVICE
iptables -I INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT
netfilter-persistent save
cat > /usr/local/sbin/webdroid-bandwidth <<'BANDWIDTH'
#!/bin/sh
set -eu
dev=$(ip -4 route show default | awk '{print $5; exit}')
tc qdisc replace dev "$dev" root tbf rate 20mbit burst 2mb latency 100ms
BANDWIDTH
chmod 755 /usr/local/sbin/webdroid-bandwidth
cat > /etc/systemd/system/webdroid-bandwidth.service <<'SERVICE'
[Unit]
Description=Bound egress to less than 7 TB per month
After=network-online.target
Before=webdroid.service caddy.service
Wants=network-online.target
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/webdroid-bandwidth
[Install]
WantedBy=multi-user.target
SERVICE
systemctl daemon-reload
systemctl enable --now webdroid-bandwidth
systemctl enable webdroid
`;
}
