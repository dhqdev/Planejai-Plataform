# Central de ligações do Planejai: Asterisk (liga pelo gateway GSM com o chip) + Piper (voz em português, local e grátis)
# + um serviço HTTP pequeno (voz.py) que o Planejai chama para pedir uma ligação. Imagem própria, separada da principal.
FROM ubuntu:24.04

ARG PIPER_VERSION=1.8.0
ARG VOICE_URL=https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/pt/pt_BR/faber/medium/pt_BR-faber-medium.onnx

ENV DEBIAN_FRONTEND=noninteractive TZ=America/Sao_Paulo
RUN apt-get update \
 && apt-get install -y --no-install-recommends asterisk asterisk-modules python3 python3-venv sox curl ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/piper \
 && /opt/piper/bin/pip install --no-cache-dir "piper-tts==${PIPER_VERSION}" \
 && mkdir -p /opt/voz/voice \
 && curl -fsSL --retry 3 -o /opt/voz/voice/pt_BR.onnx "$VOICE_URL" \
 && curl -fsSL --retry 3 -o /opt/voz/voice/pt_BR.onnx.json "$VOICE_URL.json" \
 && echo "Teste." | /opt/piper/bin/piper -m /opt/voz/voice/pt_BR.onnx -f /tmp/t.wav && rm /tmp/t.wav

COPY asterisk/ /opt/voz/asterisk/
COPY voz.py entrypoint.sh /opt/voz/
RUN chmod +x /opt/voz/entrypoint.sh

# 8080: API interna (só na rede da stack). SIP e áudio (RTP) vão abertos no servidor para o gateway GSM.
EXPOSE 8080 5070/udp 10000-10019/udp
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fsS http://127.0.0.1:8080/health >/dev/null || exit 1
ENTRYPOINT ["/opt/voz/entrypoint.sh"]
