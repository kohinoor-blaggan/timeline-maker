import os
import sqlite3

_PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))

# Overridden in Docker to point at the mounted /data volume so the database
# survives container rebuilds.
DB_PATH = os.getenv('TIMELINE_DB', os.path.join(_PROJECT_ROOT, 'data', 'timelines.db'))

SCHEMA = """
CREATE TABLE IF NOT EXISTS timelines (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timeline_id INTEGER NOT NULL REFERENCES timelines(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    description TEXT DEFAULT '',
    type        TEXT NOT NULL CHECK(type IN ('point', 'period')),
    start_date  TEXT NOT NULL,
    end_date    TEXT,
    color       TEXT NOT NULL DEFAULT '#1d4ed8'
);
"""


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    # The data dir may not exist yet on a fresh checkout or a fresh volume.
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with get_conn() as conn:
        conn.executescript(SCHEMA)


def _row(r):
    return dict(r) if r else None


def _rows(rs):
    return [dict(r) for r in rs]


def get_timelines():
    """Timelines sorted by name, each annotated with its event count and the
    span of years its events cover (first_year/last_year are None if empty)."""
    with get_conn() as conn:
        return _rows(conn.execute("""
            SELECT t.*,
                   COUNT(e.id)                                  AS event_count,
                   MIN(substr(e.start_date, 1, 4))              AS first_year,
                   MAX(substr(COALESCE(e.end_date, e.start_date), 1, 4)) AS last_year
            FROM timelines t
            LEFT JOIN events e ON e.timeline_id = t.id
            GROUP BY t.id
            ORDER BY t.name COLLATE NOCASE
        """).fetchall())


def get_timeline(tid):
    with get_conn() as conn:
        return _row(conn.execute("SELECT * FROM timelines WHERE id=?", (tid,)).fetchone())


def create_timeline(name):
    with get_conn() as conn:
        cur = conn.execute("INSERT INTO timelines (name) VALUES (?)", (name,))
        return cur.lastrowid


def rename_timeline(tid, name):
    with get_conn() as conn:
        cur = conn.execute("UPDATE timelines SET name=? WHERE id=?", (name, tid))
        return cur.rowcount


def delete_timeline(tid):
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM timelines WHERE id=?", (tid,))
        return cur.rowcount


def get_events(timeline_id):
    with get_conn() as conn:
        return _rows(conn.execute(
            "SELECT * FROM events WHERE timeline_id=? ORDER BY start_date",
            (timeline_id,)
        ).fetchall())


def get_event(event_id):
    with get_conn() as conn:
        return _row(conn.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone())


def create_event(timeline_id, title, description, etype, start_date, end_date, color):
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO events (timeline_id, title, description, type, start_date, end_date, color) "
            "VALUES (?,?,?,?,?,?,?)",
            (timeline_id, title, description, etype, start_date, end_date, color)
        )
        return cur.lastrowid


def update_event(event_id, title, description, etype, start_date, end_date, color):
    with get_conn() as conn:
        cur = conn.execute(
            "UPDATE events SET title=?, description=?, type=?, start_date=?, end_date=?, color=? "
            "WHERE id=?",
            (title, description, etype, start_date, end_date, color, event_id)
        )
        return cur.rowcount


def delete_event(event_id):
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM events WHERE id=?", (event_id,))
        return cur.rowcount
