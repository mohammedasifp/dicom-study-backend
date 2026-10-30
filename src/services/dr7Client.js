import { getRenderedJpeg } from "./orthanc.js";
import { SUPPORTED_MODALITIES } from "../constants/tags.js";

const DR7_URL = process.env.DR7_URL || "https://dr7.ai/api/v1/medical/chat/completions";
const DR7_MODEL = process.env.DR7_MODEL || "medgemma-4b-it";
const DR7_API_KEY = process.env.DR7_API_KEY;
const MAX_IMAGES = 4;
const BASE_PROMPT =
  "You assist a radiologist. Describe the findings in these medical images. Answer in two sections. " +
  "FINDINGS: one finding per line, each line starts with '- '. IMPRESSION: one or two sentences.";

function pickImages(study) {
  return study.series
    .filter((s) => s.instances.length)
    .slice(0, MAX_IMAGES)
    .map((s) => {
      const sorted = [...s.instances].sort((a, b) => (a.instanceNumber ?? 0) - (b.instanceNumber ?? 0));
      return sorted[Math.floor(sorted.length / 2)];
    });
}

async function imagePart(instance) {
  const jpeg = Buffer.from(await getRenderedJpeg(instance.orthancId)).toString("base64");
  return { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg}` } };
}

function promptText(study, prompt) {
  const context = `Modality ${study.modality}${study.bodyPart ? `, body part ${study.bodyPart}` : ""}.`;
  return [BASE_PROMPT, context, prompt && `Additional instruction: ${prompt}`].filter(Boolean).join("\n");
}

async function complete(model, content, stream) {
  if (!DR7_API_KEY) throw new Error("DR7_API_KEY is not set");
  const res = await fetch(DR7_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${DR7_API_KEY}` },
    body: JSON.stringify({ model, max_tokens: 500, temperature: 0.3, stream, messages: [{ role: "user", content }] }),
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

const heading = (name) => new RegExp(`^[ \\t]*#*[ \\t]*\\**[ \\t]*${name}[ \\t]*\\**[ \\t]*:?[ \\t]*\\**`, "im");

function section(text, name, next) {
  const match = heading(name).exec(text);
  if (!match) return "";
  const body = text.slice(match.index + match[0].length);
  const end = next ? body.search(heading(next)) : -1;
  return (end === -1 ? body : body.slice(0, end)).trim();
}

function parse(text) {
  const impression = section(text, "impression");
  const findings = section(text, "findings", "impression") || (impression ? "" : text.trim());
  return { findings, impression };
}

function toResult(model, texts, sentCount, totalCount, prompt) {
  const parts = texts.map(parse);
  const lines = parts.flatMap((p) => p.findings.split("\n").map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()));
  const unique = [...new Set(lines.filter(Boolean))];
  const findings = unique.map((l) => `- ${l}`).join("\n");
  const impression = [...new Set(parts.map((p) => p.impression).filter(Boolean))].join(" ");
  const observations = unique.map((text, i) => ({ id: `obs-${i + 1}`, text, localizable: false }));
  return {
    model: { id: model, name: `dr7.ai ${model}`, version: "dr7" },
    observations,
    rois: [],
    findings,
    impression,
    uncertainty: "The model gives no confidence values.",
    limitations: [
      `The model saw ${sentCount} of ${totalCount} images, as 768 px JPEG renders, not the full DICOM data.`,
      ...(prompt ? [`Additional instruction received: ${prompt}`] : []),
    ],
  };
}

export async function analyze(study, mode, { model = DR7_MODEL, prompt } = {}, onProgress) {
  const images = pickImages(study);
  if (!images.length) throw new Error("No images to send to dr7");
  const total = study.series.reduce((n, s) => n + s.instances.length, 0);
  const text = promptText(study, prompt);
  const texts = [];

  if (mode === "stream") {
    const content = [{ type: "text", text }, ...(await Promise.all(images.map(imagePart)))];
    texts.push(await readStream(await complete(model, content, true), onProgress));
  } else {
    for (const [index, image] of images.entries()) {
      const res = await complete(model, [{ type: "text", text }, await imagePart(image)], false);
      texts.push((await res.json()).choices?.[0]?.message?.content || "");
      await onProgress({ type: "chunk", data: { index, totalChunks: images.length, instances: 1 } });
    }
  }

  if (!texts.some((t) => t.trim())) throw new Error("dr7 returned no text");
  return toResult(model, texts, images.length, total, prompt);
}

export async function listModels() {
  return [{ id: DR7_MODEL, name: `dr7.ai ${DR7_MODEL}`, version: "dr7", modalities: SUPPORTED_MODALITIES }];
}
