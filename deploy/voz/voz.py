"""
Serviço de ligações do Planejai (roda dentro da imagem voz, ao lado do Asterisk).

O Planejai pede "liga para tal número e fala tal texto" (POST /call com o VOZ_TOKEN). Aqui o texto vira voz
no Piper (local, grátis), o áudio vai para o Asterisk e a ligação sai pelo gateway GSM, uma de cada vez
(um chip só faz uma ligação por vez). Só números do Brasil. Sem dependência fora da biblioteca padrão.
"""

import base64
import glob
import hmac
import json
import os
import queue
import re
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ["VOZ_TOKEN"]
ARI = "http://127.0.0.1:8088/ari"
ARI_AUTH = "Basic " + base64.b64encode(f"planejai:{os.environ['VOZ_ARI_SENHA']}".encode()).decode()
SOUNDS = "/var/lib/asterisk/sounds/planejai"
VOICE = "/opt/voz/voice/pt_BR.onnx"
DDD = re.sub(r"\D", "", os.environ.get("VOZ_DDD", ""))
CSP = re.sub(r"\D", "", os.environ.get("VOZ_CSP", "21")) or "21"
DISCAGEM = os.environ.get("VOZ_DISCAGEM", "nacional")
MAX_FILA = 20

fila: "queue.Queue[dict]" = queue.Queue(MAX_FILA)
ultimas: dict = {}


def log(*a):
    print("[voz]", *a, flush=True)


def ari(method, path, params=None, body=None, timeout=10):
    url = f"{ARI}{path}" + (f"?{urllib.parse.urlencode(params)}" if params else "")
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Authorization": ARI_AUTH, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        return json.loads(raw) if raw else {}


def gateway_state():
    try:
        return ari("GET", "/endpoints/PJSIP/gsm").get("state", "unknown")
    except urllib.error.HTTPError as e:
        return "offline" if e.code == 404 else f"erro {e.code}"
    except Exception:
        return "asterisk fora do ar"


def discagem(numero: str):
    """Número com DDI (5519999999999) vira o que o chip disca: local no mesmo DDD, 0+operadora+DDD fora dele."""
    d = re.sub(r"\D", "", numero)
    if not re.fullmatch(r"55\d{10,11}", d):
        raise ValueError("Só ligo para números do Brasil, com DDD")
    ddd, local = d[2:4], d[4:]
    if DISCAGEM == "e164":
        return f"+{d}"
    if DDD and ddd == DDD:
        return local
    return f"0{CSP}{ddd}{local}"


def gerar_audio(texto: str, nome: str):
    bruto = f"/tmp/{nome}-bruto.wav"
    final = f"{SOUNDS}/{nome}.wav"
    subprocess.run(["/opt/piper/bin/piper", "-m", VOICE, "-f", bruto], input=texto.encode(), check=True, capture_output=True, timeout=60)
    # Asterisk toca .wav em 8 kHz, mono, 16 bits
    subprocess.run(["sox", bruto, "-r", "8000", "-c", "1", "-b", "16", final], check=True, capture_output=True, timeout=30)
    os.remove(bruto)
    os.chmod(final, 0o644)
    return f"{SOUNDS}/{nome}"  # caminho absoluto, sem extensão (o Asterisk acha o .wav)


def limpar_audios():
    for f in glob.glob(f"{SOUNDS}/*.wav"):
        if time.time() - os.path.getmtime(f) > 3600:
            try:
                os.remove(f)
            except OSError:
                pass


def ligar(item):
    """Uma ligação: gera o áudio, disca e espera terminar (até 3 min) antes de liberar o chip para a próxima."""
    id_ = item["id"]
    try:
        audio = gerar_audio(item["text"], id_)
        canal = ari(
            "POST",
            "/channels",
            {"endpoint": f"PJSIP/{item['dial']}@gsm", "context": "planejai-ligacao", "extension": "s", "priority": "1", "timeout": "40", "channelId": id_},
            {"variables": {"PJ_AUDIO": audio}},
        )
        ultimas[id_] = {"status": "ligando", "channel": canal.get("id")}
        log("ligando", id_)
        fim = time.time() + 180
        while time.time() < fim:
            time.sleep(2)
            try:
                ari("GET", f"/channels/{id_}")
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    break
        ultimas[id_] = {"status": "terminou"}
    except Exception as e:  # noqa: BLE001
        ultimas[id_] = {"status": "erro", "error": str(e)[:200]}
        log("erro", id_, e)
    finally:
        limpar_audios()


def trabalhador():
    while True:
        item = fila.get()
        ligar(item)
        if len(ultimas) > 200:
            for k in list(ultimas)[:100]:
                ultimas.pop(k, None)
        # pausa curta entre ligações: o gateway libera o canal
        time.sleep(3)


class Handler(BaseHTTPRequestHandler):
    server_version = "planejai-voz"

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _autorizado(self):
        h = self.headers.get("Authorization", "")
        return hmac.compare_digest(h.encode(), f"Bearer {TOKEN}".encode())

    def log_message(self, fmt, *args):  # sem log de cada pedido (o número da pessoa não vai para o log)
        pass

    def do_GET(self):
        if self.path == "/health":
            # saudável se o Asterisk responde; o gateway pode estar desligado sem derrubar o contêiner
            estado = gateway_state()
            return self._json(200 if estado != "asterisk fora do ar" else 503, {"ok": estado != "asterisk fora do ar"})
        if not self._autorizado():
            return self._json(401, {"error": "não autorizado"})
        if self.path == "/status":
            return self._json(200, {"gateway": gateway_state(), "fila": fila.qsize()})
        m = re.fullmatch(r"/calls/([0-9a-f-]{36})", self.path)
        if m:
            return self._json(200, ultimas.get(m.group(1), {"status": "desconhecida"}))
        self._json(404, {"error": "não encontrado"})

    def do_POST(self):
        if self.path != "/call":
            return self._json(404, {"error": "não encontrado"})
        if not self._autorizado():
            return self._json(401, {"error": "não autorizado"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
            if n > 4000:
                return self._json(413, {"error": "pedido grande demais"})
            data = json.loads(self.rfile.read(n) or b"{}")
            texto = re.sub(r"\s+", " ", str(data.get("text", ""))).strip()[:400]
            if not texto:
                return self._json(400, {"error": "texto vazio"})
            dial = discagem(str(data.get("to", "")))
        except ValueError as e:
            return self._json(400, {"error": str(e)})
        estado = gateway_state()
        if estado != "online":
            return self._json(503, {"error": f"O gateway GSM não está conectado ({estado})"})
        id_ = str(uuid.uuid4())
        try:
            fila.put_nowait({"id": id_, "dial": dial, "text": texto})
        except queue.Full:
            return self._json(429, {"error": "Muitas ligações na fila, tente de novo em instantes"})
        ultimas[id_] = {"status": "na fila"}
        self._json(202, {"ok": True, "id": id_, "status": "na fila", "fila": fila.qsize()})


if __name__ == "__main__":
    os.makedirs(SOUNDS, exist_ok=True)
    threading.Thread(target=trabalhador, daemon=True).start()
    log("ouvindo na porta 8080")
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
