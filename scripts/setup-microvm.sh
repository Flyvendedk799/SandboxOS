#!/usr/bin/env bash
# scripts/setup-microvm.sh — Linux host setup for Firecracker microVMs.
#
# Run once on the host (as root). Sets up:
#   - KVM device access for the sandboxos user/group
#   - TAP interface pool (tap0..tap7) with a host bridge (br0)
#   - IP masquerade so guests can reach the host (inbound is still blocked)
#   - NetworkManager ignore rule for TAP interfaces
#
# Usage:
#   sudo bash scripts/setup-microvm.sh [--user sandboxos] [--taps 8]
#
# Guest network:
#   Guest IPs:  172.20.0.2 – 172.20.0.9  (one per TAP)
#   Host bridge: 172.20.0.1/24
#   Default GW: 172.20.0.1 (host-side masquerade)

set -euo pipefail

SANDBOXOS_USER="${SANDBOXOS_USER:-sandboxos}"
TAP_COUNT="${TAP_COUNT:-8}"
BRIDGE="br0"
BRIDGE_IP="172.20.0.1"
SUBNET="172.20.0.0/24"

# ── KVM access ────────────────────────────────────────────────────────────────
if [[ ! -c /dev/kvm ]]; then
  echo "ERROR: /dev/kvm not found. Enable nested virtualisation or install KVM modules."
  exit 1
fi

if ! getent group kvm &>/dev/null; then
  groupadd kvm
fi
chown root:kvm /dev/kvm
chmod 660 /dev/kvm
usermod -aG kvm "$SANDBOXOS_USER" 2>/dev/null || true
echo "[kvm] /dev/kvm → group kvm (660). User '$SANDBOXOS_USER' added to kvm group."

# ── Bridge ────────────────────────────────────────────────────────────────────
if ! ip link show "$BRIDGE" &>/dev/null; then
  ip link add name "$BRIDGE" type bridge
  ip addr add "${BRIDGE_IP}/24" dev "$BRIDGE"
  ip link set "$BRIDGE" up
  echo "[bridge] $BRIDGE created at $BRIDGE_IP/24"
else
  echo "[bridge] $BRIDGE already exists"
fi

# ── TAP pool ──────────────────────────────────────────────────────────────────
for i in $(seq 0 $((TAP_COUNT - 1))); do
  TAP="tap${i}"
  if ! ip link show "$TAP" &>/dev/null; then
    ip tuntap add dev "$TAP" mode tap user "$SANDBOXOS_USER"
    ip link set "$TAP" master "$BRIDGE"
    ip link set "$TAP" up
    echo "[tap] $TAP created and attached to $BRIDGE"
  else
    echo "[tap] $TAP already exists"
  fi
done

# ── IP masquerade ─────────────────────────────────────────────────────────────
# Allow guests to initiate connections to the host (for MCP net.fetch).
# Inbound from internet is still blocked by default host firewall.
if ! iptables -t nat -C POSTROUTING -s "$SUBNET" -j MASQUERADE 2>/dev/null; then
  iptables -t nat -A POSTROUTING -s "$SUBNET" -j MASQUERADE
  echo "[iptables] MASQUERADE rule added for $SUBNET"
else
  echo "[iptables] MASQUERADE rule already present"
fi

sysctl -w net.ipv4.ip_forward=1 >/dev/null
echo "[sysctl] ip_forward=1"

# ── Persist across reboots (systemd-networkd) ─────────────────────────────────
mkdir -p /etc/systemd/network
cat > /etc/systemd/network/10-sandboxos-bridge.netdev <<NETDEV
[NetDev]
Name=$BRIDGE
Kind=bridge
NETDEV

cat > /etc/systemd/network/10-sandboxos-bridge.network <<NETWORK
[Match]
Name=$BRIDGE

[Network]
Address=${BRIDGE_IP}/24
IPForward=yes
NETWORK

for i in $(seq 0 $((TAP_COUNT - 1))); do
  TAP="tap${i}"
  cat > "/etc/systemd/network/20-sandboxos-${TAP}.netdev" <<NETDEV
[NetDev]
Name=$TAP
Kind=tap
[Tap]
User=$SANDBOXOS_USER
NETDEV
  cat > "/etc/systemd/network/20-sandboxos-${TAP}.network" <<NETWORK
[Match]
Name=$TAP

[Network]
Bridge=$BRIDGE
NETWORK
done

echo ""
echo "✓ Setup complete. Reload with: systemctl restart systemd-networkd"
echo "  Then log out and back in so '$SANDBOXOS_USER' inherits the kvm group."
