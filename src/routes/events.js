import { Router } from "express";
import { isValidObjectId } from "mongoose";
import { addClient, listSince, send, PUSHED_TAGS } from "../services/events.js";
import { TAGS } from "../constants/tags.js";
import { ok, HttpError } from "../utils/http.js";

const router = Router();

function cursor(value) {
  if (value && !isValidObjectId(value)) throw new HttpError(400, "since must be an event id");
  return value;
}

router.get("/tags", (req, res) => ok(res, Object.values(TAGS)));

router.get("/", async (req, res) => {
  const events = await listSince(cursor(req.query.since), { studyInstanceUid: req.query.studyInstanceUid });
  return ok(res, { events, cursor: events.at(-1)?._id ?? req.query.since ?? null });
});

router.get("/stream", async (req, res) => {
  const since = cursor(req.get("Last-Event-ID") || req.query.since);
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  if (since) for (const e of await listSince(since, { tags: PUSHED_TAGS })) send(res, e);
  addClient(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  res.on("close", () => clearInterval(ping));
});

export default router;
