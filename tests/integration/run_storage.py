"""Run the storage contract and CLI demo in disposable local databases."""

import argparse
from contextlib import closing, contextmanager
import os
from pathlib import Path
import shlex
import sqlite3
import subprocess
from tempfile import TemporaryDirectory

from run_server import run_server, verify_recovery


def run(argv, **kwargs):
    subprocess.run(argv, check=True, timeout=60, **kwargs)


def run_contract(argv, execute_sql, install_fault, remove_fault, **kwargs):
    run(argv, **kwargs)
    print("transaction rollback, retry and schema version guard", flush=True)
    execute_sql(install_fault)
    run([*argv, "write-reject"], **kwargs)
    execute_sql(remove_fault)
    run([*argv, "write-retry"], **kwargs)
    execute_sql("UPDATE lim_metadata SET version = 999")
    run([*argv, "unknown-schema"], **kwargs)


def run_demo(argv, **kwargs):
    def expect(arguments, stdout="", stderr="", code=0):
        command = [*argv, *arguments]
        result = subprocess.run(command, capture_output=True, encoding="utf-8",
                                timeout=10, **kwargs)
        expected = (code, stdout, stderr)
        actual = (result.returncode, result.stdout, result.stderr)
        if actual != expected:
            raise AssertionError(f"{arguments!r}: expected {expected!r}, got {actual!r}")

    expect(["init"], "ready room=demo members=alice,bob\n")
    expect(["send", "alice", "1", "你好，Bob"], "accepted seq=1 replayed=false\n")
    expect(["read", "bob", "0"],
           'event seq=1 sender=alice text="你好，Bob"\npage up_to=1 next_after=1\n')
    expect(["send", "bob", "1", 'Hello "Alice"\n'],
           "accepted seq=2 replayed=false\n")
    expect(["init"], "ready room=demo members=alice,bob\n")
    expect(["send", "alice", "1", "你好，Bob"], "accepted seq=1 replayed=true\n")
    expect(["send", "alice", "1", "different"],
           stderr="lim_demo: idempotency_conflict\n", code=1)
    expect(["read", "alice", "0", "1"],
           'event seq=1 sender=alice text="你好，Bob"\npage up_to=1 next_after=1\n')
    expect(["read", "alice", "1"],
           r'event seq=2 sender=bob text="Hello \"Alice\"\u000a"' "\n"
           "page up_to=2 next_after=2\n")
    expect(["read", "bob", "2"], "page up_to=2 next_after=2\n")
    expect(["send", "bob", "0", "bad key"],
           stderr="lim_demo: use alice or bob and a valid decimal message key or cursor\n", code=2)
    print("CLI demo verified across independent process invocations", flush=True)


def run_sqlite(test, directory, mode):
    file = directory / "lim.db"
    if mode == "server":
        run_server(test, directory, "sqlite")
        recovery = directory / "recovery"
        recovery.mkdir()

        def backup(workspace):
            with closing(sqlite3.connect(workspace / "server.db")) as source:
                with closing(sqlite3.connect(workspace / "restored.db")) as restored:
                    source.backup(restored)

            def block_generation_change(enabled):
                sql = """
                    CREATE TRIGGER block_generation_change BEFORE UPDATE OF generation ON lim_metadata
                    BEGIN
                        SELECT RAISE(ABORT, 'test rejects a generation change');
                    END
                """ if enabled else "DROP TRIGGER block_generation_change"
                with closing(sqlite3.connect(workspace / "restored.db")) as db, db:
                    db.execute(sql)

            return None, block_generation_change

        verify_recovery(test, recovery, "sqlite", backup)
        return
    if mode == "demo":
        run_demo([test, "--sqlite", file])
        return

    def execute(sql):
        with closing(sqlite3.connect(file)) as db, db:
            db.execute(sql)

    run_contract([test, "sqlite", file], execute, """
        CREATE TRIGGER reject_head_update BEFORE UPDATE OF last_seq ON lim_conversation
        BEGIN
            SELECT RAISE(ABORT, 'fixture rejects room head update');
        END
        """, "DROP TRIGGER reject_head_update")


@contextmanager
def postgres_database(directory):
    env = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
    bindir = os.environ.get("LIM_PG_BINDIR")
    if not bindir:
        bindir = subprocess.check_output(["pg_config", "--bindir"], text=True, timeout=10).strip()
    initdb = Path(bindir) / "initdb"
    pg_ctl = Path(bindir) / "pg_ctl"
    psql = Path(bindir) / "psql"
    if not all(tool.is_file() for tool in (initdb, pg_ctl, psql)):
        raise RuntimeError("PostgreSQL server tools are required; set LIM_PG_BINDIR to their directory")
    data = directory / "data"
    log = directory / "postgresql.log"
    run([initdb, "-D", data, "--no-locale", "--encoding=UTF8",
         "--auth-local=trust", "--auth-host=reject", "--username=lim_fixture"], env=env,
        stdout=subprocess.DEVNULL)
    server_options = f"-c listen_addresses='' -k {shlex.quote(str(directory))}"
    try:
        run([pg_ctl, "-D", data, "-l", log, "-o", server_options, "-w", "-t", "15", "start"],
            env=env, stdout=subprocess.DEVNULL)
        env["PGHOST"] = str(directory)
        env["PGPORT"] = "5432"
        env["PATH"] = f"{initdb.parent}{os.pathsep}{env.get('PATH', os.defpath)}"

        def execute(sql, user="lim_app", database="lim_contract"):
            run([psql, "-Xq", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", database, "-c", sql],
                env=env)

        execute("CREATE ROLE lim_app LOGIN", "lim_fixture", "postgres")
        execute("CREATE DATABASE lim_contract OWNER lim_app", "lim_fixture", "postgres")
        yield env, "dbname=lim_contract user=lim_app", execute
    except (subprocess.SubprocessError, OSError, AssertionError):
        if log.exists():
            print(log.read_text(encoding="utf-8", errors="replace"), flush=True)
        raise
    finally:
        if (data / "postmaster.pid").exists():
            run([pg_ctl, "-D", data, "-m", "immediate", "-w", "-t", "15", "stop"],
                env=env, stdout=subprocess.DEVNULL)


def run_postgres(test, directory, mode):
    with postgres_database(directory) as (env, conninfo, execute):
        if mode == "server":
            run_server(test, directory, "postgresql", env, conninfo)
            execute("CREATE DATABASE lim_recovery OWNER lim_app", "lim_fixture", "postgres")

            def backup(workspace):
                archive = workspace / "snapshot.dump"
                run(["pg_dump", "-Fc", "-U", "lim_app", "-f", archive, "lim_recovery"], env=env)
                execute("CREATE DATABASE lim_restored OWNER lim_app", "lim_fixture", "postgres")
                run(["pg_restore", "--exit-on-error", "--no-owner", "-U", "lim_app",
                     "-d", "lim_restored", archive], env=env)

                def block_generation_change(enabled):
                    sql = """
                        CREATE FUNCTION block_generation_change() RETURNS trigger LANGUAGE plpgsql AS $$
                        BEGIN
                            RAISE EXCEPTION 'test rejects a generation change';
                        END;
                        $$;
                        CREATE TRIGGER block_generation_change BEFORE UPDATE OF generation ON lim_metadata
                        FOR EACH ROW EXECUTE FUNCTION block_generation_change();
                    """ if enabled else "DROP FUNCTION block_generation_change() CASCADE"
                    execute(sql, database="lim_restored")

                return "dbname=lim_restored user=lim_app", block_generation_change

            verify_recovery(test, directory, "postgresql", backup, env,
                            "dbname=lim_recovery user=lim_app")
            return
        if mode == "demo":
            env["LIM_DEMO_PG"] = conninfo
            run_demo([test, "--postgresql"], env=env)
            return
        run_contract([test, "postgresql", conninfo], execute, """
            CREATE FUNCTION reject_head_update() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                RAISE EXCEPTION 'fixture rejects room head update';
            END;
            $$;
            CREATE TRIGGER reject_head_update BEFORE UPDATE OF last_seq ON lim_conversation
            FOR EACH ROW EXECUTE FUNCTION reject_head_update();
            """, "DROP TRIGGER reject_head_update ON lim_conversation", env=env)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("backend", choices=("sqlite", "postgresql"))
    parser.add_argument("test", type=Path)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--demo", dest="mode", action="store_const", const="demo")
    modes.add_argument("--server", dest="mode", action="store_const", const="server")
    args = parser.parse_args()
    # Use a short path for PostgreSQL's UNIX-domain socket on macOS and Linux.
    with TemporaryDirectory(prefix="lim-test-", dir="/tmp") as workspace:
        directory = Path(workspace)
        if args.backend == "sqlite":
            run_sqlite(args.test, directory, args.mode)
        else:
            run_postgres(args.test, directory, args.mode)


if __name__ == "__main__":
    main()
