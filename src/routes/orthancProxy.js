import { Readable } from "node:stream";
import { ORTHANC_URL, ORTHANC_AUTH } from "../services/orthanc.js";
import { HttpError } from "../utils/http.js";

const FORWARD_REQUEST = ["accept", "range", "if-none-match", "if-modified-since"];
const FORWARD_RESPONSE = ["content-type", "content-range", "accept-ranges", "etag", "last-modified", "cache-control"];

export async function orthancProxy(req, res) {
  if (!["GET", "HEAD"].includes(req.method)) throw new HttpError(405, "Only reads are allowed through the image proxy");
  const headers = Object.fromEntries(FORWARD_REQUEST.filter((h) => req.get(h)).map((h) => [h, req.get(h)]));
  if (ORTHANC_AUTH) headers.authorization = ORTHANC_AUTH;
  headers.forwarded = `host=${req.get("X-Forwarded-Host") || req.get("Host")};proto=${req.get("X-Forwarded-Proto") || req.protocol}`;

  const upstream = await fetch(`${ORTHANC_URL}${req.originalUrl}`, { method: req.method, headers, redirect: "manual" });
  if (upstream.status >= 400) console.warn(`[ORTHANC] proxy ${req.method} ${req.originalUrl.slice(0, 120)} -> ${upstream.status}`);
  res.status(upstream.status);
  for (const h of FORWARD_RESPONSE) if (upstream.headers.get(h)) res.set(h, upstream.headers.get(h));
  if (upstream.headers.get("location")) res.set("location", upstream.headers.get("location"));
  if (!upstream.body || req.method === "HEAD") return res.end();
  Readable.fromWeb(upstream.body).pipe(res);
}
