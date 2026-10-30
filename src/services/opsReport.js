import CentreCase from "../models/CentreCase.js";
import Event from "../models/Event.js";
import OpsException from "../models/OpsException.js";
import Study from "../models/Study.js";
import { exceptionView } from "./opsExceptions.js";
import { OPS_TAGS, STUDY_STATUS, TAGS } from "../constants/tags.js";
import { CASE_STAGES, EXCEPTION_STATUS, OPS_DISCLAIMER, SEVERITIES, WORKFLOW_STAGES } from "../constants/ops.js";

const MINUTE = 60 * 1000;
const FEED_SIZE = 25;
const OPEN_STATUSES = [EXCEPTION_STATUS.OPEN, EXCEPTION_STATUS.ACKNOWLEDGED];
const STATUS_ORDER = { OPEN: 0, ACKNOWLEDGED: 1, RESOLVED: 2 };
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
  if (unassigned) insights.push(`${plural(unassigned, "open exception")} still have no owner.`);
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
