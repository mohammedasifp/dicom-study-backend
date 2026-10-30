import { getInstanceFile } from "./orthanc.js";

const AI_BASE_URL = process.env.AI_BASE_URL || "http://localhost:4100";
const CHUNK_SIZE = Number(process.env.AI_CHUNK_SIZE) || 5;

function studyMeta(study, { model, prompt } = {}) {
  return {
    model,
    prompt,
    studyInstanceUid: study.studyInstanceUid,
    modality: study.modality,
    bodyPart: study.bodyPart,
    series: study.series.map((s) => ({
      seriesInstanceUid: s.seriesInstanceUid,
      modality: s.modality,
      instanceCount: s.instances.length,
    })),
  };
}

function allInstances(study) {
  return study.series.flatMap((s) => s.instances);
}

async function toForm(instances, fields) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  for (const inst of instances) {
    form.append("files", new Blob([await getInstanceFile(inst.orthancId)]), `${inst.sopInstanceUid}.dcm`);
  }
  return form;
}

async function ensureOk(res) {
  if (!res.ok) throw new Error(`AI API ${res.status}: ${await res.text()}`);
  return res;
}

async function analyzeStream(study, options, onProgress) {
  const form = await toForm(allInstances(study), { meta: JSON.stringify(studyMeta(study, options)) });
  const res = await ensureOk(await fetch(`${AI_BASE_URL}/v1/analyze/stream`, { method: "POST", body: form }));

  let buffer = "";
  let result;
  for await (const text of res.body.pipeThrough(new TextDecoderStream())) {
    buffer += text;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines.filter(Boolean)) {
      const msg = JSON.parse(line);
      if (msg.type === "done") result = msg.result;
      else if (msg.type === "error") throw new Error(msg.message);
      else await onProgress({ type: msg.type, data: msg.data });
    }
  }
  if (!result) throw new Error("AI stream ended without a result");
  return result;
}

async function analyzeChunked(study, options, onProgress) {
  const instances = allInstances(study);
  const totalChunks = Math.ceil(instances.length / CHUNK_SIZE);
  const job = await (
    await ensureOk(
      await fetch(`${AI_BASE_URL}/v1/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meta: studyMeta(study, options), totalChunks }),
      })
    )
  ).json();

  for (let i = 0; i < totalChunks; i++) {
    const batch = instances.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    const form = await toForm(batch, { index: String(i) });
    await ensureOk(await fetch(`${AI_BASE_URL}/v1/jobs/${job.jobId}/chunks`, { method: "POST", body: form }));
    await onProgress({ type: "chunk", data: { index: i, totalChunks, instances: batch.length } });
  }

  const done = await (await ensureOk(await fetch(`${AI_BASE_URL}/v1/jobs/${job.jobId}/complete`, { method: "POST" }))).json();
  return done.result;
}

export function analyze(study, mode, options, onProgress) {
  return mode === "stream" ? analyzeStream(study, options, onProgress) : analyzeChunked(study, options, onProgress);
}

export async function listModels() {
  return (await ensureOk(await fetch(`${AI_BASE_URL}/v1/models`))).json();
}
