import CentreCase from "../models/CentreCase.js";
import OpsException from "../models/OpsException.js";
import { emit } from "./events.js";
import { detectExceptions } from "./opsExceptions.js";
import { TAGS } from "../constants/tags.js";
import { CASE_STAGES, DEFAULT_INJECTIONS, EXCEPTION_TYPES, SLA_TARGET_MINUTES, THRESHOLDS } from "../constants/ops.js";
import { HttpError } from "../utils/http.js";

const MINUTE = 60 * 1000;
const TICK_MS = Number(process.env.SIM_TICK_MS) || 20000;
const ADVANCE_PER_TICK = Number(process.env.SIM_ADVANCE_PER_TICK) || 2;
const ENABLED = process.env.SIM_ENABLED !== "false";
const PATIENTS = Number(process.env.SIM_PATIENTS) || 50;
const FAULT_EVERY_MS = Number(process.env.SIM_FAULT_EVERY_MINUTES ?? 5) * MINUTE;
const MAX_CASES = 200;
const MAX_DELIVERED = 10;

const FIRST_NAMES = ["Aarav", "Diya", "Rohan", "Ananya", "Vikram", "Meera", "Arjun", "Kavya", "Rahul", "Priya", "Sanjay", "Lakshmi", "Imran", "Fatima", "Joseph", "Neha", "Karthik", "Pooja", "Suresh", "Anjali", "Manoj", "Divya", "Farhan", "Sneha", "Ravi"];
const LAST_NAMES = ["Sharma", "Iyer", "Reddy", "Nair", "Khan", "Gupta", "Menon", "Rao", "Patel", "Das", "Singh", "Kulkarni", "Fernandes", "Pillai", "Verma"];
const PROTOCOLS = [
  { modality: "CR", description: "X-Ray Chest PA", images: [1, 2] },
  { modality: "DX", description: "X-Ray Knee AP/Lateral", images: [2, 2] },
  { modality: "CT", description: "CT Brain Plain", images: [120, 180] },
  { modality: "CT", description: "CT Abdomen Contrast", images: [250, 400] },
  { modality: "MR", description: "MRI Lumbar Spine", images: [180, 260] },
  { modality: "MR", description: "MRI Brain", images: [220, 320] },
  { modality: "US", description: "USG Abdomen", images: [12, 30] },
  { modality: "US", description: "USG Pelvis", images: [10, 24] },
];

const FAULT_STAGE = {
  MISSED_SCAN: "REGISTERED",
  PACS_TRANSFER_STUCK: "ACQUIRED",
  PARTIAL_TRANSFER: "IN_PACS",
  ID_MISMATCH: "IN_PACS",
  NOT_VIEWED: "IN_PACS",
  REPORT_OVERDUE: "IN_PACS",
  DELIVERY_PENDING: "REPORTED",
};

let timer = null;
let nextIndex = 0;
let nextFaultAt = 0;

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const between = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const ago = (now, minutes) => new Date(now - minutes * MINUTE);

function priorityFor(index) {
  if (index % 10 === 0) return "STAT";
  if (index % 5 === 0) return "URGENT";
  return "ROUTINE";
}

function stageFor(index, count) {
  const share = index / count;
  if (share < 0.16) return "REGISTERED";
  if (share < 0.3) return "ACQUIRED";
  if (share < 0.6) return "IN_PACS";
  if (share < 0.78) return "REPORTED";
  return "DELIVERED";
}

function buildCase(index, stage, now) {
  const protocol = pick(PROTOCOLS);
  const priority = priorityFor(index);
  const number = String(index + 1).padStart(3, "0");
  const patient = { patientId: `SIMP-${10200 + index}`, name: `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`, age: between(4, 86), sex: pick(["M", "F"]) };
  const expectedImages = between(...protocol.images);
  const reached = CASE_STAGES.indexOf(stage);

  const scheduledAt = stage === "REGISTERED" ? new Date(now.getTime() + between(-5, 40) * MINUTE) : ago(now, between(70, 180));
  const acquiredAt = reached >= 1 ? (stage === "ACQUIRED" ? ago(now, between(1, 8)) : ago(now, between(50, 65))) : undefined;
  const pacsAt = reached >= 2 ? (stage === "IN_PACS" ? ago(now, between(2, 20)) : ago(now, between(40, 48))) : undefined;
  const viewedAt = reached >= 2 && (stage !== "IN_PACS" || Math.random() < 0.6) ? new Date(Math.min(now, pacsAt.getTime() + 2 * MINUTE)) : undefined;
  const reportedAt = reached >= 3 ? (stage === "REPORTED" ? ago(now, between(2, 40)) : ago(now, between(25, 38))) : undefined;
  const deliveredAt = reached >= 4 ? ago(now, between(1, 20)) : undefined;
  const dueAt = pacsAt ? new Date(Math.max(pacsAt.getTime() + SLA_TARGET_MINUTES[priority] * MINUTE, now.getTime() + 25 * MINUTE)) : undefined;

  return {
    caseNumber: `SIM-${number}`,
    patient,
    accessionNumber: `SIMACC-${70400 + index}`,
    modality: protocol.modality,
    description: protocol.description,
    priority,
    patientClass: priority === "STAT" ? "ER" : pick(["OP", "OP", "OP", "IP"]),
    stage,
    registeredAt: new Date(Math.min(now, scheduledAt) - between(10, 30) * MINUTE),
    scheduledAt,
    acquiredAt,
    pacsAt,
    viewedAt,
    reportedAt,
    deliveredAt,
    dueAt,
    expectedImages,
    receivedImages: reached >= 2 ? expectedImages : 0,
    pacsPatient: reached >= 2 ? { patientId: patient.patientId, name: patient.name } : undefined,
  };
}

const stageClock = (c) => ({ REGISTERED: c.scheduledAt, ACQUIRED: c.acquiredAt, IN_PACS: c.viewedAt || c.pacsAt, REPORTED: c.reportedAt })[c.stage];

function advance(c, now) {
  const from = c.stage;
  if (c.stage === "REGISTERED") {
    c.stage = "ACQUIRED";
    c.acquiredAt = now;
  } else if (c.stage === "ACQUIRED") {
    c.stage = "IN_PACS";
    c.pacsAt = now;
    c.receivedImages = c.expectedImages;
    c.pacsPatient = { patientId: c.patient.patientId, name: c.patient.name };
    c.dueAt = new Date(now.getTime() + SLA_TARGET_MINUTES[c.priority] * MINUTE);
  } else if (c.stage === "IN_PACS" && !c.viewedAt) {
    c.viewedAt = now;
  } else if (c.stage === "IN_PACS") {
    c.stage = "REPORTED";
    c.reportedAt = now;
  } else if (c.stage === "REPORTED") {
    c.stage = "DELIVERED";
    c.deliveredAt = now;
  }
  return from;
}

async function saveAdvance(c, now, by = "simulator") {
  const from = advance(c, now);
  await c.save();
  if (from !== c.stage) {
    await emit(TAGS.CASE_STAGE_CHANGED, undefined, {
      actor: "server",
      payload: { caseNumber: c.caseNumber, patient: c.patient.name, from, to: c.stage, by },
    });
  }
}

async function registerNewPatients(now) {
  const delivered = await CentreCase.find({ stage: "DELIVERED" }).sort({ deliveredAt: 1 });
  for (const old of delivered.slice(0, Math.max(0, delivered.length - MAX_DELIVERED))) {
    await old.deleteOne();
    const fresh = await CentreCase.create(buildCase(nextIndex++, "REGISTERED", now));
    await emit(TAGS.CASE_STAGE_CHANGED, undefined, {
      actor: "server",
      payload: { caseNumber: fresh.caseNumber, patient: fresh.patient.name, from: null, to: fresh.stage, by: "simulator" },
    });
  }
}

async function injectOnSchedule(now) {
  if (!FAULT_EVERY_MS || now < nextFaultAt) return;
  nextFaultAt = now.getTime() + FAULT_EVERY_MS;
  await injectFaults({ types: [pick(Object.keys(EXCEPTION_TYPES))], by: "simulator" }).catch((err) => console.warn("[SIM]", err.message));
}

async function tick() {
  const now = new Date();
  const candidates = await CentreCase.find({ stage: { $ne: "DELIVERED" }, "fault.type": null });
  const ready = candidates.filter((c) => c.stage !== "REGISTERED" || c.scheduledAt <= now).sort((a, b) => stageClock(a) - stageClock(b));
  for (const c of ready.slice(0, ADVANCE_PER_TICK)) await saveAdvance(c, now);
  await registerNewPatients(now);
  await injectOnSchedule(now);
  await detectExceptions();
}

function startTimer() {
  if (timer) return;
  timer = setInterval(() => tick().catch((err) => console.error("[SIM]", err.message)), TICK_MS);
}

export function stopSimulator() {
  clearInterval(timer);
  timer = null;
}

export async function startSimulation({ count = PATIENTS, by }) {
  if (!Number.isInteger(count) || count < 5 || count > MAX_CASES) throw new HttpError(400, `count must be a whole number from 5 to ${MAX_CASES}`);
  stopSimulator();
  await Promise.all([CentreCase.deleteMany({}), OpsException.deleteMany({ "ref.kind": "case" })]);
  const now = new Date();
  await CentreCase.insertMany(Array.from({ length: count }, (_, i) => buildCase(i, stageFor(i, count), now)));
  nextIndex = count;
  nextFaultAt = now.getTime() + FAULT_EVERY_MS;
  startTimer();
  console.log(`[SIM] started with ${count} patients by ${by}`);
  await emit(TAGS.SIM_STARTED, undefined, { actor: "server", payload: { count, by } });
  await detectExceptions();
  return { caseCount: count };
}

export async function startSimulator() {
  if (!ENABLED) return console.log("[SIM] off (SIM_ENABLED=false)");
  const cases = await CentreCase.find({}, "caseNumber").lean();
  if (!cases.length) return startSimulation({ by: "system" });
  nextIndex = Math.max(...cases.map((c) => Number(c.caseNumber.replace(/\D/g, ""))));
  nextFaultAt = Date.now() + FAULT_EVERY_MS;
  startTimer();
  console.log(`[SIM] running with ${cases.length} patients, a failure every ${FAULT_EVERY_MS / MINUTE || "-"} min`);
}

function placeAt(c, stage, now) {
  c.stage = stage;
  const reached = CASE_STAGES.indexOf(stage);
  c.acquiredAt = reached >= 1 ? c.acquiredAt || ago(now, 20) : undefined;
  c.pacsAt = reached >= 2 ? c.pacsAt || ago(now, 15) : undefined;
  c.receivedImages = reached >= 2 ? c.expectedImages : 0;
  c.pacsPatient = reached >= 2 ? { patientId: c.patient.patientId, name: c.patient.name } : undefined;
  c.dueAt = reached >= 2 ? c.dueAt || new Date(c.pacsAt.getTime() + SLA_TARGET_MINUTES[c.priority] * MINUTE) : undefined;
  c.reportedAt = reached >= 3 ? c.reportedAt || ago(now, 5) : undefined;
  c.viewedAt = reached >= 3 ? c.viewedAt || c.pacsAt : c.viewedAt;
}

const mistype = (name) => {
  const [first, ...rest] = name.split(" ");
  return [first.slice(0, -1) + first.slice(-1).repeat(2), ...rest].join(" ");
};

function applyFault(c, type, now) {
  if (c.stage !== FAULT_STAGE[type]) placeAt(c, FAULT_STAGE[type], now);
  const late = (minutes) => ago(now, minutes + between(5, 20));
  if (type === "MISSED_SCAN") c.scheduledAt = late(THRESHOLDS.scanGrace);
  if (type === "PACS_TRANSFER_STUCK") c.acquiredAt = late(THRESHOLDS.pacsGrace);
  if (type === "PARTIAL_TRANSFER") {
    c.pacsAt = late(THRESHOLDS.partialGrace);
    c.receivedImages = Math.max(0, Math.floor(c.expectedImages * 0.6));
  }
  if (type === "ID_MISMATCH") {
    const id = c.patient.patientId;
    c.pacsPatient = { patientId: `${id.slice(0, -2)}${id.at(-1)}${id.at(-2)}`, name: mistype(c.patient.name) };
    if (c.pacsPatient.patientId === id) c.pacsPatient.patientId = `${id}9`;
  }
  if (type === "NOT_VIEWED") {
    c.pacsAt = late(THRESHOLDS.notViewed);
    c.viewedAt = undefined;
  }
  if (type === "REPORT_OVERDUE") {
    c.viewedAt = c.viewedAt || c.pacsAt;
    c.dueAt = ago(now, between(10, 25));
  }
  if (type === "DELIVERY_PENDING") c.reportedAt = late(THRESHOLDS.deliveryGrace);
  c.fault = { type, injectedAt: now };
}

async function injectOne(type, now, used) {
  const healthy = await CentreCase.find({ "fault.type": null, stage: { $ne: "DELIVERED" }, caseNumber: { $nin: [...used] } });
  const open = new Set((await OpsException.find({ "ref.kind": "case", status: { $ne: "RESOLVED" } }, "ref.id").lean()).map((e) => e.ref.id));
  const pool = healthy.filter((c) => !open.has(c.caseNumber));
  const target = pool.find((c) => c.stage === FAULT_STAGE[type]) || pool[0];
  if (!target) throw new HttpError(409, "No healthy patient is left to inject a fault into. Start a new simulation.");
  applyFault(target, type, now);
  await target.save();
  used.add(target.caseNumber);
  console.log(`[SIM] injected ${type} into ${target.caseNumber}`);
  return { type, caseNumber: target.caseNumber, patient: target.patient.name };
}

export async function injectFaults({ types = DEFAULT_INJECTIONS, by }) {
  if (!Array.isArray(types) || !types.length || types.some((t) => !EXCEPTION_TYPES[t])) {
    throw new HttpError(400, `types must be a list of: ${Object.keys(EXCEPTION_TYPES).join(", ")}`);
  }
  if (!(await CentreCase.exists({}))) throw new HttpError(409, "The simulator has no patients. Start it first.");
  const now = new Date();
  const used = new Set();
  const injected = [];
  for (const type of types) injected.push(await injectOne(type, now, used));
  await emit(TAGS.SIM_FAULT_INJECTED, undefined, { actor: "server", payload: { injected, by } });
  await detectExceptions();
  return injected;
}

export async function remedyCase(caseNumber, type) {
  const c = await CentreCase.findOne({ caseNumber });
  if (!c) return;
  const now = new Date();
  if (c.fault?.type === type) c.fault = undefined;
  if (type === "ID_MISMATCH") c.pacsPatient = { patientId: c.patient.patientId, name: c.patient.name };
  if (type === "PARTIAL_TRANSFER") c.receivedImages = c.expectedImages;
  if (type === "NOT_VIEWED") c.viewedAt = now;
  if (type === "REPORT_OVERDUE") c.dueAt = undefined;
  const moves = { MISSED_SCAN: "REGISTERED", PACS_TRANSFER_STUCK: "ACQUIRED", REPORT_OVERDUE: "IN_PACS", DELIVERY_PENDING: "REPORTED" };
  if (moves[type] === c.stage) {
    if (c.stage === "IN_PACS") c.viewedAt = c.viewedAt || now;
    await saveAdvance(c, now, "staff");
  } else {
    await c.save();
  }
}
