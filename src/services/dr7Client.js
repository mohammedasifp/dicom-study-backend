import { getRenderedJpeg } from "./orthanc.js";
import { SUPPORTED_MODALITIES } from "../constants/tags.js";

const DR7_BASE_URL = process.env.DR7_BASE_URL || "https://dr7.ai/api/v1/medical";
const AI_API_KEY = process.env.AI_API_KEY;
const MAX_IMAGES = 4;
const MODELS_TTL_MS = 10 * 60 * 1000;
const CHEST_MODEL = "chexagent";
const GENERAL_MODEL = "med-gemini";
const MODEL_MODALITIES = { chexagent: ["CR", "DX"] };
const BASE_PROMPT = [
  "You assist a radiologist. The images are numbered. All images belong to series 1, and the image number is the instance number.",
  "Reply with JSON only, no other text, in this shape:",
  '{"observations":[{"section":"findings","title":"short label, at most 40 characters","text":"one finding","series":1,"instance":<image number>,"confidence":<0 to 1>,"limitation":"optional caveat for this finding"}],"uncertainty":"what limits your confidence"}',
  "Give one observation per finding. Give each impression point as its own observation with section set to impression.",
  "Set instance to the image that shows the finding. Set confidence to your confidence in that finding, from 0 to 1.",
].join("\n");

const authHeader = () => {
  if (!AI_API_KEY) throw new Error("AI_API_KEY is not set");
  return { Authorization: `Bearer ${AI_API_KEY}` };
};

let modelCache = { at: 0, models: null };

export async function listModels() {
  if (modelCache.models && Date.now() - modelCache.at < MODELS_TTL_MS) return modelCache.models;
  const res = await fetch(`${DR7_BASE_URL}/models`, { headers: authHeader() });
  if (!res.ok) throw new Error(`dr7 models ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const models = (await res.json()).data.map((m) => ({
    id: m.id,
    name: m.id,
    version: "dr7",
    category: m.category,
    supportsImage: m.supports_image,
    minTier: m.min_tier,
    modalities: m.supports_image ? MODEL_MODALITIES[m.id] || SUPPORTED_MODALITIES : [],
  }));
  modelCache = { at: Date.now(), models };
  return models;
}

export function autoModel(study) {
  const chest = ["CR", "DX"].includes(study.modality) && /chest|thorax/i.test(study.bodyPart || "");
  return chest ? CHEST_MODEL : GENERAL_MODEL;
}

function pickImages(study) {
  return study.series
    .filter((s) => s.instances.length)
    .slice(0, MAX_IMAGES)
    .map((s) => {
      const sorted = [...s.instances].sort((a, b) => (a.instanceNumber ?? 0) - (b.instanceNumber ?? 0));
      const { orthancId, sopInstanceUid } = sorted[Math.floor(sorted.length / 2)];
      return { orthancId, sopInstanceUid, seriesInstanceUid: s.seriesInstanceUid };
    });
}

async function imageParts(instance, number) {
  const jpeg = Buffer.from(await getRenderedJpeg(instance.orthancId)).toString("base64");
  return [
    { type: "text", text: `Image ${number}:` },
    { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg}` } },
  ];
}

function promptText(study, prompt) {
  const context = `Modality ${study.modality}${study.bodyPart ? `, body part ${study.bodyPart}` : ""}.`;
  return [BASE_PROMPT, context, prompt && `Additional instruction: ${prompt}`].filter(Boolean).join("\n");
}

async function complete(model, content, stream) {
  const res = await fetch(`${DR7_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify({ model, max_tokens: 800, temperature: 0.2, stream, messages: [{ role: "user", content }] }),
  });
  if (!res.ok) throw new Error(`dr7 ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

async function readStream(res, onProgress) {
  let buffer = "";
  let text = "";
  let sent = 0;
  for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("data:") || line === "data: [DONE]") continue;
      text += JSON.parse(line.slice(5)).choices?.[0]?.delta?.content || "";
      for (let nl = text.indexOf("\n", sent); nl !== -1; nl = text.indexOf("\n", sent)) {
        const done = text.slice(sent, nl).trim();
        sent = nl + 1;
        if (done) await onProgress({ type: "text", data: done });
      }
    }
  }
  const rest = text.slice(sent).trim();
  if (rest) await onProgress({ type: "text", data: rest });
  return text;
}

function toConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.min(n > 1 ? n / 100 : n, 1);
}

function parseJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const json = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(json.observations) ? json : null;
  } catch {
    return null;
  }
}

function parseLines(text) {
  const lines = text.split("\n").map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim());
  return { observations: lines.filter(Boolean).map((line) => ({ text: line })), impression: "", uncertainty: "" };
}

function parse(text, imageNumber, imageCount) {
  const json = parseJson(text);
  const parsed = json || parseLines(text);
  const items = [...parsed.observations];
  const impression = typeof parsed.impression === "string" ? parsed.impression.trim() : "";
  if (impression && !items.some((o) => o?.section === "impression")) items.push({ section: "impression", title: "Impression", text: impression });
  const observations = items
    .filter((o) => typeof o?.text === "string" && o.text.trim())
    .map((o) => {
      const instance = Number(o.instance);
      const fallback = imageCount === 1 ? 1 : undefined;
      return {
        section: o.section === "impression" ? "impression" : "findings",
        title: typeof o.title === "string" && o.title.trim() ? o.title.trim().slice(0, 40) : undefined,
        text: o.text.trim(),
        confidence: toConfidence(o.confidence),
        limitation: typeof o.limitation === "string" && o.limitation.trim() ? o.limitation.trim() : undefined,
        instance: imageNumber ?? (Number.isInteger(instance) && instance >= 1 && instance <= imageCount ? instance : fallback),
      };
    });
  return { observations, uncertainty: String(parsed.uncertainty || "").trim(), structured: !!json };
}

function toResult(model, parts, images, totalCount, prompt) {
  const seen = new Set();
  const observations = parts
    .flatMap((p) => p.observations)
    .filter((o) => {
      const key = `${o.section}:${o.text.toLowerCase()}`;
      return !seen.has(key) && seen.add(key);
    })
    .map((o, i) => {
      const image = o.instance ? images[o.instance - 1] : undefined;
      return {
        id: `obs-${i + 1}`,
        ...o,
        localizable: false,
        series: 1,
        source: image ? { seriesInstanceUid: image.seriesInstanceUid, sopInstanceUid: image.sopInstanceUid } : undefined,
      };
    });
  const unstructured = parts.filter((p) => !p.structured).length;
  return {
    model: { id: model, name: `dr7.ai ${model}`, version: "dr7" },
    observations,
    rois: [],
    findings: "",
    uncertainty: [...new Set(parts.map((p) => p.uncertainty).filter(Boolean))].join(" ") || "Not stated by the model.",
    limitations: [
      `The model saw ${images.length} of ${totalCount} images, as 768 px JPEG renders, not the full DICOM data.`,
      ...(unstructured ? [`${unstructured} model answer(s) were not valid JSON, so their findings have no confidence value.`] : []),
      ...(prompt ? [`Additional instruction received: ${prompt}`] : []),
    ],
  };
}

export async function analyze(study, mode, { model, prompt } = {}, onProgress) {
  const useModel = model || autoModel(study);
  const images = pickImages(study);
  if (!images.length) throw new Error("No images to send to dr7");
  const total = study.series.reduce((n, s) => n + s.instances.length, 0);
  const text = promptText(study, prompt);
  const parts = [];

  if (mode === "stream") {
    const content = [{ type: "text", text }, ...(await Promise.all(images.map((img, i) => imageParts(img, i + 1)))).flat()];
    parts.push(parse(await readStream(await complete(useModel, content, true), onProgress), undefined, images.length));
  } else {
    for (const [index, image] of images.entries()) {
      const res = await complete(useModel, [{ type: "text", text }, ...(await imageParts(image, index + 1))], false);
      parts.push(parse((await res.json()).choices?.[0]?.message?.content || "", index + 1, images.length));
      await onProgress({ type: "chunk", data: { index, totalChunks: images.length, instances: 1 } });
    }
  }

  if (!parts.some((p) => p.observations.length)) throw new Error("dr7 returned no findings");
  return toResult(useModel, parts, images, total, prompt);
}
