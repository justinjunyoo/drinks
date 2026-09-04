import express from "express";
import { Firestore } from "@google-cloud/firestore";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Config ----
const PORT = process.env.PORT || 8080;
const GOAL = parseInt(process.env.DRINK_GOAL || "1000", 10);
// Optional gate for *creating* brand-new rooms. If set, adding the first user
// to a not-yet-existing room requires this key. Existing rooms are open to
// anyone who knows the room code (the shared secret). Leave unset for a party.
const CREATE_KEY = process.env.CREATE_KEY || "";
// Room codes: 3–40 chars, url/word safe. The code itself is the shared secret.
const ROOM_RE = /^[A-Za-z0-9_-]{3,40}$/;
// Cap the stored event log so one room's doc can never approach Firestore's 1MB limit.
const MAX_EVENTS = 20000;

const db = new Firestore(); // uses Application Default Credentials + GOOGLE_CLOUD_PROJECT

const app = express();
app.use(express.json({ limit: "16kb" }));

const roomRef = (room) => db.collection("rooms").doc(room);

function normalizeState(data) {
  const users = Array.isArray(data?.users) ? data.users : [];
  const events = Array.isArray(data?.events) ? data.events : [];
  const total = users.reduce((s, u) => s + (u.count || 0), 0);
  return { goal: data?.goal || GOAL, users, events, total };
}

function badRoom(res) {
  return res.status(400).json({ ok: false, error: "invalid_room" });
}

// ---- API ----

// Read current state for a room. Does not create the room.
app.get("/api/state", async (req, res) => {
  const room = req.query.room;
  if (!ROOM_RE.test(room || "")) return badRoom(res);
  try {
    const snap = await roomRef(room).get();
    if (!snap.exists) {
      return res.json({ ok: true, exists: false, state: normalizeState({}) });
    }
    res.json({ ok: true, exists: true, state: normalizeState(snap.data()) });
  } catch (e) {
    console.error("state error", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// Add a drinker. Creates the room if it doesn't exist (subject to CREATE_KEY).
app.post("/api/users", async (req, res) => {
  const { room, name, createKey } = req.body || {};
  if (!ROOM_RE.test(room || "")) return badRoom(res);
  const clean = String(name || "").trim().slice(0, 24);
  if (!clean) return res.status(400).json({ ok: false, error: "empty_name" });

  try {
    const out = await db.runTransaction(async (t) => {
      const ref = roomRef(room);
      const snap = await t.get(ref);
      if (!snap.exists) {
        if (CREATE_KEY && createKey !== CREATE_KEY) {
          return { error: "create_key_required" };
        }
      }
      const data = snap.exists
        ? snap.data()
        : { goal: GOAL, users: [], events: [], createdAt: Date.now() };
      data.users = data.users || [];
      if (data.users.some((u) => u.name.toLowerCase() === clean.toLowerCase())) {
        return { error: "name_taken" };
      }
      data.users.push({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: clean,
        count: 0,
      });
      t.set(ref, data);
      return { state: normalizeState(data) };
    });
    if (out.error) return res.status(409).json({ ok: false, error: out.error });
    res.json({ ok: true, state: out.state });
  } catch (e) {
    console.error("users error", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// Log a drink for a user (atomic increment + append to time series).
app.post("/api/drink", async (req, res) => {
  const { room, id } = req.body || {};
  if (!ROOM_RE.test(room || "")) return badRoom(res);
  if (!id) return res.status(400).json({ ok: false, error: "missing_id" });

  try {
    const out = await db.runTransaction(async (t) => {
      const ref = roomRef(room);
      const snap = await t.get(ref);
      if (!snap.exists) return { error: "no_room" };
      const data = snap.data();
      const user = (data.users || []).find((u) => u.id === id);
      if (!user) return { error: "no_user" };
      user.count = (user.count || 0) + 1;
      data.events = data.events || [];
      data.events.push(Date.now());
      if (data.events.length > MAX_EVENTS) {
        data.events = data.events.slice(-MAX_EVENTS);
      }
      t.set(ref, data);
      return { state: normalizeState(data) };
    });
    if (out.error) return res.status(409).json({ ok: false, error: out.error });
    res.json({ ok: true, state: out.state });
  } catch (e) {
    console.error("drink error", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// Remove a drinker (keeps historical events for the time series).
app.post("/api/remove", async (req, res) => {
  const { room, id } = req.body || {};
  if (!ROOM_RE.test(room || "")) return badRoom(res);
  if (!id) return res.status(400).json({ ok: false, error: "missing_id" });

  try {
    const out = await db.runTransaction(async (t) => {
      const ref = roomRef(room);
      const snap = await t.get(ref);
      if (!snap.exists) return { error: "no_room" };
      const data = snap.data();
      data.users = (data.users || []).filter((u) => u.id !== id);
      t.set(ref, data);
      return { state: normalizeState(data) };
    });
    if (out.error) return res.status(409).json({ ok: false, error: out.error });
    res.json({ ok: true, state: out.state });
  } catch (e) {
    console.error("remove error", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// Reset everything in a room.
app.post("/api/reset", async (req, res) => {
  const { room } = req.body || {};
  if (!ROOM_RE.test(room || "")) return badRoom(res);
  try {
    const data = { goal: GOAL, users: [], events: [], createdAt: Date.now() };
    await roomRef(room).set(data);
    res.json({ ok: true, state: normalizeState(data) });
  } catch (e) {
    console.error("reset error", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.get("/healthz", (_req, res) => res.send("ok"));

// ---- Static frontend ----
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`drink-counter listening on ${PORT}`));
