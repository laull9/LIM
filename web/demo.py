"""Start the Web demo with a fresh SQLite-backed lim-server on loopback."""

import argparse
from contextlib import ExitStack, contextmanager
from hashlib import sha256
from http.client import HTTPConnection
import json
import os
from pathlib import Path
import secrets
import selectors
from subprocess import PIPE, Popen, TimeoutExpired
from tempfile import TemporaryDirectory
from uuid import uuid4


WEB_ROOT = Path(__file__).resolve().parent
READY_PREFIX = "listening 127.0.0.1:"


@contextmanager
def process(args, **options):
    with Popen(args, **options) as child:
        try:
            yield child
        finally:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except TimeoutExpired:
                    child.kill()
                    child.wait()


def token_digest(token):
    return sha256(token.encode("ascii")).hexdigest()


def server_port(child):
    with selectors.DefaultSelector() as selector:
        selector.register(child.stdout, selectors.EVENT_READ)
        if not selector.select(15):
            raise RuntimeError("lim-server 没有在 15 秒内就绪。")
        line = child.stdout.readline().strip()
    if not line.startswith(READY_PREFIX):
        raise RuntimeError(f"lim-server 启动失败（状态 {child.poll()}）。")
    return int(line.removeprefix(READY_PREFIX))


def rpc(port, token, method, params):
    call_id = str(uuid4())
    payload = json.dumps({"jsonrpc": "2.0", "id": call_id, "method": method, "params": params})
    connection = HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.request("POST", "/rpc", payload, {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        })
        response = connection.getresponse()
        body = json.loads(response.read())
    finally:
        connection.close()
    if response.status != 200 or not isinstance(body, dict) or body.get("id") != call_id or "result" not in body:
        raise RuntimeError(f"{method} 调用失败，HTTP {response.status}。")
    return body["result"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("server", type=Path, help="xmake 构建出来的 lim-server 路径")
    parser.add_argument("--web-port", type=int, default=5173)
    args = parser.parse_args()
    server = args.server.resolve()
    vite = WEB_ROOT / "node_modules" / "vite" / "bin" / "vite.js"
    if not server.is_file():
        parser.error(f"找不到 lim-server：{server}")
    if not vite.is_file():
        parser.error("请先在 web/ 执行 pnpm install --frozen-lockfile。")
    if not 1 <= args.web_port <= 65535:
        parser.error("--web-port 应在 1 到 65535 之间。")

    operator = secrets.token_hex(32)
    generation = str(uuid4())
    room = str(uuid4())
    tokens = {name: secrets.token_hex(32) for name in ("Alice", "Bob")}
    devices = {
        name: {
            "account": str(uuid4()), "device": str(uuid4()), "credential": str(uuid4()),
            "token_sha256": token_digest(token),
        }
        for name, token in tokens.items()
    }

    with ExitStack() as stack:
        directory = Path(stack.enter_context(TemporaryDirectory(prefix="lim-web-")))
        config = directory / "lim.json"
        config.write_text(json.dumps({
            "port": 0, "generation": generation,
            "storage": {"backend": "sqlite", "file": "demo.db"},
            "operator_token_sha256": token_digest(operator),
            "devices": list(devices.values()),
        }), encoding="utf-8")

        lim_server = stack.enter_context(process([server, "--config", config], stdout=PIPE, text=True))
        port = server_port(lim_server)
        room_params = {"generation": generation, "conversation_id": room}
        rpc(port, operator, "conversation.create", {**room_params, "profile": "host"})
        for device in devices.values():
            rpc(port, operator, "conversation.set_member", {
                **room_params, "device_id": device["device"], "active": True,
            })
        for name, message in (
            ("Alice", "你好，我是 Alice。这条消息已经写入 LIM 服务端。"),
            ("Bob", "我是 Bob，收到！可以在两个标签页各连接一台设备，试试实时收发。"),
        ):
            rpc(port, tokens[name], "message.send", {
                **room_params, "client_message_id": str(uuid4()),
                "content_type": "text/plain", "text": message,
            })

        print(f"Web 客户端  http://127.0.0.1:{args.web_port}/", flush=True)
        for name, token in tokens.items():
            print(f"{name} 设备令牌  {token}", flush=True)
        frontend = stack.enter_context(process(
            ["node", vite, "--host", "127.0.0.1", "--port", str(args.web_port), "--strictPort"],
            cwd=WEB_ROOT, env={**os.environ, "LIM_SERVER_URL": f"http://127.0.0.1:{port}"},
        ))
        return frontend.wait()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130) from None
    except (OSError, RuntimeError) as error:
        raise SystemExit(str(error)) from None
