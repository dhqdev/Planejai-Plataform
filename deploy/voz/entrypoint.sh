#!/bin/sh
# Monta a configuração do Asterisk a partir das variáveis VOZ_*, sobe o Asterisk e depois o serviço voz.py.
set -e
: "${VOZ_TOKEN:?defina VOZ_TOKEN (o mesmo da stack do Planejai)}"
: "${VOZ_SENHA_GATEWAY:?defina VOZ_SENHA_GATEWAY (senha que vai no gateway GSM)}"
export VOZ_SIP_PORTA="${VOZ_SIP_PORTA:-5070}"
export VOZ_ARI_SENHA="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
if [ "${#VOZ_SENHA_GATEWAY}" -lt 16 ]; then echo "VOZ_SENHA_GATEWAY precisa de pelo menos 16 caracteres" >&2; exit 1; fi
if [ -n "$VOZ_IP_PUBLICO" ]; then
  export VOZ_NAT="external_media_address=$VOZ_IP_PUBLICO
external_signaling_address=$VOZ_IP_PUBLICO
local_net=10.0.0.0/8
local_net=172.16.0.0/12
local_net=192.168.0.0/16"
else
  export VOZ_NAT=""
fi

cp /opt/voz/asterisk/*.conf /etc/asterisk/
# exemplo que vem no pacote e não abre (só gera erro no log)
rm -f /etc/asterisk/geolocation.conf
# só as variáveis VOZ_* entram (o ${PJ_AUDIO} do dialplan fica como está)
/opt/piper/bin/python - <<'PY'
import os, re
for name in ("pjsip.conf", "ari.conf"):
    p = f"/etc/asterisk/{name}"
    s = open(p).read()
    s = re.sub(r"\$\{(VOZ_[A-Z_]+)\}", lambda m: os.environ.get(m.group(1), ""), s)
    open(p, "w").write(s)
PY
chmod 640 /etc/asterisk/pjsip.conf /etc/asterisk/ari.conf
chown -R asterisk:asterisk /etc/asterisk /var/lib/asterisk /var/spool/asterisk /var/log/asterisk /var/run/asterisk 2>/dev/null || true
mkdir -p /var/lib/asterisk/sounds/planejai && chown asterisk:asterisk /var/lib/asterisk/sounds/planejai

# Asterisk em primeiro plano, num processo filho; se ele cair, o contêiner cai junto e o Swarm sobe de novo
asterisk -f -U asterisk -G asterisk &
AST=$!
/opt/piper/bin/python /opt/voz/voz.py &
VOZ=$!
trap 'kill $AST $VOZ 2>/dev/null' TERM INT
# sai quando qualquer um dos dois parar
while kill -0 $AST 2>/dev/null && kill -0 $VOZ 2>/dev/null; do sleep 2; done
kill $AST $VOZ 2>/dev/null || true
exit 1
