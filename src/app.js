import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import mongoose from "mongoose";
import studiesRouter from "./routes/studies.js";
import eventsRouter from "./routes/events.js";
import patientsRouter from "./routes/patients.js";
import radiologistsRouter, { authRouter, currentRadiologist } from "./routes/radiologists.js";
import { listModels } from "./services/aiClient.js";
import { ingestPushedStudy } from "./services/studies.js";
import { ok, HttpError } from "./utils/http.js";
import { identify } from "./utils/auth.js";

const app = express();

app.use(helmet());
app.use(cors());
app.use(morgan("dev"));

app.post("/event/preregister", express.json({ limit: "50mb" }), async (req, res) => {
  const result = await ingestPushedStudy(req.body);
  if (result.result === "rejected") throw new HttpError(422, result.reason);
  return ok(res, result, result.result);
});

app.put("/api/studies/:uid/report", express.json({ limit: "15mb" }));
app.post("/api/studies/:uid/report/images", express.json({ limit: "8mb" }));
app.use(express.json({ limit: "1mb" }));

app.get("/health", (req, res) => {
  res.json({ status: "ok", db: mongoose.connection.readyState === 1 ? "up" : "down" });
});

app.use("/api/auth", authRouter);
app.use("/api", identify);
app.use("/api/studies", studiesRouter);
app.use("/api/events", eventsRouter);
app.use("/api/patients", patientsRouter);
app.use("/api/radiologists", radiologistsRouter);
app.get("/api/me", currentRadiologist);
app.get("/api/models", async (req, res) => ok(res, await listModels()));

app.use((req, res) => res.status(404).json({ code: 1, message: "Not found", data: null }));

app.use((err, req, res, _next) => {
  const status = err.status || (err.name === "MulterError" ? 400 : 500);
  if (status >= 500) console.error(err);
  if (res.headersSent) return res.end();
  res.status(status).json({ code: 1, message: status < 500 || err.status ? err.message : "Internal server error", data: null });
});

export default app;
