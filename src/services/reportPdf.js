import { isValidObjectId } from "mongoose";
import ReportImage from "../models/ReportImage.js";
import { NO_AI_DISCLAIMER } from "../constants/tags.js";

const INK = "#141b2d";
const MUTED = "#5b6478";
const BORDER = "#e2e6ee";
const HEAD_FILL = "#f3f5f9";
const AUTHOR_INK = { ai: "#6d28d9", reviewer: "#047857" };
const MARGIN = 42;
const TZ = "Asia/Kolkata";

const AGE_TOKEN = /^(\d{1,3})\s*([YMWD])?\s*\/?\s*([MFO])?$/i;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dicomDate(value) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value || "");
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : value || "-";
}

const dateTime = (value) =>
  value
    ? new Date(value).toLocaleString("en-IN", { timeZone: TZ, day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true })
    : "-";

function ageFrom(birthDate, studyDate) {
  const b = /^(\d{4})(\d{2})(\d{2})$/.exec(birthDate || "");
  const s = /^(\d{4})(\d{2})(\d{2})$/.exec(studyDate || "");
  if (!b || !s) return null;
  let years = Number(s[1]) - Number(b[1]);
  if (Number(s[2] + s[3]) < Number(b[2] + b[3])) years -= 1;
  return years >= 0 ? `${years} Y` : null;
}

// Some centres put the age inside the DICOM name, as in "RAHUL^46Y/M" or "SANAM AHMAD 43/F".
export function patientIdentity(patient = {}, studyDate) {
  const parts = (patient.name || "").split(/[\^\s]+/).filter(Boolean);
  const ageToken = parts.map((p) => p.match(AGE_TOKEN)).find(Boolean);
  const kept = parts.filter((p) => !AGE_TOKEN.test(p));
  let tokenSex = ageToken?.[3];
  const last = kept[kept.length - 1];
  if (ageToken && kept.length > 1 && /^[MFO]$/i.test(last)) {
    kept.pop();
    tokenSex ||= last;
  }
  const age = ageFrom(patient.birthDate, studyDate) || (ageToken ? `${ageToken[1]} ${(ageToken[2] || "Y").toUpperCase()}` : "-");
  return { name: kept.join(" ") || "Unknown", age, sex: ["M", "F", "O"].includes(patient.sex) ? patient.sex : tokenSex?.toUpperCase() || "-" };
}

const textOf = (node) => (node.text || "") + (node.content || []).map(textOf).join("");
const marksOf = (node) => new Set((node.marks || []).map((m) => m.type));

const bottom = (doc) => doc.page.height - doc.page.margins.bottom;
const contentWidth = (doc) => doc.page.width - doc.page.margins.left - doc.page.margins.right;

function ensureRoom(doc, height) {
  if (doc.y + height > bottom(doc)) doc.addPage();
}

function table(doc, rows, widths) {
  const x0 = doc.page.margins.left;
  for (const row of rows) {
    let col = 0;
    const cells = row.map((cell) => {
      const span = cell.span || 1;
      const width = widths.slice(col, col + span).reduce((a, b) => a + b, 0);
      const placed = { ...cell, x: x0 + widths.slice(0, col).reduce((a, b) => a + b, 0), width };
      col += span;
      return placed;
    });
    const height = Math.max(...cells.map((c) => doc.font(c.bold ? "Helvetica-Bold" : "Helvetica").fontSize(9).heightOfString(c.text || "-", { width: c.width - 10 }))) + 8;
    ensureRoom(doc, height);
    const y = doc.y;
    for (const c of cells) {
      if (c.fill) doc.rect(c.x, y, c.width, height).fill(c.fill);
      doc.rect(c.x, y, c.width, height).lineWidth(0.6).stroke(BORDER);
      doc.fillColor(INK).font(c.bold ? "Helvetica-Bold" : "Helvetica").fontSize(9).text(c.text || "-", c.x + 5, y + 4, { width: c.width - 10 });
    }
    doc.x = x0;
    doc.y = y + height;
  }
  doc.moveDown(0.6);
}

function sectionTitle(doc, title) {
  ensureRoom(doc, 40);
  doc.moveDown(0.7).fillColor(MUTED).font("Helvetica-Bold").fontSize(8.5).text(title.toUpperCase(), doc.page.margins.left, doc.y, { characterSpacing: 0.8 });
  doc.moveDown(0.35).fillColor(INK);
}

function runs(doc, node, final, prefix = "") {
  const pieces = (node.content || []).flatMap((child) => (child.type === "hardBreak" ? [{ text: "\n", marks: new Set() }] : child.type === "text" ? [{ text: child.text, marks: marksOf(child) }] : []));
  const left = doc.page.margins.left;
  const indent = prefix ? 16 : 0;
  const width = contentWidth(doc) - indent;
  const y = doc.y;
  if (!pieces.length) {
    doc.moveDown(0.5);
    return;
  }
  if (prefix.trim()) {
    doc.font("Helvetica").fontSize(10.5).fillColor(INK).text(prefix, left, y, { width: indent });
    doc.y = y;
  }
  pieces.forEach((p, i) => {
    const bold = p.marks.has("bold");
    const italic = p.marks.has("italic");
    const author = p.marks.has("aiText") ? "ai" : p.marks.has("reviewerText") ? "reviewer" : null;
    doc
      .font(bold && italic ? "Helvetica-BoldOblique" : bold ? "Helvetica-Bold" : italic ? "Helvetica-Oblique" : "Helvetica")
      .fontSize(10.5)
      .fillColor(!final && author ? AUTHOR_INK[author] : INK);
    const options = { continued: i < pieces.length - 1, underline: p.marks.has("underline"), lineGap: 2 };
    if (i === 0) doc.text(p.text, left + indent, y, { ...options, width });
    else doc.text(p.text, options);
  });
  doc.fillColor(INK).moveDown(0.3);
}

async function imageBuffer(src, studyInstanceUid) {
  if (src?.startsWith("data:")) return Buffer.from(src.split(",")[1] || "", "base64");
  const id = /\/report\/images\/([a-f0-9]{24})/.exec(src || "")?.[1];
  if (!id || !isValidObjectId(id)) return null;
  const image = await ReportImage.findOne({ _id: id, studyInstanceUid });
  return image ? Buffer.from(image.data) : null;
}

async function block(doc, node, ctx) {
  switch (node.type) {
    case "heading":
      sectionTitle(doc, textOf(node).trim());
      break;
    case "paragraph":
      ensureRoom(doc, 16);
      runs(doc, node, ctx.final);
      break;
    case "orderedList":
    case "bulletList":
      for (const [i, item] of (node.content || []).entries()) {
        for (const [j, child] of (item.content || []).entries()) {
          ensureRoom(doc, 16);
          const prefix = j > 0 ? " " : node.type === "orderedList" ? `${(node.attrs?.start || 1) + i}.` : "•";
          if (child.type === "paragraph") runs(doc, child, ctx.final, prefix);
          else await block(doc, child, ctx);
        }
      }
      break;
    case "table": {
      const rows = (node.content || []).map((row) => (row.content || []).map((cell) => ({ text: textOf(cell).trim(), bold: cell.type === "tableHeader", fill: cell.type === "tableHeader" ? HEAD_FILL : null })));
      const cols = Math.max(1, ...rows.map((r) => r.length));
      table(doc, rows, Array(cols).fill(contentWidth(doc) / cols));
      break;
    }
    case "image": {
      const buffer = await imageBuffer(node.attrs?.src, ctx.studyInstanceUid).catch(() => null);
      if (!buffer) break;
      const width = Math.min(contentWidth(doc), (node.attrs?.width || 300) * 0.75);
      try {
        const image = doc.openImage(buffer);
        const drawnHeight = (image.height * width) / image.width;
        ensureRoom(doc, drawnHeight + 8);
        doc.image(image, doc.page.margins.left, doc.y, { width });
        doc.y += drawnHeight + 6;
      } catch {
        console.warn(`[REPORT] PDF skipped an image that is not PNG or JPEG for ${ctx.studyInstanceUid}`);
      }
      break;
    }
    case "horizontalRule":
      ensureRoom(doc, 12);
      doc.moveDown(0.3).moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).lineWidth(0.6).stroke(BORDER);
      doc.moveDown(0.3);
      break;
    default:
      for (const child of node.content || []) await block(doc, child, ctx);
  }
}

async function observationList(doc, observations, ctx) {
  if (!observations.length) return;
  await block(doc, { type: "heading", content: [{ type: "text", text: "Observations" }] }, ctx);
  await block(doc, { type: "bulletList", content: observations.map((text) => ({ type: "listItem", content: [paragraph(text)] })) }, ctx);
}

const paragraph = (text) => ({ type: "paragraph", content: text ? [{ type: "text", text }] : [] });

function bodyFromFields(report, study) {
  const findings = report.suggestions.filter((s) => s.section === "findings" && s.decision !== "discarded");
  const impressions = report.suggestions.filter((s) => s.section === "impression" && s.decision !== "discarded");
  const textOfSuggestion = (s) => (s.decision === "edited" && s.reviewerText ? s.reviewerText : s.aiText);
  const heading = (text) => ({ type: "heading", content: [{ type: "text", text }] });
  return {
    type: "doc",
    content: [
      heading("Clinical history"),
      paragraph(study.clinicalHistory),
      heading("Technique"),
      paragraph(study.technique),
      heading("Findings"),
      ...(findings.length ? findings.map((s) => paragraph(textOfSuggestion(s))) : (report.findings?.text || "").split("\n").map(paragraph)),
      heading("Impression"),
      ...(impressions.length
        ? [{ type: "orderedList", content: impressions.map((s) => ({ type: "listItem", content: [paragraph(textOfSuggestion(s))] })) }]
        : (report.impression?.text || "").split("\n").map(paragraph)),
    ],
  };
}

export async function renderReportPdf(doc, { report, study, exportedAt = new Date() }) {
  const final = report.status === "final";
  const disclaimer = report.model?.id ? report.disclaimer : NO_AI_DISCLAIMER;
  const patient = patientIdentity(study.patient || {}, study.studyDate);
  const ctx = { final, studyInstanceUid: report.studyInstanceUid };
  const left = MARGIN;

  if (!final) {
    doc.save().rotate(-24, { origin: [doc.page.width / 2, doc.page.height / 2] });
    doc.fillColor("#c62828").fillOpacity(0.08).font("Helvetica-Bold").fontSize(54).text("DRAFT · NOT REVIEWED", 0, doc.page.height / 2 - 30, { width: doc.page.width, align: "center" });
    doc.restore().fillOpacity(1);
    doc.x = left;
    doc.y = MARGIN;
  }

  const title = study.description || [study.modality, study.bodyPart].filter(Boolean).join(" ") || "Radiology report";
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(17).text(title, left, doc.y, { width: contentWidth(doc) - (final ? 0 : 140) });
  if (!final) doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#b26a00").text(report.model?.id ? "AI DRAFT (UNDER REVIEW)" : "DRAFT (UNDER REVIEW)", doc.page.width - MARGIN - 140, MARGIN + 4, { width: 140, align: "right" });
  doc.fillColor(MUTED).font("Helvetica").fontSize(9).text(`Radiology report · ${study.modality || "-"}`, left, doc.y + 2);
  doc.moveDown(0.8);

  if (!final && disclaimer) {
    const height = doc.font("Helvetica").fontSize(9).heightOfString(disclaimer, { width: contentWidth(doc) - 16 }) + 10;
    doc.roundedRect(left, doc.y, contentWidth(doc), height, 4).fillAndStroke("#fff4e0", "#f3d9a4");
    doc.fillColor("#6b4500").text(disclaimer, left + 8, doc.y + 5, { width: contentWidth(doc) - 16 });
    doc.y += 6;
    doc.moveDown(0.6);
  }

  const w = contentWidth(doc);
  const label = (text) => ({ text, bold: true, fill: HEAD_FILL });
  const rows = [
    [label("Patient"), { text: patient.name }, label("Patient ID"), { text: study.patient?.patientId }, label("Age / Sex"), { text: `${patient.age} / ${patient.sex}` }],
    [label("Study date"), { text: dicomDate(study.studyDate) }, label("Accession"), { text: study.accessionNumber }, label("Referred by"), { text: study.referringPhysician }],
  ];
  if (!final && report.model?.name) {
    rows.push([label("AI model"), { text: `${report.model.name}${/^\d/.test(report.model.version || "") ? ` v${report.model.version}` : ""}`, span: 3 }, label("Draft generated"), { text: dateTime(study.ai?.completedAt || report.createdAt) }]);
  }
  table(doc, rows, [0.12, 0.22, 0.13, 0.2, 0.13, 0.2].map((f) => f * w));

  const body = report.body?.content?.length ? report.body : bodyFromFields(report, study);
  const observations = report.suggestions.filter((s) => s.decision !== "discarded").map((s) => (s.decision === "edited" && s.reviewerText ? s.reviewerText : s.aiText));
  const isFindings = (node) => node.type === "heading" && /^findings$/i.test(textOf(node).trim());
  const observationsAt = body.content.some(isFindings) ? body.content.findIndex(isFindings) : body.content.length;
  for (const [i, node] of body.content.entries()) {
    if (i === observationsAt) await observationList(doc, observations, ctx);
    await block(doc, node, ctx);
  }
  if (observationsAt === body.content.length) await observationList(doc, observations, ctx);

  if (!final && report.suggestions.length) {
    sectionTitle(doc, "AI suggestions");
    table(
      doc,
      [
        ["#", "Observation", "Source image", "Confidence", "Review"].map((t) => ({ text: t, bold: true, fill: HEAD_FILL })),
        ...report.suggestions.map((s, i) => [
          { text: String(i + 1) },
          { text: s.title || s.aiText },
          { text: s.instance ? `Series ${s.series} · image ${s.instance}` : "Study level" },
          { text: typeof s.confidence === "number" ? `${Math.round(s.confidence * 100)}%` : "-" },
          { text: s.decision },
        ]),
      ],
      [0.06, 0.4, 0.22, 0.14, 0.18].map((f) => f * w)
    );
    sectionTitle(doc, "AI uncertainty & limitations");
    for (const line of [report.uncertainty, ...(report.limitations || [])].filter(Boolean)) {
      doc.font("Helvetica").fontSize(9).fillColor(INK).text(`•  ${line}`, left, doc.y, { width: w });
    }
  }

  sectionTitle(doc, "Review");
  doc.font("Helvetica").fontSize(10.5).fillColor(INK).text(
    final ? `Reviewed and finalized by ${report.reviewer || "-"} on ${dateTime(report.finalisedAt)}.` : "Not yet reviewed. This document must not be used for clinical decisions.",
    left,
    doc.y,
    { width: w }
  );
  doc.moveDown(0.6).font("Helvetica").fontSize(8).fillColor(MUTED);
  // if (final && disclaimer) doc.text(disclaimer, left, doc.y, { width: w });
  doc.text(`Exported ${dateTime(exportedAt)} · Study UID ${report.studyInstanceUid}`, left, doc.y + 2, { width: w });
}

export const PDF_OPTIONS = { size: "A4", margin: MARGIN };
