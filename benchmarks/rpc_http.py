"""Release HTTP RPC baseline on an isolated database, persistent loopback client."""

import argparse
import base64
import json
from pathlib import Path
import statistics
import sys
from tempfile import TemporaryDirectory
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests" / "integration"))
from run_server import (ALICE, GENERATION, ROOM, TOKENS, Client, call, running_server, server_config, uid,
                        unpack_page)
from run_storage import postgres_database


def result(client, method, fields, actor="alice", request_id="bench"):
    reply = client.rpc(call(method, fields, request_id), actor)
    if "result" not in reply:
        raise RuntimeError(str(reply))
    return reply["result"]


def measure(operation, iterations):
    elapsed = []
    for i in range(iterations):
        start = time.perf_counter_ns()
        operation(i)
        elapsed.append((time.perf_counter_ns() - start) / 1_000_000)
    elapsed.sort()
    return {"n": iterations, "p50_ms": round(statistics.median(elapsed), 3),
            "p99_ms": round(elapsed[(99 * iterations + 99) // 100 - 1], 3)}


def run_sample(executable, directory, backend, iterations, binary, env=None, conninfo=None):
    config, env = server_config(directory, backend, env, conninfo)
    with running_server(executable, config, env) as port:
        client = Client(port)
        try:
            room = {"generation": GENERATION, "conversation_id": ROOM}
            result(client, "conversation.create", {**room, "profile": "host"}, "operator")
            result(client, "conversation.set_member", {**room, "device_id": ALICE, "active": True},
                   "operator")

            def send(base, i, text):
                return result(client, "message.send", {
                    **room, "client_message_id": uid(base + i),
                    "content_type": "text/plain", "text": text,
                })

            for i in range(32):
                send(10000, i, "x" * 1024)
            writes = measure(lambda i: send(20000, i, "x" * 1024), iterations)
            head = str(32 + iterations)
            empty = measure(lambda _: result(client, "conversation.events", {**room, "after": head}),
                            iterations)
            for i in range(28):
                send(30000, i, "y" * 65536)

            def read_large(_):
                page = result(client, "conversation.events", {**room, "after": head})
                assert len(page["events"]) >= 8
                assert len(base64.b64decode(page["events"][0]["payload_base64"])) == 65536

            for _ in range(4):
                read_large(0)
            large = measure(read_large, max(20, iterations // 3))
            timings = {"backend": backend, "send_1k": writes,
                       "empty_page": empty, "large_page": large}
            if binary:
                fixed = str(int(head) + 16)
                args = {**room, "after": head, "up_to": fixed}
                path = f"/v1/conversations/{ROOM}/events?after_seq={head}&up_to={fixed}"
                headers = {"Authorization": f"Bearer {TOKENS['alice']}",
                           "LIM-Generation": GENERATION}

                def rpc16(_):
                    page = result(client, "conversation.events", args)
                    payloads = [base64.b64decode(event["payload_base64"]) for event in page["events"]]
                    assert len(payloads) == 16 and len(payloads[-1]) == 65536

                def binary16(_):
                    status, page = client.request("GET", path, headers=headers)
                    assert status == 200, (status, page)
                    rows = unpack_page(page)
                    assert len(rows) == 16 and len(rows[-1][1]) == 65536

                rpc16(0)
                binary16(0)
                count = max(20, iterations // 3)
                timings["rpc_16x64k"] = measure(rpc16, count)
                timings["binary_16x64k"] = measure(binary16, count)
            return timings
        finally:
            client.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("server", type=lambda p: Path(p).resolve())
    parser.add_argument("--backend", choices=("sqlite", "postgresql"), required=True)
    parser.add_argument("--iterations", type=int, default=180)
    parser.add_argument("--repeat", type=int, default=3)
    parser.add_argument("--binary", action="store_true", help="compare both encodings for 16 events")
    args = parser.parse_args()
    if not (20 <= args.iterations < 10000 and 1 <= args.repeat <= 10):
        parser.error("iterations must be in [20, 9999] and repeat in [1, 10]")
    for _ in range(args.repeat):
        with TemporaryDirectory(prefix="lim-perf-", dir="/tmp") as workspace:
            directory = Path(workspace)
            if args.backend == "postgresql":
                with postgres_database(directory) as (env, conninfo, _):
                    sample = run_sample(args.server, directory, args.backend, args.iterations, args.binary,
                                        env, conninfo)
            else:
                sample = run_sample(args.server, directory, args.backend, args.iterations, args.binary)
            print(json.dumps(sample), flush=True)


if __name__ == "__main__":
    main()
