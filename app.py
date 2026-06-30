import sqlite3
from flask import Flask, render_template, request, redirect, url_for, flash, jsonify, abort
import db

app = Flask(__name__)
app.secret_key = "timeline-maker-dev-key"

db.init_db()


@app.route("/")
def index():
    timelines = db.get_timelines()
    return render_template("index.html", timelines=timelines)


@app.route("/create", methods=["POST"])
def create():
    name = request.form.get("name", "").strip()
    if not name:
        flash("A timeline name is required.", "error")
        return redirect(url_for("index"))
    try:
        tid = db.create_timeline(name)
    except sqlite3.IntegrityError:
        flash(f'A timeline named "{name}" already exists.', "error")
        return redirect(url_for("index"))
    return redirect(url_for("timeline_editor", timeline_id=tid))


@app.route("/timeline/<int:timeline_id>")
def timeline_editor(timeline_id):
    timeline = db.get_timeline(timeline_id)
    if not timeline:
        abort(404)
    return render_template("timeline.html", timeline=timeline)


@app.route("/timeline/<int:timeline_id>/rename", methods=["POST"])
def rename_timeline(timeline_id):
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or request.form.get("name", "")).strip()
    if not name:
        return jsonify({"error": "Name is required"}), 400
    if not db.get_timeline(timeline_id):
        return jsonify({"error": "Not found"}), 404
    try:
        db.rename_timeline(timeline_id, name)
    except sqlite3.IntegrityError:
        return jsonify({"error": f'A timeline named "{name}" already exists.'}), 409
    return jsonify({"ok": True})


@app.route("/timeline/<int:timeline_id>", methods=["DELETE"])
def delete_timeline(timeline_id):
    if not db.get_timeline(timeline_id):
        return jsonify({"error": "Not found"}), 404
    db.delete_timeline(timeline_id)
    return jsonify({"ok": True})


@app.route("/api/timeline/<int:timeline_id>/events")
def get_events(timeline_id):
    if not db.get_timeline(timeline_id):
        return jsonify({"error": "Not found"}), 404
    return jsonify(db.get_events(timeline_id))


@app.route("/api/timeline/<int:timeline_id>/events", methods=["POST"])
def create_event(timeline_id):
    if not db.get_timeline(timeline_id):
        return jsonify({"error": "Not found"}), 404
    data = request.get_json(silent=True) or {}
    title = (data.get("title") or "").strip()
    etype = data.get("type", "point")
    start_date = data.get("start_date", "")
    end_date = data.get("end_date") or None
    color = data.get("color", "#1d4ed8")
    description = data.get("description", "")

    if not title or not start_date or etype not in ("point", "period"):
        return jsonify({"error": "title, start_date and valid type are required"}), 400
    if etype == "period" and not end_date:
        return jsonify({"error": "end_date is required for period events"}), 400

    eid = db.create_event(timeline_id, title, description, etype, start_date, end_date, color)
    return jsonify({"ok": True, "id": eid}), 201


@app.route("/api/event/<int:event_id>", methods=["PUT"])
def update_event(event_id):
    if not db.get_event(event_id):
        return jsonify({"error": "Not found"}), 404
    data = request.get_json(silent=True) or {}
    title = (data.get("title") or "").strip()
    etype = data.get("type", "point")
    start_date = data.get("start_date", "")
    end_date = data.get("end_date") or None
    color = data.get("color", "#1d4ed8")
    description = data.get("description", "")

    if not title or not start_date or etype not in ("point", "period"):
        return jsonify({"error": "title, start_date and valid type are required"}), 400
    if etype == "period" and not end_date:
        return jsonify({"error": "end_date is required for period events"}), 400

    db.update_event(event_id, title, description, etype, start_date, end_date, color)
    return jsonify({"ok": True})


@app.route("/api/event/<int:event_id>", methods=["DELETE"])
def delete_event(event_id):
    if not db.get_event(event_id):
        return jsonify({"error": "Not found"}), 404
    db.delete_event(event_id)
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(debug=True)
