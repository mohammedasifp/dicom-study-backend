import app from "./app.js";
import { connectDB, disconnectDB } from "../config/db.js";
import { flagNotViewed, flagOverdue, syncFromOrthanc } from "./services/studies.js";
import { detectExceptions } from "./services/opsExceptions.js";
import { startSimulator, stopSimulator } from "./services/simulator.js";

const PORT = process.env.PORT || 4000;
const WATCH_INTERVAL_MS = Number(process.env.WATCH_INTERVAL_MS) || 30000;
const ORTHANC_POLL_MS = Number(process.env.ORTHANC_POLL_MS) || 60000;

async function start() {
  await connectDB();
  const server = app.listen(PORT, () => console.log(`[APP] listening on ${PORT}`));
  const watch = async () => {
    await flagNotViewed().catch((err) => console.error("[WATCH]", err.message));
    await flagOverdue().catch((err) => console.error("[SLA]", err.message));
    await detectExceptions().catch((err) => console.error("[OPS]", err.message));
  };
  const watcher = setInterval(watch, WATCH_INTERVAL_MS);
  startSimulator().catch((err) => console.error("[SIM]", err.message));

  const sync = () => syncFromOrthanc().catch((err) => console.error("[ORTHANC]", err.message));
  sync();
  const poller = setInterval(sync, ORTHANC_POLL_MS);

  const shutdown = async () => {
    clearInterval(watcher);
    clearInterval(poller);
    stopSimulator();
    server.close();
    server.closeAllConnections();
    await disconnectDB();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start().catch((err) => {
  console.error("[APP] failed to start", err.message);
  process.exit(1);
});
