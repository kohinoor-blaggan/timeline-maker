import os
import sqlite3
from datetime import datetime, timezone

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
    color       TEXT NOT NULL DEFAULT '#1d4ed8',
    -- Period events with no fixed end. end_date stays NULL when this is set.
    ongoing     INTEGER NOT NULL DEFAULT 0,
    -- Manual row pin for period bars. NULL = auto-placed by the renderer.
    lane        INTEGER
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
        _migrate(conn)


def _migrate(conn):
    """Bring an already-created events table up to the current schema.

    CREATE TABLE IF NOT EXISTS is a no-op on existing databases, so new columns
    have to be added explicitly. Each step is guarded so this is idempotent.
    """
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(events)")}
    if "ongoing" not in cols:
        conn.execute("ALTER TABLE events ADD COLUMN ongoing INTEGER NOT NULL DEFAULT 0")
    if "lane" not in cols:
        conn.execute("ALTER TABLE events ADD COLUMN lane INTEGER")


def today_str():
    """Today in UTC as YYYY-MM-DD — the single definition of "now" for the
    end date of ongoing events, matching how dates are stored elsewhere."""
    return datetime.now(timezone.utc).strftime('%Y-%m-%d')


def refresh_ongoing_end_dates():
    """Stamp every ongoing event's end_date with today.

    Runs once at start-up, so the stored end date is current as of the last
    relaunch. Redeploying (or restarting the container) is what advances it —
    nothing refreshes it while the app is running.
    """
    with get_conn() as conn:
        cur = conn.execute(
            "UPDATE events SET end_date = ? WHERE ongoing = 1", (today_str(),)
        )
        return cur.rowcount


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
                   MIN(substr(e.start_date, 1, 4))             AS first_year,
                   -- An ongoing period runs to today, so it extends the range.
                   MAX(substr(CASE WHEN e.ongoing = 1
                                   THEN strftime('%Y-%m-%d', 'now')
                                   ELSE COALESCE(e.end_date, e.start_date)
                              END, 1, 4))                      AS last_year
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


def create_event(timeline_id, title, description, etype, start_date, end_date, color, ongoing=0):
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO events (timeline_id, title, description, type, start_date, end_date, color, ongoing) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (timeline_id, title, description, etype, start_date, end_date, color, ongoing)
        )
        return cur.lastrowid


def update_event(event_id, title, description, etype, start_date, end_date, color, ongoing=0):
    with get_conn() as conn:
        cur = conn.execute(
            "UPDATE events SET title=?, description=?, type=?, start_date=?, end_date=?, color=?, ongoing=? "
            "WHERE id=?",
            (title, description, etype, start_date, end_date, color, ongoing, event_id)
        )
        return cur.rowcount


def delete_event(event_id):
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM events WHERE id=?", (event_id,))
        return cur.rowcount


def set_event_lane(event_id, lane):
    """Pin a period to a row (lane), or pass None to return it to auto layout."""
    with get_conn() as conn:
        cur = conn.execute("UPDATE events SET lane=? WHERE id=?", (lane, event_id))
        return cur.rowcount


def clear_lanes(timeline_id):
    """Release every period in a timeline back to automatic placement."""
    with get_conn() as conn:
        cur = conn.execute("UPDATE events SET lane=NULL WHERE timeline_id=?", (timeline_id,))
        return cur.rowcount
