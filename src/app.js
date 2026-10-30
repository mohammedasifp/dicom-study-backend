import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import mongoose from "mongoose";
import studiesRouter from "./routes/studies.js";
import eventsRouter from "./routes/events.js";
import patientsRouter from "./routes/patients.js";
import { listModels } from "./services/aiClient.js";
import { ingestPushedStudy } from "./services/studies.js";
import { ok, HttpError } from "./utils/http.js";

const app = express();

app.use(helmet());
app.use(cors());
app.use(morgan("dev"));

app.post("/event/preregister", express.json({ limit: "50mb" }), async (req, res) => {
  const result = await ingestPushedStudy(req.body);
  if (result.result === "rejected") throw new HttpError(422, result.reason);
  return ok(res, result, result.result);
});

app.use(express.json({ limit: "1mb" }));

app.get("/health", (req, res) => {
  res.json({ status: "ok", db: mongoose.connection.readyState === 1 ? "up" : "down" });
});

app.use("/api/studies", studiesRouter);
app.use("/api/events", eventsRouter);
app.use("/api/patients", patientsRouter);
app.get("/api/models", async (req, res) => ok(res, await listModels()));

app.use((req, res) => res.status(404).json({ code: 1, message: "Not found", data: null }));

app.use((err, req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  if (res.headersSent) return res.end();
  res.status(status).json({ code: 1, message: err.status ? err.message : "Internal server error", data: null });
});

export default app;
