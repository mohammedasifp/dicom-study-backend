import os from "node:os";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import express from "express";
import multer from "multer";

const PORT = Number(process.env.MOCK_AI_PORT) || 4100;
const DELAY_MS = Number(process.env.MOCK_AI_DELAY_MS) || 300;
const upload = multer({ dest: os.tmpdir() });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MODELS = [
  { id: "cxr-findings-mock", name: "Chest X-ray Findings (mock)", version: "0.1.0", modalities: ["CR", "DX"] },
  { id: "ct-segmentation-mock", name: "CT Organ Segmentation (mock)", version: "0.1.0", modalities: ["CT"] },
  { id: "mr-brain-mock", name: "MR Brain Findings (mock)", version: "0.1.0", modalities: ["MR"] },
  { id: "mr-msk-mock", name: "MR Musculoskeletal Findings (mock)", version: "0.1.0", modalities: ["MR"] },
  { id: "us-abdomen-mock", name: "Ultrasound Abdomen (mock)", version: "0.1.0", modalities: ["US"] },
];

const TEMPLATES = {
  "cxr-findings-mock": [
    { text: "Possible opacity in the right lower zone.", confidence: 0.72, localizable: true },
    { text: "Cardiothoracic ratio within normal limits.", confidence: 0.88, localizable: false },
    { text: "No obvious pleural effusion.", confidence: 0.81, localizable: false },
  ],
  "ct-segmentation-mock": [
    { text: "Possible hypodense lesion in the liver, segment VI.", confidence: 0.64, localizable: true },
    { text: "Kidneys normal in size and attenuation.", confidence: 0.86, localizable: false },
  ],
  "mr-brain-mock": [
    { text: "Possible small T2 hyperintense focus in the left frontal white matter.", confidence: 0.58, localizable: true },
    { text: "No midline shift.", confidence: 0.9, localizable: false },
  ],
  "mr-msk-mock": [
    { text: "Possible joint effusion.", confidence: 0.63, localizable: true },
    { text: "No obvious fracture line.", confidence: 0.84, localizable: false },
  ],
  "us-abdomen-mock": [
    { text: "Liver echotexture appears mildly increased.", confidence: 0.61, localizable: false },
    { text: "Possible gallbladder calculus.", confidence: 0.55, localizable: true },
  ],
};

function resolveModel(meta) {
  if (!meta?.model) {
    const model = MODELS.find((m) => m.modalities.includes(meta?.modality));
    if (!model) throw new Error(`No model for modality ${meta?.modality}`);
    return model;
  }
  const model = MODELS.find((m) => m.id === meta.model);
  if (!model) throw new Error(`Unknown model ${meta.model}`);
  if (!model.modalities.includes(meta.modality)) throw new Error(`Model ${model.id} does not support modality ${meta.modality}`);
  return model;
}

function buildResult(model, sopUids, prompt) {
  const observations = TEMPLATES[model.id].map((o, i) => ({ id: `obs-${i + 1}`, ...o }));
  const rois = observations
    .filter((o) => o.localizable && sopUids.length)
    .map((o, i) => ({ observationId: o.id, sopInstanceUid: sopUids[i % sopUids.length], x: 120, y: 140, width: 80, height: 64 }));
  const { modalities: _m, ...modelInfo } = model;
  return {
    model: modelInfo,
    observations,
    rois,
    findings: observations.map((o) => o.text).join(" "),
    impression: "Findings as described. Correlate clinically. Radiologist review required.",
    uncertainty: "Mock model. Confidence values are synthetic and not calibrated.",
    limitations: ["Mock output for integration testing only.", `Analysed ${sopUids.length} instance(s).`, ...(prompt ? [`Additional instruction received: ${prompt}`] : [])],
  };
}

const sopOf = (file) => file.originalname.replace(/\.dcm$/, "");
const cleanup = (files) => Promise.all((files || []).map((f) => fs.rm(f.path, { force: true })));

const app = express();
app.use(express.json());

app.get("/v1/models", (req, res) => res.json(MODELS));

app.post("/v1/analyze/stream", upload.array("files"), async (req, res) => {
  const meta = JSON.parse(req.body.meta || "{}");
  const sopUids = (req.files || []).map(sopOf);
  await cleanup(req.files);
  let model;
  try {
    model = resolveModel(meta);
  } catch (err) {
    return res.status(422).json({ message: err.message });
  }

  const result = buildResult(model, sopUids, meta.prompt);
  res.setHeader("Content-Type", "application/x-ndjson");
  const line = (obj) => res.write(JSON.stringify(obj) + "\n");
  line({ type: "model", data: result.model });
  for (const o of result.observations) {
    await sleep(DELAY_MS);
    line({ type: "observation", data: o });
  }
  for (const r of result.rois) line({ type: "roi", data: r });
  line({ type: "done", result });
  res.end();
});

const jobs = new Map();

app.post("/v1/jobs", (req, res) => {
  const { meta, totalChunks } = req.body || {};
  let model;
  try {
    model = resolveModel(meta);
  } catch (err) {
    return res.status(422).json({ message: err.message });
  }
  const jobId = randomUUID();
  jobs.set(jobId, { model, prompt: meta.prompt, totalChunks, received: new Set(), sopUids: [] });
  res.status(201).json({ jobId, model: model.id });
});

app.post("/v1/jobs/:id/chunks", upload.array("files"), async (req, res) => {
  const job = jobs.get(req.params.id);
  await cleanup(req.files);
  if (!job) return res.status(404).json({ message: "Job not found" });
  job.received.add(Number(req.body.index));
  job.sopUids.push(...(req.files || []).map(sopOf));
  res.json({ received: job.received.size, totalChunks: job.totalChunks });
});

app.post("/v1/jobs/:id/complete", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ message: "Job not found" });
  if (job.received.size !== job.totalChunks) {
    return res.status(409).json({ message: `Received ${job.received.size} of ${job.totalChunks} chunks` });
  }
  await sleep(DELAY_MS);
  jobs.delete(req.params.id);
  res.json({ result: buildResult(job.model, job.sopUids, job.prompt) });
});

app.listen(PORT, () => console.log(`[MOCK-AI] listening on ${PORT}`));
