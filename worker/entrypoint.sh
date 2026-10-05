#!/bin/sh
# Worker entrypoint: 1) install an egress firewall (private ranges blocked except the web API),
# 2) drop root and start the worker. Refuses to start if the firewall is not active.
set -eu
WEB_HOST="${WEB_HOST:-web}"
WEB_PORT="${WEB_PORT:-3000}"

WEB_IP=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  WEB_IP="$(getent ahostsv4 "$WEB_HOST" | awk 'NR==1{print $1}')"
  [ -n "$WEB_IP" ] && break
  sleep 1
done
[ -n "$WEB_IP" ] || { echo "entrypoint: cannot resolve $WEB_HOST" >&2; exit 1; }

iptables -F OUTPUT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -d "$WEB_IP" -p tcp --dport "$WEB_PORT" -j ACCEPT
# Docker's embedded DNS (127.0.0.11) is on loopback, public resolvers are configured in compose.
for net in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 \
           192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4; do
  iptables -A OUTPUT -d "$net" -j REJECT
done
iptables -A OUTPUT -j ACCEPT

if command -v ip6tables >/dev/null 2>&1; then
  ip6tables -F OUTPUT 2>/dev/null || true
  ip6tables -A OUTPUT -o lo -j ACCEPT 2>/dev/null || true
  ip6tables -P OUTPUT DROP 2>/dev/null || true
fi

iptables -C OUTPUT -d 10.0.0.0/8 -j REJECT || { echo "entrypoint: firewall not active, refusing to start" >&2; exit 1; }
echo "entrypoint: egress firewall active (web API at $WEB_IP:$WEB_PORT)"

# No chown: CAP_CHOWN is dropped. /tmp is a private tmpfs of this container, so 777 is fine.
mkdir -p /tmp/home && chmod 777 /tmp/home
export HOME=/tmp/home
exec setpriv --reuid=node --regid=node --clear-groups node /app/worker/worker.js "$@"
