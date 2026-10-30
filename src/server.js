import app from "./app.js";
import { connectDB, disconnectDB } from "../config/db.js";
import { flagNotViewed, syncFromOrthanc } from "./services/studies.js";

const PORT = process.env.PORT || 4000;
const WATCH_INTERVAL_MS = Number(process.env.WATCH_INTERVAL_MS) || 30000;
const ORTHANC_POLL_MS = Number(process.env.ORTHANC_POLL_MS) || 60000;

async function start() {
  await connectDB();
  const server = app.listen(PORT, () => console.log(`[APP] listening on ${PORT}`));
  const watcher = setInterval(() => flagNotViewed().catch((err) => console.error("[WATCH]", err.message)), WATCH_INTERVAL_MS);

  const sync = () => syncFromOrthanc().catch((err) => console.error("[ORTHANC]", err.message));
  sync();
  const poller = setInterval(sync, ORTHANC_POLL_MS);

  const shutdown = async () => {
    clearInterval(watcher);
    clearInterval(poller);
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
