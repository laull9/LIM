"""Exercise the server with real HTTP clients and disposable databases."""

import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import hashlib
import http.client
import json
import os
import selectors
import subprocess
import struct
from threading import Event
import uuid


def uid(n):
    return str(uuid.UUID(int=n, version=4))


GENERATION = uid(1)
ROOM = uid(2)
KEY = uid(3)
ALICE = uid(10)
BOB = uid(20)
TOKENS = {"operator": "12" * 32, "alice": "34" * 32, "bob": "56" * 32}


def digest(name):
    return hashlib.sha256(TOKENS[name].encode()).hexdigest()


@contextmanager
def running_server(test, config, env):
    log = config.with_suffix(".log")
    with log.open("w+") as output:
        with subprocess.Popen([test, "--config", config], env=env, text=True,
                              stdout=subprocess.PIPE, stderr=output) as process:
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(process.stdout, selectors.EVENT_READ)
                    if not selector.select(15):
                        raise RuntimeError("server did not announce readiness")
                expected = "listening 127.0.0.1:"
                line = process.stdout.readline()
                assert line.startswith(expected), line
                yield int(line.removeprefix(expected))
                process.terminate()
                exit_code = process.wait(timeout=10)
                assert exit_code == 0, f"lim-server exited with {exit_code}"
            except BaseException:
                output.seek(0)
                print(output.read(), flush=True)
                raise
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)


def call(method, params=None, request_id="test"):
    request = {"jsonrpc": "2.0", "id": request_id, "method": method}
    if params is not None:
        request["params"] = params
    return request


class Client:
    def __init__(self, port):
        self.connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)

    def close(self):
        self.connection.close()

    def request(self, method, path, body=None, headers=None):
        self.connection.request(method, path, body, headers or {})
        response = self.connection.getresponse()
        self.last_headers = response.headers
        return response.status, response.read()

    def raw(self, body, actor=None):
        headers = {"Content-Type": "application/json"}
        if actor:
            headers["Authorization"] = f"Bearer {TOKENS[actor]}"
        code, data = self.request("POST", "/rpc", body, headers)
        assert code in (200, 204), (code, data)
        if code == 204:
            assert data == b""
            return None
        return json.loads(data)

    def rpc(self, request, actor=None):
        return self.raw(json.dumps(request, separators=(",", ":")).encode(), actor)


def error(response, code, name=None):
    assert response["error"]["code"] == code, response
    assert response["jsonrpc"] == "2.0" and "result" not in response, response
    if name:
        assert response["error"]["data"]["name"] == name, response


def server_config(directory, backend, env=None, conninfo=None):
    config = directory / "lim-server.json"
    config.write_text(json.dumps({
        "port": 0,
        "generation": GENERATION,
        "storage": {"backend": backend, "file": "server.db"},
        "operator_token_sha256": digest("operator"),
        "devices": [
            {"account": uid(11), "device": ALICE, "credential": uid(12),
             "token_sha256": digest("alice")},
            {"account": uid(21), "device": BOB, "credential": uid(22),
             "token_sha256": digest("bob")},
        ],
    }), encoding="utf-8")
    env = dict(os.environ if env is None else env)
    if conninfo:
        env["LIM_SERVER_PG"] = conninfo
    return config, env


def binary_header(room, key, content_type="application/octet-stream"):
    return {"v": 1, "type": "message.send", "request_id": "wire-1",
            "recovery_generation": GENERATION, "conversation_id": room,
            "client_message_id": key, "profile": "host", "content_type": content_type}


def pack_record(header, payload):
    encoded = json.dumps(header, separators=(",", ":")).encode()
    return struct.pack("!I", len(encoded)) + encoded + payload


def unpack_page(body):
    result = []
    offset = 0
    while offset < len(body):
        size, header = struct.unpack_from("!II", body, offset)
        end = offset + 4 + size
        start = offset + 8
        assert start + header <= end <= len(body)
        result.append((json.loads(body[start:start + header]), body[start + header:end]))
        offset = end
    return result


def verify_wire(client, port):
    room = uid(901)
    key = uid(902)
    payload = b"\x00\xffraw\x00"
    common = {"generation": GENERATION, "conversation_id": room}
    assert client.rpc(call("conversation.create", {**common, "profile": "host"}),
                      "operator")["result"]["ok"]
    for who in (ALICE, BOB):
        args = {**common, "device_id": who, "active": True}
        assert client.rpc(call("conversation.set_member", args), "operator")["result"]["ok"]
    route = f"/v1/conversations/{room}"
    headers = {"Authorization": f"Bearer {TOKENS['alice']}", "LIM-Generation": GENERATION}
    sender = {**headers, "Content-Type": "application/vnd.lim.record"}
    listener = {**headers, "Authorization": f"Bearer {TOKENS['bob']}"}
    status, empty = client.request("GET", f"{route}/events?after_seq=0", headers=listener)
    assert status == 200 and empty == b""
    assert client.last_headers["LIM-Generation"] == GENERATION
    assert client.last_headers["LIM-Up-To"] == "0"
    assert client.last_headers["Content-Type"] == "application/vnd.lim.events"
    assert client.request("GET", f"{route}/events?after_seq=01", headers=listener)[0] == 400
    assert client.request("GET", f"{route}/events?after_seq=0",
                          headers={"LIM-Generation": GENERATION})[0] == 401

    bad_text = pack_record(binary_header(room, key, "text/plain"), b"\xff")
    assert client.request("POST", f"{route}/messages", bad_text, sender)[0] == 400
    wrong_room = pack_record(binary_header(ROOM, key), payload)
    assert client.request("POST", f"{route}/messages", wrong_room, sender)[0] == 400
    assert client.request("POST", f"{route}/messages", b"\x00", sender)[0] == 400
    oversized = pack_record(binary_header(room, key), b"x" * 65537)
    assert client.request("POST", f"{route}/messages", oversized, sender)[0] == 413
    waiter = Client(port)
    requested = Event()

    def wait_for_change(after):
        waiter.connection.request("GET", f"{route}/wait?after_seq={after}", headers=listener)
        requested.set()
        reply = waiter.connection.getresponse()
        return reply.status, json.loads(reply.read())

    try:
        with ThreadPoolExecutor(max_workers=1) as workers:
            waiting = workers.submit(wait_for_change, 0)
            assert requested.wait(2)
            assert client.request("GET", "/health/live")[0] == 200
            assert not waiting.done()
            send = pack_record(binary_header(room, key), payload)
            status, receipt = client.request("POST", f"{route}/messages", send, sender)
            assert status == 200, (status, receipt)
            assert json.loads(receipt) == {
                "v": 1, "type": "message.accepted", "request_id": "wire-1",
                "recovery_generation": GENERATION, "conversation_id": room,
                "conversation_seq": "1", "replayed": False,
            }
            status, hint = waiting.result(timeout=4)
            assert status == 200 and hint["up_to"] == "1" and hint["type"] == "sync.hint"
    finally:
        waiter.close()

    replay = call("message.send", {**common, "client_message_id": key,
                                  "content_type": "application/octet-stream",
                                  "payload_base64": base64.b64encode(payload).decode()})
    assert client.rpc(replay, "alice")["result"] == {"seq": "1", "replayed": True}
    status, page = client.request("GET", f"{route}/events?after_seq=0&up_to=1", headers=listener)
    assert status == 200, (status, page)
    [(header, body)] = unpack_page(page)
    assert header["conversation_seq"] == "1" and header["device_id"] == ALICE
    assert header["client_message_id"] == key and body == payload

    requested.clear()
    try:
        with ThreadPoolExecutor(max_workers=1) as workers:
            waiting = workers.submit(wait_for_change, 1)
            assert requested.wait(2)
            assert client.request("GET", "/health/live")[0] == 200
            assert not waiting.done()
            assert client.rpc(call("conversation.set_member", {**common, "device_id": BOB,
                                                                "active": False}),
                              "operator")["result"]["ok"]
            status, denied = waiting.result(timeout=4)
            assert status == 404 and denied["code"] == "not_found_or_forbidden"
    finally:
        waiter.close()
    assert client.rpc(call("conversation.expire", {**common, "through": "1"}),
                      "operator")["result"]["ok"]
    status, expired = client.request("GET", f"{route}/wait?after_seq=0", headers=headers)
    assert status == 410 and json.loads(expired)["sequence"] == "1"
    client.connection.timeout = 7
    client.close()
    status, quiet = client.request("GET", f"{route}/wait?after_seq=1", headers=headers)
    assert status == 204 and quiet == b"" and client.last_headers["LIM-Up-To"] == "1"


def run_server(test, directory, backend, env=None, conninfo=None):
    config, env = server_config(directory, backend, env, conninfo)
    common = {"generation": GENERATION, "conversation_id": ROOM}
    message = call("message.send", {**common, "client_message_id": KEY,
                                  "content_type": "text/plain", "text": "你好"})
    history = call("conversation.events", {**common, "after": "0"})

    with running_server(test, config, env) as port:
        client = Client(port)
        try:
            assert client.request("GET", "/health/live")[0] == 200
            assert client.request("GET", "/health/ready")[0] == 200
            assert client.request("GET", "/rpc")[0] == 405
            assert client.request("POST", "/rpc", b"text")[0] == 415
            assert client.request("POST", "/rpc", headers={"Content-Type": "application/json",
                                                           "Content-Length": "524289"})[0] == 400
            # Cinatra closes the transport after rejecting an oversized request.
            client.close()
            error(client.raw(b"{"), -32700)
            error(client.raw(b'{"jsonrpc":"2.0","method":"session.info","method":"bad"}'), -32700)
            error(client.rpc([]), -32600)
            error(client.rpc({"jsonrpc": "1.0", "method": "test", "id": True}), -32600)
            error(client.rpc(call("session.info")), -32001)
            assert client.rpc(call("session.info", request_id=None), "alice") == {
                "jsonrpc": "2.0", "id": None,
                "result": {"account": uid(11), "device": ALICE, "generation": GENERATION},
            }

            create = call("conversation.create", {**common, "profile": "host"})
            error(client.rpc(create, "alice"), -32003)
            error(client.rpc(call("conversation.create", {**common, "profile": "mls"}),
                             "operator"), -32009, "profile_mismatch")
            assert client.rpc(create, "operator")["result"]["ok"]
            error(client.rpc(history, "bob"), -32004, "not_found_or_forbidden")
            for who in (ALICE, BOB):
                args = {**common, "device_id": who, "active": True}
                assert client.rpc(call("conversation.set_member", args), "operator")["result"]["ok"]
            listing = client.rpc(call("conversation.list", {"generation": GENERATION}), "bob")
            assert listing["result"] == {
                "conversations": [{"conversation_id": ROOM, "after": "0",
                                   "last_seq": "0", "profile": "host"}], "next_after": None,
            }
            assert client.rpc(message, "alice")["result"] == {"seq": "1", "replayed": False}
            assert client.rpc(message, "alice")["result"] == {"seq": "1", "replayed": True}
            modified = {**message, "params": {**message["params"], "text": "changed"}}
            error(client.rpc(modified, "alice"), -32009, "idempotency_conflict")
            error(client.rpc(call("conversation.events", {**common, "after": "01"}), "bob"), -32602)

            binary = call("message.send", {**common, "client_message_id": KEY,
                                          "content_type": "application/octet-stream",
                                          "payload_base64": "AP8="})
            del binary["id"]
            assert client.rpc([binary], "bob") is None
            requests = [history, {"jsonrpc": "2.0", "method": "unknown"}, 0,
                        call("unknown", request_id=42)]
            page, invalid, unknown = client.rpc(requests, "alice")
            error(invalid, -32600)
            error(unknown, -32601)
            assert unknown["id"] == 42 and invalid["id"] is None
            assert [base64.b64decode(event["payload_base64"]) for event in
                    page["result"]["events"]] == ["你好".encode(), b"\0\xff"]
            assert page["result"]["up_to"] == page["result"]["next_after"] == "2"
            assert client.rpc(call("conversation.expire", {**common, "through": "1"}),
                              "operator")["result"]["ok"]
            error(client.rpc(message, "alice"), -32009, "idempotency_expired")
            error(client.rpc(history, "alice"), -32010, "cursor_expired")
            verify_wire(client, port)
            assert client.rpc(call("device.revoke", {"generation": GENERATION, "device_id": BOB}),
                              "operator")["result"]["ok"]
        finally:
            client.close()

    pending = None
    try:
        with running_server(test, config, env) as port:
            client = Client(port)
            try:
                error(client.rpc(call("session.info"), "bob"), -32001, "device_revoked")
                page = client.rpc(call("conversation.events", {**common, "after": "1"}), "alice")
                assert page["result"]["events"][0]["payload_base64"] == "AP8="
                assert page["result"]["next_after"] == "2"
                pending = Client(port)
                pending.connection.request(
                    "GET", f"/v1/conversations/{ROOM}/wait?after_seq=2",
                    headers={"Authorization": f"Bearer {TOKENS['alice']}",
                             "LIM-Generation": GENERATION})
                assert client.request("GET", "/health/live")[0] == 200
            finally:
                client.close()
    finally:
        if pending:
            pending.close()

    print("HTTP RPC, binary events, wait, durable replay and restart verified", flush=True)
