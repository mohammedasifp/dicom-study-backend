import Event from "../models/Event.js";
import { TAGS } from "../constants/tags.js";

export const PUSHED_TAGS = [TAGS.AI_COMPLETED, TAGS.REPORT_OVERDUE];
const clients = new Set();

export function addClient(res) {
  clients.add(res);
  res.on("close", () => clients.delete(res));
}

export function send(res, event) {
  res.write(`id: ${event._id}\nevent: ${event.tag}\ndata: ${JSON.stringify(event)}\n\n`);
}

export async function emit(tag, studyInstanceUid, { actor = "system", payload } = {}) {
  const event = await Event.create({ tag, studyInstanceUid, actor, payload });
  if (PUSHED_TAGS.includes(tag)) for (const res of clients) send(res, event);
  return event;
}

export function listSince(since, { studyInstanceUid, tags, limit = 200 } = {}) {
  const query = {};
  if (since) query._id = { $gt: since };
  if (studyInstanceUid) query.studyInstanceUid = studyInstanceUid;
  if (tags) query.tag = { $in: tags };
  return Event.find(query).sort({ _id: 1 }).limit(limit).lean();
}
