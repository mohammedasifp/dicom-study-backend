import Event from "../models/Event.js";
import Study from "../models/Study.js";
import { TAGS, STUDY_STATUS } from "../constants/tags.js";
import { HttpError } from "../utils/http.js";

const DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT) || 100;
const PER_STUDY_DAILY_LIMIT = Number(process.env.AI_PER_STUDY_DAILY_LIMIT) || 5;
const MAX_CONCURRENT = Number(process.env.AI_MAX_CONCURRENT) || 3;
const MIN_CREDIT_USD = Number(process.env.AI_MIN_CREDIT_USD ?? 1);
const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_RUN_MS = 15 * 60 * 1000;

let lastCredit = null;

export function recordCredit(value) {
  const credit = Number(value);
  if (Number.isFinite(credit)) lastCredit = credit;
}

const lastDay = () => new Date(Date.now() - DAY_MS);
const countRequested = (filter = {}) => Event.countDocuments({ tag: TAGS.AI_REQUESTED, createdAt: { $gte: lastDay() }, ...filter });
const countRunning = () =>
  Study.countDocuments({ status: STUDY_STATUS.AI_PROCESSING, "ai.requestedAt": { $gte: new Date(Date.now() - STALE_RUN_MS) } });

export async function aiUsage() {
  const [last24h, running] = await Promise.all([countRequested(), countRunning()]);
  return {
    last24h,
    running,
    dailyLimit: DAILY_LIMIT,
    perStudyDailyLimit: PER_STUDY_DAILY_LIMIT,
    maxConcurrent: MAX_CONCURRENT,
    minCreditUsd: MIN_CREDIT_USD,
    lastCreditUsd: lastCredit,
  };
}

export async function assertAiAllowed(studyInstanceUid) {
  if (lastCredit !== null && lastCredit < MIN_CREDIT_USD) {
    throw new HttpError(503, `AI credit is low ($${lastCredit.toFixed(2)} left, floor $${MIN_CREDIT_USD}). Top up dr7 or switch AI_PROVIDER to mock.`);
  }
  const [today, forStudy, running] = await Promise.all([countRequested(), countRequested({ studyInstanceUid }), countRunning()]);
  if (today >= DAILY_LIMIT) throw new HttpError(429, `AI limit reached: ${DAILY_LIMIT} analyses in the last 24 hours`);
  if (forStudy >= PER_STUDY_DAILY_LIMIT) throw new HttpError(429, `AI limit reached for this study: ${PER_STUDY_DAILY_LIMIT} analyses in the last 24 hours`);
  if (running >= MAX_CONCURRENT) throw new HttpError(429, `${running} AI analyses are already running. Try again in a minute.`);
}
