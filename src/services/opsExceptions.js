import { isValidObjectId } from "mongoose";
import CentreCase from "../models/CentreCase.js";
import OpsException from "../models/OpsException.js";
import "../models/Patient.js";
import Radiologist from "../models/Radiologist.js";
import Study from "../models/Study.js";
import { emit } from "./events.js";
import { remedyCase } from "./simulator.js";
import { TAGS, STUDY_STATUS } from "../constants/tags.js";
import { EXCEPTION_STATUS, EXCEPTION_TYPES, SEVERITIES, THRESHOLDS } from "../constants/ops.js";
import { HttpError } from "../utils/http.js";

const MINUTE = 60 * 1000;
const TIME_ZONE = process.env.OPS_TIME_ZONE || "Asia/Kolkata";
const MAX_NOTE = 500;
const OPEN_STATUSES = [EXCEPTION_STATUS.OPEN, EXCEPTION_STATUS.ACKNOWLEDGED];

const minutesSince = (date, now) => (now - new Date(date)) / MINUTE;
const clock = (date) => new Date(date).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TIME_ZONE });
const letters = (name = "") => name.toLowerCase().replace(/[^a-z]/g, "");
const dedupeKey = (kind, id, type) => `${kind}:${id}:${type}`;
export const displayName = (name) => name?.replace(/\^+/g, " ").trim();

function caseProblems(c, now) {
  const problems = [];
  const add = (type, startedAt, detail) => problems.push({ type, startedAt, detail });
  if (c.stage === "REGISTERED" && minutesSince(c.scheduledAt, now) >= THRESHOLDS.scanGrace) {
    add("MISSED_SCAN", c.scheduledAt, `${c.description} was booked for ${clock(c.scheduledAt)}. No images have been acquired since.`);
  }
  if (c.stage === "ACQUIRED" && minutesSince(c.acquiredAt, now) >= THRESHOLDS.pacsGrace) {
    add("PACS_TRANSFER_STUCK", c.acquiredAt, `The scan finished at ${clock(c.acquiredAt)}, but no images have reached PACS.`);
  }
  if (["IN_PACS", "REPORTED"].includes(c.stage) && c.pacsPatient?.patientId) {
    const idDiffers = c.pacsPatient.patientId !== c.patient.patientId;
    const nameDiffers = letters(c.pacsPatient.name) !== letters(c.patient.name);
    if (idDiffers || nameDiffers) {
      add(
        "ID_MISMATCH",
        c.pacsAt,
        `The images in PACS are labelled ${c.pacsPatient.patientId} / "${c.pacsPatient.name}", but the order is for ${c.patient.patientId} / "${c.patient.name}".`
      );
    }
  }
  if (c.stage === "IN_PACS") {
    if (c.receivedImages < c.expectedImages && minutesSince(c.pacsAt, now) >= THRESHOLDS.partialGrace) {
      add("PARTIAL_TRANSFER", c.pacsAt, `Only ${c.receivedImages} of ${c.expectedImages} images have reached PACS since ${clock(c.pacsAt)}.`);
    }
    if (!c.viewedAt && minutesSince(c.pacsAt, now) >= THRESHOLDS.notViewed) {
      add("NOT_VIEWED", c.pacsAt, `The images reached PACS at ${clock(c.pacsAt)} and no radiologist has opened them.`);
    }
    if (c.dueAt && now >= c.dueAt) {
      add("REPORT_OVERDUE", c.dueAt, `The report was due at ${clock(c.dueAt)} (${c.priority.toLowerCase()} turnaround) and is not signed yet.`);
    }
  }
  if (c.stage === "REPORTED" && minutesSince(c.reportedAt, now) >= THRESHOLDS.deliveryGrace) {
    add("DELIVERY_PENDING", c.reportedAt, `The report was signed at ${clock(c.reportedAt)} but has not reached the patient or the referring doctor.`);
  }
  return problems;
}

function studyProblems(s, now) {
  const problems = [];
  if (s.status !== STUDY_STATUS.REPORTED && s.sla?.dueAt && now >= s.sla.dueAt) {
    problems.push({ type: "REPORT_OVERDUE", startedAt: s.sla.dueAt, detail: `The report was due at ${clock(s.sla.dueAt)} (${s.sla.minutes} min target) and is not finalised yet.` });
  }
  if (!s.viewed?.isViewed && s.viewed?.notViewedFlaggedAt) {
    const since = s.ai?.completedAt || s.createdAt;
    problems.push({ type: "NOT_VIEWED", startedAt: since, detail: `The AI draft has been ready since ${clock(since)} and no radiologist has opened the study.` });
  }
  return problems;
}

const caseRef = (c) => ({
  ref: { kind: "case", id: c.caseNumber },
  simulated: true,
  caseStage: c.stage,
  patient: { patientId: c.patient.patientId, name: c.patient.name },
  accessionNumber: c.accessionNumber,
  modality: c.modality,
  description: c.description,
  priority: c.priority,
});

const studyRef = (s) => ({
  ref: { kind: "study", id: s.studyInstanceUid },
  simulated: false,
  caseStage: "IN_PACS",
  patient: { patientId: s.patient?.patientId, name: displayName(s.patient?.name) },
  accessionNumber: s.accessionNumber,
  modality: s.modality,
  description: s.description,
  priority: s.priority,
});

export function severityFor(type, priority, startedAt, now = new Date()) {
  const rule = EXCEPTION_TYPES[type];
  let rank = SEVERITIES.indexOf(rule.severity);
  if (priority === "STAT") rank += 1;
  if (minutesSince(startedAt, now) >= rule.escalateAfter) rank += 1;
  return SEVERITIES[Math.min(rank, SEVERITIES.length - 1)];
}

async function detect(now) {
  const [cases, studies, open] = await Promise.all([
    CentreCase.find({ stage: { $ne: "DELIVERED" } }).lean(),
    Study.find({
      $or: [
        { status: { $ne: STUDY_STATUS.REPORTED }, "sla.dueAt": { $lte: now } },
        { "viewed.isViewed": false, "viewed.notViewedFlaggedAt": { $ne: null } },
      ],
    })
      .populate("patient")
      .lean(),
    OpsException.find({ status: { $in: OPEN_STATUSES } }),
  ]);

  const found = new Map();
  for (const c of cases) for (const p of caseProblems(c, now)) found.set(dedupeKey("case", c.caseNumber, p.type), { ...p, ...caseRef(c) });
  for (const s of studies) for (const p of studyProblems(s, now)) found.set(dedupeKey("study", s.studyInstanceUid, p.type), { ...p, ...studyRef(s) });

  // "study" matches resolved ones too: an overdue study stays overdue, so it would be re-raised on every pass.
  const known = new Set(
    (
      await OpsException.find(
        { dedupeKey: { $in: [...found.keys()] }, $or: [{ status: { $in: OPEN_STATUSES } }, { "ref.kind": "study" }] },
        "dedupeKey"
      ).lean()
    ).map((e) => e.dedupeKey)
  );

  let raised = 0;
  for (const [key, problem] of found) {
    if (known.has(key)) continue;
    const rule = EXCEPTION_TYPES[problem.type];
    const exception = await OpsException.create({
      ...problem,
      dedupeKey: key,
      severity: severityFor(problem.type, problem.priority, problem.startedAt, now),
      stage: rule.stage,
      detectedAt: now,
      actions: rule.actions,
      history: [{ action: "RAISED", by: "system", at: now }],
    });
    raised += 1;
    console.log(`[OPS] ${exception.severity} ${exception.type} raised for ${problem.ref.kind} ${problem.ref.id} (${problem.patient.name})`);
    await emit(TAGS.OPS_EXCEPTION_RAISED, problem.ref.kind === "study" ? problem.ref.id : undefined, {
      payload: { exceptionId: exception._id, type: exception.type, severity: exception.severity, ref: problem.ref, patient: problem.patient.name },
    });
  }

  for (const exception of open) {
    const problem = found.get(exception.dedupeKey);
    if (problem) {
      const severity = severityFor(exception.type, exception.priority, exception.startedAt, now);
      if (severity !== exception.severity || exception.clearedAt) {
        exception.severity = severity;
        exception.clearedAt = undefined;
        await exception.save();
      }
    } else if (!exception.clearedAt) {
      exception.clearedAt = now;
      exception.history.push({ action: "CLEARED", by: "system", at: now });
      await exception.save();
      await emit(TAGS.OPS_EXCEPTION_CLEARED, undefined, { payload: { exceptionId: exception._id, type: exception.type, ref: exception.ref } });
    }
  }
  return { raised };
}

let queue = Promise.resolve();

export function detectExceptions() {
  const run = queue.then(() => detect(new Date()));
  queue = run.catch(() => {});
  return run;
}

export function exceptionView(e) {
  const { _id, __v, dedupeKey: _key, ...rest } = e.toObject ? e.toObject() : e;
  return { id: String(_id), ...rest };
}

async function getException(id) {
  if (!isValidObjectId(id)) throw new HttpError(400, "id must be an exception id");
  const exception = await OpsException.findById(id);
  if (!exception) throw new HttpError(404, "Exception not found");
  return exception;
}

function markAcknowledged(exception, by, at) {
  if (exception.status !== EXCEPTION_STATUS.OPEN) return;
  exception.status = EXCEPTION_STATUS.ACKNOWLEDGED;
  exception.acknowledgedAt = at;
  exception.acknowledgedBy = by;
  exception.history.push({ action: "ACKNOWLEDGED", by, at });
}

const assertOpen = (exception) => {
  if (exception.status === EXCEPTION_STATUS.RESOLVED) throw new HttpError(409, "Exception is already resolved");
};

export async function acknowledgeException(id, by) {
  const exception = await getException(id);
  assertOpen(exception);
  if (exception.status === EXCEPTION_STATUS.ACKNOWLEDGED) return exceptionView(exception);
  markAcknowledged(exception, by, new Date());
  await exception.save();
  await emit(TAGS.OPS_EXCEPTION_ACKNOWLEDGED, undefined, { actor: "webapp", payload: { exceptionId: exception._id, type: exception.type, by } });
  return exceptionView(exception);
}

export async function assignException(id, { radiologistId, by }) {
  if (!isValidObjectId(radiologistId)) throw new HttpError(400, "radiologistId must be a radiologist id");
  const [exception, staff] = await Promise.all([getException(id), Radiologist.findById(radiologistId)]);
  if (!staff) throw new HttpError(404, "Radiologist not found");
  if (staff.status !== "ACTIVE") throw new HttpError(400, "Radiologist is not active");
  assertOpen(exception);
  const at = new Date();
  exception.assignee = { id: String(staff._id), name: staff.name };
  exception.assignedAt = at;
  markAcknowledged(exception, by, at);
  exception.history.push({ action: "ASSIGNED", by, note: staff.name, at });
  await exception.save();
  await emit(TAGS.OPS_EXCEPTION_ASSIGNED, undefined, { actor: "webapp", payload: { exceptionId: exception._id, type: exception.type, assignee: staff.name, by } });
  return exceptionView(exception);
}

export async function resolveException(id, { note, by }) {
  const text = typeof note === "string" ? note.trim() : "";
  if (text.length < 3 || text.length > MAX_NOTE) throw new HttpError(400, `note must be 3 to ${MAX_NOTE} characters: say what was done`);
  const exception = await getException(id);
  assertOpen(exception);
  const at = new Date();
  markAcknowledged(exception, by, at);
  exception.status = EXCEPTION_STATUS.RESOLVED;
  exception.resolvedAt = at;
  exception.resolvedBy = by;
  exception.resolutionNote = text;
  exception.history.push({ action: "RESOLVED", by, note: text, at });
  await exception.save();
  if (exception.ref.kind === "case") await remedyCase(exception.ref.id, exception.type);
  console.log(`[OPS] ${exception.type} for ${exception.ref.kind} ${exception.ref.id} resolved by ${by}`);
  await emit(TAGS.OPS_EXCEPTION_RESOLVED, undefined, { actor: "webapp", payload: { exceptionId: exception._id, type: exception.type, by, note: text } });
  return exceptionView(exception);
}
