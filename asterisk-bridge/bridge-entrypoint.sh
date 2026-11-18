#!/bin/sh
set -eu

SIP_PORT="${SIP_BRIDGE_SIP_PORT:-5080}"
RTP_START="${SIP_BRIDGE_RTP_START:-18000}"
RTP_END="${SIP_BRIDGE_RTP_END:-18060}"
ARI_PORT="${SIP_BRIDGE_ARI_PORT:-8088}"
ARI_USER="${SIP_BRIDGE_ARI_USERNAME:-ariana_bridge}"
ARI_PASS="${SIP_BRIDGE_ARI_PASSWORD:-ariana_bridge_local}"
ARI_APP="${SIP_BRIDGE_ARI_APP_NAME:-ariana-bridge}"
PUBLIC_IP="${SIP_BRIDGE_PUBLIC_IP:-}"

if [ -z "$PUBLIC_IP" ] && [ -n "${ARI_EXTERNAL_MEDIA_HOST:-}" ]; then
    case "$ARI_EXTERNAL_MEDIA_HOST" in
        127.0.0.1|0.0.0.0|localhost|api)
            PUBLIC_IP=""
            ;;
        *)
            PUBLIC_IP="$ARI_EXTERNAL_MEDIA_HOST"
            ;;
    esac
fi

mkdir -p /etc/asterisk /var/log/asterisk /var/run/asterisk

cat > /etc/asterisk/http.conf <<EOF
[general]
enabled=yes
bindaddr=0.0.0.0
bindport=${ARI_PORT}
EOF

cat > /etc/asterisk/ari.conf <<EOF
[general]
enabled=yes
pretty=yes
allowed_origins=*

[${ARI_USER}]
type=user
read_only=no
password=${ARI_PASS}
password_format=plain
EOF

cat > /etc/asterisk/rtp.conf <<EOF
[general]
rtpstart=${RTP_START}
rtpend=${RTP_END}
EOF

EXTERNAL_LINES=""
if [ -n "$PUBLIC_IP" ]; then
    EXTERNAL_LINES=$(cat <<EOT
local_net=127.0.0.0/8
local_net=172.16.0.0/12
external_media_address=${PUBLIC_IP}
external_signaling_address=${PUBLIC_IP}
EOT
)
fi

MATCH_LINES=""
if [ -n "${PBX_AMI_HOST:-}" ]; then
    MATCH_LINES="${MATCH_LINES}
match=${PBX_AMI_HOST}"
fi
MATCH_LINES="${MATCH_LINES}
match=192.168.0.0/16
match=10.0.0.0/8
match=172.16.0.0/12
match=127.0.0.0/8"

cat > /etc/asterisk/pjsip.conf <<EOF
[global]
type=global
user_agent=Ariana-Media-Bridge-20

[transport-udp]
type=transport
protocol=udp
bind=0.0.0.0:${SIP_PORT}
${EXTERNAL_LINES}

[transport-tcp]
type=transport
protocol=tcp
bind=0.0.0.0:${SIP_PORT}
${EXTERNAL_LINES}

[from-pbx]
type=endpoint
transport=transport-udp
context=from-pbx
disallow=all
allow=ulaw
allow=alaw
direct_media=no
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes

[from-pbx-aor]
type=aor
max_contacts=1

[from-pbx-identify]
type=identify
endpoint=from-pbx
${MATCH_LINES}
EOF

cat > /etc/asterisk/extensions.conf <<EOF
[general]
static=yes
writeprotect=no

[from-pbx]
exten => _X.,1,NoOp(Ariana SIP Bridge Stasis token \${EXTEN})
 same => n,Ringing()
 same => n,Stasis(${ARI_APP},\${EXTEN})
 same => n,Hangup()

exten => s,1,NoOp(Ariana SIP Bridge root s)
 same => n,Stasis(${ARI_APP},s)
 same => n,Hangup()
EOF

echo "[bridge] Starting headless Asterisk Media Bridge on SIP:${SIP_PORT} ARI:${ARI_PORT} RTP:${RTP_START}-${RTP_END} app=${ARI_APP} publicIp=${PUBLIC_IP:-auto}"
exec /usr/sbin/asterisk -f -vvv -T -U root
