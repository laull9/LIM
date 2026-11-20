"""Exercise the proposed log constraints on a real file in WAL mode."""

from contextlib import closing
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import unittest

SCHEMA = Path(__file__).with_name("event_log.sql")
ROOM = bytes.fromhex("00000000000040008000000000000001")
DEVICE = bytes.fromhex("00000000000040008000000000000002")
KEY = bytes.fromhex("00000000000040008000000000000003")
INSERT = """
    INSERT INTO event(conversation_id, seq, profile, device_id, client_message_id,
                      kind, content_type, payload)
    VALUES (?, ?, 'host', ?, ?, 'message', 'text/plain', ?)
"""


class EventLogTest(unittest.TestCase):
    def setUp(self):
        directory = self.enterContext(TemporaryDirectory())
        self.path = Path(directory) / "lim.db"
        self.db = self.connect()
        self.assertEqual(self.db.execute("PRAGMA journal_mode=WAL").fetchone(), ("wal",))
        self.db.executescript(SCHEMA.read_text(encoding="utf-8"))
        self.db.execute("INSERT INTO conversation(id, profile) VALUES (?, 'host')", (ROOM,))

    def connect(self):
        db = self.enterContext(closing(sqlite3.connect(self.path, isolation_level=None, timeout=0)))
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA synchronous=FULL")
        return db

    def append(self, seq, key=KEY, payload=b"hello"):
        self.db.execute(INSERT, (ROOM, seq, DEVICE, key, payload))

    def test_rollback_and_lost_ack(self):
        self.db.execute("BEGIN IMMEDIATE")
        self.append(1)
        self.db.rollback()
        self.append(1)
        other = self.connect()
        receipt = other.execute(
            "SELECT seq, payload FROM event WHERE conversation_id=? AND device_id=? "
            "AND client_message_id=?", (ROOM, DEVICE, KEY)
        ).fetchone()
        self.assertEqual(receipt, (1, b"hello"))
        with self.assertRaises(sqlite3.IntegrityError):
            self.append(2, payload=b"different")
        self.assertEqual(other.execute("SELECT last_seq FROM conversation").fetchone(), (1,))

    def test_writer_contention_and_snapshot(self):
        other = self.connect()
        self.db.execute("BEGIN IMMEDIATE")
        self.append(1)
        with self.assertRaises(sqlite3.OperationalError) as refused:
            other.execute("BEGIN IMMEDIATE")
        self.assertEqual(refused.exception.sqlite_errorcode, sqlite3.SQLITE_BUSY)
        self.assertEqual(other.execute("SELECT count(*) FROM event").fetchone(), (0,))
        self.db.commit()
        other.execute("BEGIN")
        self.assertEqual(other.execute("SELECT last_seq FROM conversation").fetchone(), (1,))
        self.append(2, DEVICE)
        self.assertEqual(other.execute("SELECT seq FROM event ORDER BY seq").fetchall(), [(1,)])
        other.commit()
        self.assertEqual(other.execute("SELECT last_seq FROM conversation").fetchone(), (2,))

    def test_sequence_profile_tombstone_and_size(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.append(2)
        with self.assertRaises(sqlite3.IntegrityError):
            self.append(1, payload=b"x" * 65537)
        with self.assertRaises(sqlite3.IntegrityError):
            self.append(1, payload=None)
        self.append(1)
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE conversation SET profile='mls'")
        self.db.execute("INSERT INTO conversation(id) VALUES (?)", (DEVICE,))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(INSERT, (DEVICE, 1, DEVICE, KEY, b"host payload"))
        self.db.execute("UPDATE event SET payload=NULL")
        with self.assertRaises(sqlite3.IntegrityError):
            self.append(2)
        self.assertEqual(self.db.execute("SELECT seq, payload FROM event").fetchone(), (1, None))


if __name__ == "__main__":
    unittest.main()
