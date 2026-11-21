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
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    connection = HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.request("POST", "/rpc", payload, headers)
        response = connection.getresponse()
        body = json.loads(response.read())
    finally:
        connection.close()
    if response.status != 200 or not isinstance(body, dict) or body.get("id") != call_id or "result" not in body:
        detail = body.get("error", {}).get("message") if isinstance(body, dict) else body
        raise RuntimeError(f"{method} 调用失败，HTTP {response.status}：{detail}")
    return body["result"]


def register(port, username, display_name, password):
    return rpc(port, None, "account.register", {
        "username": username,
        "password": password,
        "display_name": display_name,
        "device_id": str(uuid4()),
        "device_name": f"Demo · {display_name}",
    })


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
    password = "lim-demo-pass"

    with ExitStack() as stack:
        directory = Path(stack.enter_context(TemporaryDirectory(prefix="lim-web-")))
        config = directory / "lim.json"
        config.write_text(json.dumps({
            "port": 0,
            "generation": generation,
            "storage": {"backend": "sqlite", "file": "demo.db"},
            "operator_token_sha256": token_digest(operator),
            "devices": [],
        }), encoding="utf-8")

        lim_server = stack.enter_context(process([server, "--config", config], stdout=PIPE, text=True))
        port = server_port(lim_server)
        alice = register(port, "alice", "爱丽丝", password)
        bob = register(port, "bob", "鲍勃", password)
        room = rpc(port, alice["access_token"], "conversation.start", {
            "generation": alice["generation"],
            "account_ids": [bob["account"]],
        })
        for auth, message in (
            (alice, "你好，我是 Alice。这条消息来自账号登录后的设备。"),
            (bob, "我是 Bob，收到！刷新页面或换一个浏览器上下文登录后还能继续。"),
        ):
            rpc(port, auth["access_token"], "message.send", {
                "generation": auth["generation"],
                "conversation_id": room["conversation_id"],
                "client_message_id": str(uuid4()),
                "content_type": "text/plain",
                "text": message,
            })

        print(f"Web 客户端  http://127.0.0.1:{args.web_port}/", flush=True)
        print("在两个独立浏览器上下文分别登录（普通标签页会共享刷新令牌）：", flush=True)
        print(f"Alice  用户名 alice  密码 {password}", flush=True)
        print(f"Bob    用户名 bob    密码 {password}", flush=True)
        print("登录后浏览器会自动登记设备，并继承账号已有的会话目录。", flush=True)
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
