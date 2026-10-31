import { Router } from "express";
import { opsDashboard, opsSummary, stagePatients } from "../services/opsReport.js";
import { injectFaults, startSimulation } from "../services/simulator.js";
import { acknowledgeException, assignException, resolveException } from "../services/opsExceptions.js";
import { DEMO_CONTROLS } from "../constants/ops.js";
import { ok, HttpError } from "../utils/http.js";
import { actorName } from "../utils/auth.js";

const router = Router();
const by = (req) => actorName(req, "staff");

function demoOnly(req, res, next) {
  if (!DEMO_CONTROLS) throw new HttpError(403, "Demo controls are off. Set OPS_DEMO_CONTROLS=true to use them.");
  next();
}

router.get("/dashboard", async (req, res) => ok(res, await opsDashboard()));
router.get("/summary", async (req, res) => ok(res, await opsSummary()));
router.get("/stages/:stage", async (req, res) => ok(res, await stagePatients(req.params.stage)));

router.post("/simulation/start", demoOnly, async (req, res) => ok(res, await startSimulation({ count: req.body?.count, by: by(req) }), "started"));
router.post("/simulation/inject", demoOnly, async (req, res) => ok(res, await injectFaults({ types: req.body?.types, by: by(req) }), "injected"));

router.post("/exceptions/:id/acknowledge", async (req, res) => ok(res, await acknowledgeException(req.params.id, by(req)), "acknowledged"));
router.put("/exceptions/:id/assignee", async (req, res) =>
  ok(res, await assignException(req.params.id, { radiologistId: req.body?.radiologistId, by: by(req) }), "assigned")
);
router.post("/exceptions/:id/resolve", async (req, res) => ok(res, await resolveException(req.params.id, { note: req.body?.note, by: by(req) }), "resolved"));

export default router;
