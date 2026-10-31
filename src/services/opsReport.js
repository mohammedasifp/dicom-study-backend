import CentreCase from "../models/CentreCase.js";
import Event from "../models/Event.js";
import OpsException from "../models/OpsException.js";
import "../models/Patient.js";
import Study from "../models/Study.js";
import { displayName, exceptionView } from "./opsExceptions.js";
import { HttpError } from "../utils/http.js";
import { OPS_TAGS, STUDY_STATUS, TAGS } from "../constants/tags.js";
import { CASE_STAGES, DEMO_CONTROLS, EXCEPTION_STATUS, OPS_DISCLAIMER, SEVERITIES, WORKFLOW_STAGES } from "../constants/ops.js";

const MINUTE = 60 * 1000;
const FEED_SIZE = 25;
const OPEN_STATUSES = [EXCEPTION_STATUS.OPEN, EXCEPTION_STATUS.ACKNOWLEDGED];
const STATUS_ORDER = { OPEN: 0, ACKNOWLEDGED: 1, RESOLVED: 2 };
const STAGE_SINCE = { REGISTERED: "registeredAt", ACQUIRED: "acquiredAt", IN_PACS: "pacsAt", REPORTED: "reportedAt", DELIVERED: "deliveredAt" };
const PRIORITY_ORDER = { STAT: 0, URGENT: 1, ROUTINE: 2 };
const MAX_STAGE_PATIENTS = 300;
const FEED_TAGS = OPS_TAGS.filter((tag) => ![TAGS.SIM_STARTED, TAGS.SIM_FAULT_INJECTED].includes(tag));

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

const countBy = (items, key) => items.reduce((acc, item) => ({ ...acc, [item[key]]: (acc[item[key]] || 0) + 1 }), {});
const average = (values) => (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null);
const minutesBetween = (from, to) => (new Date(to) - new Date(from)) / MINUTE;

const byPriority = (a, b) =>
  STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
  SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity) ||
  new Date(a.startedAt) - new Date(b.startedAt);

async function stageCounts(openExceptions) {
  const [cases, studies] = await Promise.all([
    CentreCase.aggregate([{ $group: { _id: "$stage", count: { $sum: 1 } } }]),
    Study.aggregate([{ $group: { _id: { $eq: ["$status", STUDY_STATUS.REPORTED] }, count: { $sum: 1 } } }]),
  ]);
  const caseCount = Object.fromEntries(cases.map((c) => [c._id, c.count]));
  const studyCount = { IN_PACS: studies.find((s) => s._id === false)?.count || 0, REPORTED: studies.find((s) => s._id === true)?.count || 0 };
  const exceptionCount = countBy(openExceptions, "caseStage");
  return CASE_STAGES.map((stage) => ({
    stage,
    count: (caseCount[stage] || 0) + (studyCount[stage] || 0),
    openExceptions: exceptionCount[stage] || 0,
  }));
}

async function liveStudiesAt(stage) {
  if (!["IN_PACS", "REPORTED"].includes(stage)) return [];
  const reported = stage === "REPORTED";
  const studies = await Study.find({ status: reported ? STUDY_STATUS.REPORTED : { $ne: STUDY_STATUS.REPORTED } })
    .populate("patient")
    .limit(MAX_STAGE_PATIENTS)
    .lean();
  return studies.map((s) => ({
    ref: { kind: "study", id: s.studyInstanceUid },
    patient: { patientId: s.patient?.patientId, name: displayName(s.patient?.name) },
    accessionNumber: s.accessionNumber,
    modality: s.modality,
    description: s.description,
    priority: s.priority,
    since: (reported ? s.reportedAt : s.createdAt) || s.updatedAt,
  }));
}

export async function stagePatients(stage) {
  if (!CASE_STAGES.includes(stage)) throw new HttpError(400, `stage must be one of ${CASE_STAGES.join(", ")}`);
  const [cases, live, open] = await Promise.all([
    CentreCase.find({ stage }).limit(MAX_STAGE_PATIENTS).lean(),
    liveStudiesAt(stage),
    OpsException.find({ status: { $in: OPEN_STATUSES } }, "ref type severity").lean(),
  ]);
  const worst = new Map();
  for (const e of open) {
    const key = `${e.ref.kind}:${e.ref.id}`;
    const current = worst.get(key);
    if (!current || SEVERITIES.indexOf(e.severity) > SEVERITIES.indexOf(current.severity)) worst.set(key, { type: e.type, severity: e.severity });
  }
  const patients = [
    ...cases.map((c) => ({
      ref: { kind: "case", id: c.caseNumber },
      patient: { patientId: c.patient.patientId, name: c.patient.name },
      accessionNumber: c.accessionNumber,
      modality: c.modality,
      description: c.description,
      priority: c.priority,
      since: c[STAGE_SINCE[stage]],
      scheduledAt: stage === "REGISTERED" ? c.scheduledAt : undefined,
    })),
    ...live,
  ].map((p) => ({ ...p, exception: worst.get(`${p.ref.kind}:${p.ref.id}`) || null }));
  const rank = (p) => (p.exception ? SEVERITIES.length - SEVERITIES.indexOf(p.exception.severity) : SEVERITIES.length + 1);
  patients.sort(
    (a, b) => rank(a) - rank(b) || PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || new Date(a.since) - new Date(b.since)
  );
  return { stage, patients };
}

export async function opsDashboard() {
  const today = startOfToday();
  const [exceptions, feed] = await Promise.all([
    OpsException.find({ $or: [{ status: { $in: OPEN_STATUSES } }, { resolvedAt: { $gte: today } }] }).lean(),
    Event.find({ tag: { $in: FEED_TAGS } }).sort({ _id: -1 }).limit(FEED_SIZE).lean(),
  ]);
  const open = exceptions.filter((e) => e.status !== EXCEPTION_STATUS.RESOLVED);
  return {
    stages: await stageCounts(open),
    exceptions: exceptions.sort(byPriority).map(exceptionView),
    counts: {
      open: open.filter((e) => e.status === EXCEPTION_STATUS.OPEN).length,
      acknowledged: open.filter((e) => e.status === EXCEPTION_STATUS.ACKNOWLEDGED).length,
      resolvedToday: exceptions.length - open.length,
      bySeverity: countBy(open, "severity"),
      unassigned: open.filter((e) => !e.assignee?.id).length,
    },
    feed: feed.map((e) => ({ id: String(e._id), tag: e.tag, at: e.createdAt, payload: e.payload })),
    demoControls: DEMO_CONTROLS,
    disclaimer: OPS_DISCLAIMER,
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const typeLabel = (type) => type.toLowerCase().replace(/_/g, " ");
const duration = (minutes) => (minutes < 1 ? "under a minute" : `${minutes} min`);

function insightsFor({ raisedByType, open, resolved, slowest, sla, bottleneck }) {
  const insights = [];
  const [topType, topCount] = Object.entries(raisedByType).sort((a, b) => b[1] - a[1])[0] || [];
  if (topType) insights.push(`Most frequent problem today: ${typeLabel(topType)} (${plural(topCount, "case")}).`);
  if (bottleneck) insights.push(`Bottleneck: ${typeLabel(bottleneck.stage)} has the most open exceptions (${bottleneck.count}).`);
  if (slowest) insights.push(`Slowest to resolve: ${typeLabel(slowest.type)}, ${duration(slowest.minutes)} on average.`);
  if (sla.total) insights.push(`${sla.percent}% of reports signed today were within their turnaround target (${sla.within} of ${sla.total}).`);
  const critical = open.filter((e) => e.severity === "CRITICAL").length;
  if (open.length) {
    insights.push(`${plural(open.length, "exception")} carried over to the next shift${critical ? `, ${critical} of them critical` : ""}.`);
  } else if (resolved.length) {
    insights.push("Every exception raised today has been resolved.");
  }
  const unassigned = open.filter((e) => !e.assignee?.id).length;
  if (unassigned) insights.push(`${plural(unassigned, "open exception")} not assigned to anyone yet.`);
  return insights;
}

async function slaToday(today) {
  const [cases, studies] = await Promise.all([
    CentreCase.find({ reportedAt: { $gte: today } }, "reportedAt dueAt pacsAt").lean(),
    Study.find({ status: STUDY_STATUS.REPORTED, reportedAt: { $gte: today } }, "reportedAt sla createdAt").lean(),
  ]);
  const rows = [
    ...cases.map((c) => ({ done: c.reportedAt, due: c.dueAt, from: c.pacsAt })),
    ...studies.map((s) => ({ done: s.reportedAt, due: s.sla?.dueAt, from: s.createdAt })),
  ];
  const withTarget = rows.filter((r) => r.due);
  const within = withTarget.filter((r) => r.done <= r.due).length;
  return {
    total: withTarget.length,
    within,
    percent: withTarget.length ? Math.round((within / withTarget.length) * 100) : null,
    reported: rows.length,
    averageTatMinutes: average(rows.filter((r) => r.from).map((r) => minutesBetween(r.from, r.done))),
  };
}

export async function opsSummary() {
  const today = startOfToday();
  const now = new Date();
  const [raised, open, resolved, delivered, stages, sla] = await Promise.all([
    OpsException.find({ detectedAt: { $gte: today } }).lean(),
    OpsException.find({ status: { $in: OPEN_STATUSES } }).lean(),
    OpsException.find({ resolvedAt: { $gte: today } }).lean(),
    CentreCase.countDocuments({ deliveredAt: { $gte: today } }),
    OpsException.find({ status: { $in: OPEN_STATUSES } }, "caseStage").lean().then(stageCounts),
    slaToday(today),
  ]);

  const resolveTimes = {};
  for (const e of resolved) (resolveTimes[e.type] ||= []).push(minutesBetween(e.detectedAt, e.resolvedAt));
  const slowest = Object.entries(resolveTimes)
    .map(([type, times]) => ({ type, minutes: average(times) }))
    .sort((a, b) => b.minutes - a.minutes)[0];
  const openByStage = countBy(open, "stage");
  const [bottleneckStage] = WORKFLOW_STAGES.filter((s) => openByStage[s]).sort((a, b) => openByStage[b] - openByStage[a]);
  const raisedByType = countBy(raised, "type");

  return {
    generatedAt: now,
    from: today,
    stages,
    exceptions: {
      raised: raised.length,
      resolved: resolved.length,
      open: open.length,
      byType: raisedByType,
      bySeverity: countBy(raised, "severity"),
      averageMinutesToAcknowledge: average(raised.filter((e) => e.acknowledgedAt).map((e) => minutesBetween(e.detectedAt, e.acknowledgedAt))),
      averageMinutesToResolve: average(resolved.map((e) => minutesBetween(e.detectedAt, e.resolvedAt))),
    },
    throughput: { reported: sla.reported, delivered, averageTatMinutes: sla.averageTatMinutes },
    sla: { total: sla.total, within: sla.within, percent: sla.percent },
    carryOver: open.sort(byPriority).slice(0, 10).map(exceptionView),
    insights: insightsFor({
      raisedByType,
      open,
      resolved,
      slowest,
      sla,
      bottleneck: bottleneckStage && { stage: bottleneckStage, count: openByStage[bottleneckStage] },
    }),
    disclaimer: OPS_DISCLAIMER,
  };
}
