import { connectDB, disconnectDB } from "../config/db.js";
import CentreCase from "../src/models/CentreCase.js";
import OpsException from "../src/models/OpsException.js";
import Event from "../src/models/Event.js";
import Study from "../src/models/Study.js";
import { TAGS } from "../src/constants/tags.js";

const SIM_TAGS = [TAGS.SIM_STARTED, TAGS.SIM_FAULT_INJECTED, TAGS.CASE_STAGE_CHANGED];
const EXCEPTION_TAGS = [TAGS.OPS_EXCEPTION_RAISED, TAGS.OPS_EXCEPTION_ACKNOWLEDGED, TAGS.OPS_EXCEPTION_ASSIGNED, TAGS.OPS_EXCEPTION_RESOLVED, TAGS.OPS_EXCEPTION_CLEARED];

await connectDB();
const studyUids = new Set(await Study.distinct("studyInstanceUid"));
const stale = await OpsException.find({}, "_id ref").lean();
const staleExceptionIds = stale.filter((e) => e.ref?.kind === "case" || (e.ref?.kind === "study" && !studyUids.has(e.ref.id))).map((e) => e._id);
const [cases, exceptions, simEvents, exceptionEvents] = await Promise.all([
  CentreCase.deleteMany({}),
  OpsException.deleteMany({ _id: { $in: staleExceptionIds } }),
  Event.deleteMany({ tag: { $in: SIM_TAGS } }),
  Event.deleteMany({ tag: { $in: EXCEPTION_TAGS }, $or: [{ "payload.exceptionId": { $in: staleExceptionIds } }, { "payload.ref.kind": "case" }] }),
]);
console.log(`[SIM] cleared ${cases.deletedCount} cases, ${exceptions.deletedCount} simulated or orphaned exceptions, ${simEvents.deletedCount + exceptionEvents.deletedCount} events`);
await disconnectDB();
