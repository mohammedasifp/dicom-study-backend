# dicom-study-backend

Backend for the **See Better** AI radiology co-pilot (hackathon, Team 1).

The PACS server (Orthanc) pushes each complete study to the backend, and the backend creates the patient and visit entries. It sends each study to an AI model, by streaming or by chunking. See [docs/ORTHANC_INGEST.md](docs/ORTHANC_INGEST.md) for the full ingest path. It stores the AI draft and tells the webapp through SSE when the AI result is ready, and when a report is overdue. A radiologist then reviews, edits and finalises the report, and the backend exports it as a PDF.

> AI output is a draft for review only. It is never a verified diagnosis. A qualified radiologist must review all clinical content.

## Run locally

Requirements: Node 24 and a local MongoDB. Orthanc, OHIF, the webapp and this backend all run on one machine.

1. `npm install`
2. Create `config/dev.env`. Git ignores this file.

   ```
   PORT=4000
   MONGO_URI=mongodb://localhost:27017/dicom_study
   ```

3. Start Orthanc (see below).
4. Start the mock AI: `npm run mock-ai`. It listens on port 4100. Needed when `AI_PROVIDER=mock` (the default), not with `AI_PROVIDER=dr7`.
5. Add the test radiologists: `npm run seed` (see Auth).
6. Start the backend: `npm run dev`. It listens on port 4000.
7. Start the webapp (see below).
8. Lint: `npm run lint`

MongoDB creates the database and its collections when the first study arrives from Orthanc. Until then, the database does not show in Compass.

### Orthanc

- Folder: `Desktop\Appzoy POC\orthanc`. It holds the `Dockerfile`, `callbackEvent.py`, `SVAIMcOre.json`, `docker-compose.yml`, `start.sh` and `.env` (the push secret; keep it private).
- Start, inside WSL: `bash start.sh`. It sets `BACKEND_HOST_IP` to the Windows host (the WSL default gateway; `host.docker.internal` does not work with Docker Engine in WSL) and runs `docker compose -p svaim up --build -d`.
- Project name `svaim`. Restart policy `unless-stopped`.
- Ports: `8042` (HTTP), `4242` (DICOM).
- External volume `svaim_orthanc-storage` on `/var/lib/orthanc/storage`. The studies stay when the container is recreated.
- `STUDY_API_HOST=backend-host:4000`, `STUDY_API_PATH=/event/preregister`. So Orthanc pushes each stable study to this backend.
- **Push secret:** `callbackEvent.py` sends `X-Push-Secret` from `ORTHANC_PUSH_SECRET` (orthanc folder `.env`). The backend rejects a push with a wrong or missing secret with `401`. The value in `config/dev.env` must match. Without `ORTHANC_PUSH_SECRET` in the backend, any caller may push, and the backend logs a warning.
- `SVAIMcOre.json` has no `DicomWeb.Host`. Orthanc then builds its DICOMweb links from the `Forwarded` header, which the image proxy sets to the browser's host.
- The backend needs `ORTHANC_USERNAME` and `ORTHANC_PASSWORD` in `config/dev.env`: a user from `RegisteredUsers` in `SVAIMcOre.json`. Without them the push still creates the visit, but the safety-net pull and the AI image download get `401`, and the study shows `AI_FAILED`.
- At startup the backend logs one line: `[ORTHANC] <url>, basic auth set` (or `not set`). It prints no user name or password. Check it when Orthanc gives `401`.
- Orthanc `401` with basic auth set: the `ORTHANC_USERNAME` value does not match a user in `RegisteredUsers`.

### Webapp

- Repo `Desktop\Appzoy POC\dicom-study`.
- `npm install`, then `npm run dev`. Vite listens on port 5173.
- Vite sends `/api`, `/ohif`, `/dicom-web` and `/wado` to the backend (`BACKEND_URL`, port 4000). The webapp has no Orthanc address or password. See Image proxy.
- Sign in with a seeded username and the password that `npm run seed` printed (see Auth).
- Branch `backend-login`: the webapp has no hard-coded logins and no mock sign-in. The auth source is `backend` by default (or `http`).
- After you delete webapp modules, Vite can serve a stale module, for example "does not provide an export named 'login'". Restart Vite with `--force`.

### Optional settings (`config/dev.env`)

| Variable | Default | Purpose |
|---|---|---|
| `ORTHANC_URL` | `http://localhost:8042` | Orthanc REST address. The backend reads image files and the safety-net change feed here. Our compose serves Orthanc on both 8042 and 8043. |
| `ORTHANC_USERNAME` / `ORTHANC_PASSWORD` | (none) | Orthanc basic-auth user |
| `ORTHANC_POLL_MS` | `60000` | Time between safety-net polls of the Orthanc change feed |
| `AUTO_ANALYZE` | `true` | Start the AI analysis when a new visit arrives |
| `AI_PROVIDER` | `mock` | AI provider: `mock` for the mock AI API, `dr7` for dr7.ai. Any other value stops the backend at startup. It logs `[AI] provider <name>`. See AI providers. |
| `ORTHANC_PUSH_SECRET` | (none) | Shared secret that Orthanc sends as `X-Push-Secret` on `/event/preregister`. Must match the orthanc folder's `.env`. |
| `AI_DAILY_LIMIT` | `100` | Most AI analyses in any 24 hours, all studies. See AI guard rails. |
| `AI_PER_STUDY_DAILY_LIMIT` | `5` | Most AI analyses of one study in any 24 hours |
| `AI_MAX_CONCURRENT` | `3` | Most AI analyses running at once |
| `AI_MIN_CREDIT_USD` | `1` | dr7 only: refuse new analyses when dr7's remaining credit falls below this |
| `DR7_MAX_TOKENS` | `2000` | `max_tokens` per dr7 call. 800 was too low: replies were cut off mid-JSON. |
| `DR7_TIMEOUT_MS` | `120000` | Timeout per dr7 call |
| `AI_API_KEY` | (none) | dr7.ai API key, sent as a Bearer token. Required when `AI_PROVIDER=dr7`. Keep it in `config/dev.env` only. |
| `DR7_BASE_URL` | `https://dr7.ai/api/v1/medical` | dr7.ai base URL. The backend calls `<base>/chat/completions` and `<base>/models`. |
| `AI_BASE_URL` | `http://localhost:4100` | AI API base URL (mock provider) |
| `AI_MODE` | `chunk` | Default AI mode: `stream` or `chunk` |
| `AI_CHUNK_SIZE` | `5` | Instances per chunk in chunk mode (mock provider) |
| `OHIF_VIEWER_URL` | `/ohif/viewer` | Base URL for the viewer links. Relative, so the link goes through the image proxy. |
| `SCAN_NOT_VIEWED_MINUTES` | `15` | Time after AI completion before a study is flagged `SCAN_NOT_VIEWED` |
| `WATCH_INTERVAL_MS` | `30000` | How often the not-viewed check and the SLA overdue check run |
| `MOCK_AI_PORT` | `4100` | Mock AI port |
| `MOCK_AI_DELAY_MS` | `300` | Mock AI delay between streamed observations |
| `AUTH_SECRET` | (development secret) | Secret that signs the sign-in tokens. Without it the backend uses a fixed development secret and logs a warning. Set it outside local dev. |
| `SIM_ENABLED` | `true` | Run the operations simulator in the backend. `false` turns it off; live studies are still monitored. See Operations. |
| `SIM_PATIENTS` | `50` | Simulated patients created when the simulator starts with none |
| `SIM_FAULT_EVERY_MINUTES` | `5` | The simulator injects one random failure this often. `0` turns automatic failures off. |
| `OPS_DEMO_CONTROLS` | `false` | `true` shows the **Inject failures** button on the Operations page and allows `/api/ops/simulation/inject` and `/start`. Leave off outside demos. |
| `SIM_TICK_MS` | `20000` | Operations simulator: time between steps |
| `SIM_ADVANCE_PER_TICK` | `2` | Operations simulator: simulated patients moved one stage per step |
| `OPS_SCAN_GRACE_MINUTES` / `OPS_PACS_GRACE_MINUTES` / `OPS_PARTIAL_GRACE_MINUTES` / `OPS_NOT_VIEWED_MINUTES` / `OPS_DELIVERY_GRACE_MINUTES` | `30` / `15` / `10` / `30` / `60` | Exception rule thresholds. See Operations. |
| `OPS_TIME_ZONE` | `Asia/Kolkata` | Time zone of the clock times in exception descriptions |
| `SEED_PASSWORD` | (none: a random password per radiologist) | When set, `npm run seed` gives all 4 test radiologists this password |

## Auth (password sign-in)

Changed 30/10/26. This replaces the identity-only login.

- A radiologist signs in with a `username` and a password. Usernames are unique and lowercase.
- The backend stores only a password hash (`passwordHash`): scrypt, as `salt:hash`. The field is not selected by default and is never returned.
- `POST /api/auth/login` `{ username, password }` returns `{ token, user }`.
  - The username is matched case-insensitively.
  - A missing username or password: `400`.
  - A wrong username, a wrong password, or an `INACTIVE` radiologist: `401` "Invalid username or password". The message is the same for all, so it does not tell which part was wrong.
- **Token format:** `<payload>.<signature>`.
  - `payload` is base64url JSON `{ sub, exp }`. `sub` is the radiologist id. `exp` is now + 12 hours.
  - `signature` is HMAC-SHA256 of the payload with `AUTH_SECRET`, base64url.
  - Without `AUTH_SECRET`, a fixed development secret is used and the server logs a warning. Set `AUTH_SECRET` outside local dev.
- The client sends the token as `Authorization: Bearer <token>`.
- **Session cookie** (changed 30/10/26): login also sets the same token as cookie `sb_session` (HttpOnly, SameSite=Lax, path `/`, 12 hours). `<img>`, `EventSource` and the OHIF iframe cannot send a header, so they rely on it.
  - The cookie is read **only on GET and HEAD**. Writes need the Bearer header, so a cross-site form cannot act with the cookie (CSRF).
  - A request with a valid Bearer token and no matching cookie gets the cookie set. So a session from before this change gains the cookie on its next API call.
- **Sign-in is required on every route** (changed 30/10/26), except `POST /api/auth/login`, `POST /api/auth/logout`, `/health` and the Orthanc push `/event/preregister` (which has its own push secret):
  - No token: `401` "Sign in first". This covers all `/api` routes and the image proxy.
  - A forged, expired or unreadable token, or one that names an inactive or deleted radiologist: `401` "Session is not valid".
  - A valid token: the request carries the signed-in radiologist.
- `GET /api/me`: the signed-in radiologist. The `X-User-Id` header is no longer read.
- **Actor names:** the backend takes the name from the signed-in radiologist and ignores the body value. This applies to `reviewer` (save, decide, finalise, reopen), `viewedBy`, `setBy` (SLA), `assignedBy` and `rolledBackBy`.
- `POST /api/auth/logout` clears the cookie. Tokens are stateless: the client drops the token, and a copied token stays valid until it expires.
- Radiologist create and update accept `password`. It must be text of at least 6 characters, else `400`. Only the hash is stored.
- `POST /api/radiologists` and `PATCH /api/radiologists/:id` need a signed-in user (Bearer token). Without one: `401` "Sign in to change radiologists". Reason: the backend is reachable on ngrok. Changed 30/10/26.
- **Not production-grade:** no rate limit on sign-in, no token revocation, no refresh. The cookie has no `Secure` flag, so it also travels over plain HTTP.

## Image proxy

Changed 30/10/26. `/ohif`, `/dicom-web` and `/wado` are forwarded to Orthanc (`ORTHANC_URL`) with the backend's Orthanc login. Code: `src/routes/orthancProxy.js`.

- Needs a session (cookie or Bearer), else `401`.
- `GET` and `HEAD` only. Other methods: `405`. So STOW (upload) is not possible through the proxy; upload in Orthanc Explorer 2 instead.
- Mounted before `helmet`, so Orthanc's own headers reach OHIF unchanged.
- Sends `Forwarded: host=<browser host>;proto=<proto>` (from `X-Forwarded-Host` when a proxy such as Vite sits in front). Orthanc builds its DICOMweb links from it.

Test accounts: `npm run seed` (`scripts/seed-radiologists.js`) upserts 4 radiologists by username. Changed 30/10/26:

- Each run sets a new random password for each radiologist and prints it once, next to the username. Keep the output: the password is not shown again.
- With `SEED_PASSWORD` set, all 4 get that password. The output then shows `(SEED_PASSWORD)`, not the value.
- Every run resets all 4 passwords.

| Username | Name | Subspecialty | Modalities |
|---|---|---|---|
| `dr.kavya.rao` | Dr. Kavya Rao | Neuro | CT, MR |
| `dr.arjun.menon` | Dr. Arjun Menon | Body | CT, MR, US |
| `dr.jhansi.reddy` | Dr. Jhansi Reddy | MSK | CR, DX, MR |
| `dr.sameer.khan` | Dr. Sameer Khan | Chest | CR, DX, CT |

A new seeded row starts `ACTIVE`. A second run updates the rows, resets the passwords, and keeps their status.

## Flow

1. When a study is complete, Orthanc's `callbackEvent.py` sends the full study (study, patient, series and instance tags) to `POST /event/preregister`. A 60-second poll of Orthanc's change feed, plus one poll at startup, is the safety net for a push that was lost.
2. The backend stores the patient and the visit from that payload. It skips a study that did not change since the last ingest, so the push and the poll do not record it twice. It then starts the AI analysis in `stream` or `chunk` mode. It sends the images straight from Orthanc and keeps no copies.
3. The AI result is stored on the study, and a draft report is created. The study status becomes `REPORT_PENDING`.
   - A retry or a new analysis replaces the AI result and the draft. If the current AI result completed, the backend first keeps it as one previous version (see AI rollback).
   - `POST /api/studies/:uid/ai/rollback` swaps the current and the previous version. A second rollback goes forward again.
4. The webapp keeps one SSE connection open to `/api/events/stream`. The stream pushes two tags:
   - `AI_COMPLETED`: the AI result and the draft report are ready. Payload: the new `status`, the `model` used and the `observations` count.
   - `REPORT_OVERDUE`: the study's SLA timer ran out before the report was finalised. Payload: `status`, `minutes`, `dueAt`, `overdueAt`.

   Every other action is recorded in the event log (`GET /api/events`), but it is not pushed.
5. The webapp can set an SLA on a study with `PUT /api/studies/:uid/sla`. The watcher checks every `WATCH_INTERVAL_MS` and flags an overdue study once, so the push can be up to that interval late.
   - The webapp can also assign a radiologist with `PUT /api/studies/:uid/assignment`. An optional `tatMinutes` (turnaround time) sets the same SLA timer, so TAT = SLA. When the TAT runs out, the watcher pushes `REPORT_OVERDUE`.
   - `PUT /api/studies/:uid/assignment` with `radiologistId: null` removes the assignment.
6. The webapp opens the images in OHIF with `viewerUrl`, and then calls `PUT /api/studies/:uid/viewed`.
7. The webapp opens the reporting screen with `GET /api/studies/:uid/report`.
8. The reviewer accepts, edits or discards each AI suggestion. `decision: "pending"` undoes a decision.
9. The reviewer saves the report. The save holds the editor document (`body`) and the findings and impression text. Images go to `POST /api/studies/:uid/report/images`, and `body` holds their URLs.
10. The reviewer finalises the report. The study status becomes `REPORTED` and `reportedAt` is set. `POST /api/studies/:uid/report/reopen` sets it back to a draft.
11. The report is exported as a PDF.

## Data model (MongoDB)

| Collection | Holds | Status |
|---|---|---|
| `patients` | One row per DICOM Patient ID: name, sex, birth date | `ACTIVE`, `INACTIVE` |
| `studies` | One row per visit's study (StudyInstanceUID): patient ref, accession, modality, `studyDate`, `studyTime` (DICOM StudyTime, for example `094647.000000`), description, series (each with `seriesNumber`) and instances, clinical context (`referringPhysician`, `clinicalHistory`, `technique`, `priority`, `patientClass`), `reportedAt`, viewed flag, SLA timer (`sla`: minutes, setAt, setBy, dueAt, overdueAt), radiologist assignment (`assignment`: radiologist ref, assignedAt, assignedBy), Orthanc ID and `orthancLastUpdate` (to skip an unchanged study), AI result (mode, requested model, prompt, model used, observations, ROIs, uncertainty, limitations), `previousAi` (the AI result before the last new run, same fields, one version only). Each observation holds `section`, `title`, `text`, `confidence`, `limitation`, `series`, `instance` (image number) and `source` (`seriesInstanceUid`, `sopInstanceUid`). See Clinical context fields. | `RECEIVED`, `AI_PROCESSING`, `AI_FAILED`, `REPORT_PENDING`, `REPORTED` |
| `reports` | One row per study: patient and study refs, AI suggestions with the reviewer's decision (each with `section`, `title`, `limitation`, `confidence`, `series`, `instance` and `source`, copied from the observation), findings and impression with their source (AI, AI edited by the reviewer, reviewer), `body` (the editor JSON, `null` until the first save), `history` (one entry per reopen: finalisedAt, reviewer, reopenedAt, reopenedBy, reason), `previous` (the draft before the last new run: model, suggestions with their decisions, findings, impression, body, uncertainty, limitations, reviewer, authorship, computedAuthorship, `savedAt`), disclaimer, reviewer | `draft`, `final` |
| `reportimages` | One row per image added to a report: studyInstanceUid, contentType, size, the image bytes | â€” |
| `radiologists` | One row per radiologist: name (required), `username` (optional, unique, lowercased, used to sign in), `passwordHash` (scrypt `salt:hash`, never returned), email (optional, unique, lowercased), designation, subspecialty, modalities (from CR, DX, CT, MR, US) | `ACTIVE`, `INACTIVE` |
| `events` | Audit and notification log: tag, study, actor, payload | (the tag) |
| `syncstates` | The last Orthanc change number that was processed | â€” |
| `centrecases` | One row per simulated patient (Operations): `caseNumber` (`SIM-001`), patient, accession, modality, description, priority, `stage`, a timestamp per stage (`registeredAt`, `scheduledAt`, `acquiredAt`, `pacsAt`, `viewedAt`, `reportedAt`, `deliveredAt`), `dueAt`, `expectedImages` / `receivedImages`, `pacsPatient` (the ID and name the images carry), `fault` (the injected failure) | `REGISTERED`, `ACQUIRED`, `IN_PACS`, `REPORTED`, `DELIVERED` |
| `opsexceptions` | One row per detected problem: `type`, `severity`, `stage` (impacted workflow stage), `caseStage`, `ref` (`case` + case number, or `study` + StudyInstanceUID), patient, `startedAt`, `detectedAt`, `detail`, `actions` (suggested steps), `assignee` (a radiologist), acknowledge / resolve fields, `resolutionNote`, `clearedAt`, `history` | `OPEN`, `ACKNOWLEDGED`, `RESOLVED` |

The same patient can come back for a new visit. Each visit's study links to the same `patients` row.

### Clinical context fields

Set on each ingest, from the study and its first instance. The push reads that instance's `dicomTags` in the payload. The pull reads `/instances/<id>/simplified-tags`.

| Field | Source |
|---|---|
| `description` | DICOM StudyDescription |
| `studyTime` | DICOM StudyTime. The webapp combines it with `studyDate` for the scan time. A visit ingested before 30/10/26 has none until it is ingested again. |
| `referringPhysician` | DICOM ReferringPhysicianName. `^` is replaced by spaces. |
| `clinicalHistory` | DICOM AdditionalPatientHistory of the first instance |
| `technique` | Generated: `<modality> <body part>: N series, M images (series descriptions).` |
| `priority` | DICOM RequestedProcedurePriority: STAT gives `STAT`, HIGH or URGENT gives `URGENT`, anything else `ROUTINE` |
| `patientClass` | Always `OP`. There is no DICOM source yet. |
| `seriesNumber` (each series) | DICOM SeriesNumber |
| `reportedAt` | Set on finalise. Cleared on reopen. |

A retry always saves the study again from Orthanc, also when Orthanc `LastUpdate` did not change. So an old visit gets the new fields on its next retry.

## API

All JSON responses use `{ code, message, data }`. `code` is `0` on success and `1` on failure, with a matching HTTP status. An upload error from Multer returns `400` with its message.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/event/preregister` | Orthanc pushes a stable study here, with its full details. Outside `/api`, to match the Orthanc script. Needs header `X-Push-Secret` when `ORTHANC_PUSH_SECRET` is set, else `401`. JSON limit 50 MB on this route only. Reply `200` with `data: { studyInstanceUid, result, status }` and `message` `created`, `updated` or `unchanged`. `400` if the body is not the Orthanc payload. `422` with the reason if the study is rejected. |
| `POST` | `/api/studies/sync` | Read the Orthanc change feed now (manual call, and the safety net). `ingested` counts only created or updated studies. |
| `POST` | `/api/studies/:id/retry` | Fetch the study from Orthanc again and re-run the AI. `:id` is the StudyInstanceUID or the Mongo `_id`. Body (all optional): `{ "model": "mr-msk-mock", "mode": "stream", "prompt": "Focus on C5-C6." }`. The prompt is text of at most 2000 characters. |
| `GET` | `/api/ai/limits` | AI usage against the guard rails: `{ last24h, running, dailyLimit, perStudyDailyLimit, maxConcurrent, minCreditUsd, lastCreditUsd }`. `lastCreditUsd` is the dr7 credit from the last dr7 reply, `null` until one arrives. |
| `DELETE` | `/api/studies/:uid` | Delete a study from the worklist, with its report, report images and, if no other study uses it, its patient. The images stay in Orthanc, and the events stay as the audit trail (plus `STUDY_DELETED`). `404` unknown study. `409` while the AI is running, or when the report is finalised (reopen it first). Changed 30/10/26. A later push of the same study from Orthanc creates it again. |
| `GET` | `/api/models` | The AI models: `id`, `name`, `version`, `modalities`. The list depends on the provider (see AI providers). `502` "AI provider unreachable: <cause>" when the provider cannot be reached. With dr7, each model also has `category`, `supportsImage` and `minTier`. |
| `GET` | `/api/studies` | List studies. Each summary has `studyDate`, `studyTime`, `description`, `referringPhysician`, `clinicalHistory`, `technique`, `priority`, `patientClass`, `reportedAt`, `sla`, `assignment` (radiologist populated), `assignedTo` (radiologist id string, or `null`) `hasPreviousAi` (`true` if a rollback is possible), `ai` (`requestedAt`, `completedAt`, `error`, `failureReason`) and `review` (`{ total, decided }`: AI suggestions in the draft and how many have a decision other than `pending`; `null` when there is no report). `PUT /:uid/assignment` returns the same `review`. Changed 30/10/26. Filters: `?status=`, `?viewed=true/false`, `?radiologist=<id>` (`400` if not an id) |
| `GET` | `/api/studies/:uid` | One study with `studyDate`, `studyTime`, its series (each with `seriesNumber`), clinical context fields, AI result, `previousAi`, `sla`, `assignment` (radiologist populated) and `viewerUrl` |
| `POST` | `/api/studies/:uid/analyze` | Run or re-run the AI analysis. Body: `{ "mode": "stream" }` |
| `POST` | `/api/studies/:uid/ai/rollback` | Go back one AI version. Body: `{ "rolledBackBy": "..." }` (optional). Reply: the study summary. See AI rollback. |
| `PUT` | `/api/studies/:uid/viewed` | Mark the scan as viewed. Body: `{ "viewedBy": "..." }` |
| `PUT` | `/api/studies/:uid/sla` | Set the report SLA timer. Body: `{ "minutes": 30, "setBy": "..." }`. `minutes` is a number above 0 and is required. `setBy` is optional. `dueAt` = now + `minutes`. A second call restarts the timer and clears `overdueAt`. `400` for bad `minutes`, `404` for an unknown study, `409` if the report is finalised. |
| `PUT` | `/api/studies/:uid/assignment` | Assign a radiologist. Body: `{ "radiologistId": "...", "tatMinutes": 30, "assignedBy": "..." }`. `radiologistId` is required. `radiologistId: null` removes the assignment and emits `RADIOLOGIST_UNASSIGNED`. `tatMinutes` (a number above 0) and `assignedBy` are optional. Stores `assignment` and emits `RADIOLOGIST_ASSIGNED`. With `tatMinutes`, it also sets the SLA timer like `PUT /sla` and emits `SLA_SET`. Without it, the current SLA is kept. A second call replaces the radiologist. `400` for a bad id, bad `tatMinutes` or an inactive radiologist. `404` for an unknown radiologist or study. `409` if the report is finalised. |
| `GET` | `/api/studies/:uid/report` | Reporting screen data: study summary, AI result, report (with `body`, `history` and `previous`) |
| `PUT` | `/api/studies/:uid/report` | Save the report. Body: `{ body, findings, impression, reviewer, authorship }` (see Authorship). `body` is the editor JSON object, stored as is. `400` if it is not an object. JSON limit 15 MB on this route. `findings` and `impression` are plain text and are used for authorship. A retry clears `body` with the rest of the draft. |
| `PATCH` | `/api/studies/:uid/report/suggestions/:observationId` | Decide on one suggestion. Body: `{ decision: accepted/edited/discarded/pending, text, reviewer }`. `pending` undoes a decision: it clears `reviewerText` and `decidedAt` and emits `SUGGESTION_RESET`. |
| `POST` | `/api/studies/:uid/report/finalise` | Finalise. Every suggestion must have a decision first. Body: `{ reviewer, authorship }`. Sets the study's `reportedAt`. |
| `POST` | `/api/studies/:uid/report/reopen` | Reopen a final report. Body: `{ reviewer, reason }`. `reason` is text of at most 500 characters. The report goes back to `draft`. The old `finalisedAt` and reviewer, with `reopenedAt`, `reopenedBy` and `reason`, go to `report.history`. The study goes back to `REPORT_PENDING` and `reportedAt` is cleared. Emits `REPORT_REOPENED`. `409` if the report is not final. |
| `POST` | `/api/studies/:uid/report/images` | Add an image to the report. Multipart `file`, or JSON `{ dataUrl }` (JSON limit 8 MB). PNG, JPEG, WebP or GIF, at most 5 MB. Reply `201` with `{ id, url, contentType, size }`. `400` for another type or a bigger file (multipart: "File too large"). `404` for an unknown study. Stored in `reportimages`. Emits `REPORT_IMAGE_ADDED`. |
| `GET` | `/api/studies/:uid/report/images/:imageId` | The image bytes, with its content type. `404` for an unknown image. |
| `GET` | `/api/studies/:uid/report/pdf` | PDF export, labelled as a draft or a final reviewed draft |
| `GET` | `/api/patients` | List patients |
| `GET` | `/api/patients/:patientId` | One patient with all visits (assigned radiologist populated) and reports |
| `GET` | `/api/radiologists` | List radiologists, sorted by name. Filters: `?status=ACTIVE/INACTIVE`, `?modality=CR`. Each radiologist also has `id` (string) and `initials` (from the name, "Dr." dropped). |
| `POST` | `/api/radiologists` | Add a radiologist. Body: `{ name, username, password, email, designation, subspecialty, modalities, status }`. Needs a signed-in user: `401` "Sign in first" without one. Only `name` is required. `password` (optional) must be at least 6 characters, else `400`. Only its hash is stored. Reply `201`. `400` on a validation error (for example a missing name or modality `MG`). `409` if the username or the email is already used (case-insensitive). The message names the field. |
| `PATCH` | `/api/radiologists/:id` | Update any of the seven fields, or set a new `password` (at least 6 characters), for example `{ "status": "INACTIVE" }`. Needs a signed-in user: `401` "Sign in first" without one. `404` for an unknown id. `409` for a used username or email. There is no delete. Set `INACTIVE` instead. |
| `POST` | `/api/auth/login` | Sign in. Body: `{ username, password }`, both required (`400`). Reply `{ token, user }`, and set the `sb_session` cookie. `token` is a signed token valid for 12 hours. `user` has the list shape, without `passwordHash`. `401` "Invalid username or password" for a wrong username, a wrong password or an inactive radiologist. See Auth. |
| `POST` | `/api/auth/logout` | Reply ok and clear the `sb_session` cookie. Nothing is stored on the server. The token stays valid until it expires. |
| `GET` | `/api/me` | The signed-in radiologist, same shape as the list. Header `Authorization: Bearer <token>`. `401` "Sign in first" without a token. `401` "Session is not valid" for a forged or expired token, or an unknown or inactive radiologist. Changed 30/10/26: the `X-User-Id` header and the oldest-active fallback are gone. |
| `GET` | `/api/ops/dashboard` | Operations dashboard: `stages` (per case stage: `count` of simulated patients and live studies, `openExceptions`), `exceptions` (open, acknowledged and resolved today, most urgent first), `counts` (`open`, `acknowledged`, `resolvedToday`, `bySeverity`, `unassigned`), `feed` (last 25 stage changes and exception events), `demoControls` (`true` when `OPS_DEMO_CONTROLS` is on), `disclaimer`. Added 30/10/26. |
| `GET` | `/api/ops/summary` | End-of-day summary since local midnight: `exceptions` (raised, resolved, open, by type, by severity, average minutes to acknowledge and to resolve), `throughput` (reports signed and delivered, average turnaround), `sla` (within target / total / percent), `stages`, `carryOver` (top 10 open), `insights` (sentences), `disclaimer` |
| `POST` | `/api/ops/simulation/start` | Needs `OPS_DEMO_CONTROLS=true`, else `403`. Not in the webapp. Restart the simulator from scratch. Body: `{ "count": 50 }` (5 to 200, default `SIM_PATIENTS`). Deletes all simulated patients and their exceptions first; live studies are not touched. `400` for a bad count. |
| `POST` | `/api/ops/simulation/inject` | Needs `OPS_DEMO_CONTROLS=true`, else `403`. For a live demo: the webapp shows an **Inject failures** button when the setting is on. Inject failures now. Body: `{ "types": ["MISSED_SCAN"] }` (optional; default: missed scan, images not in PACS, ID mismatch, not viewed, report overdue). Each type goes into a different healthy patient. Reply: `[{ type, caseNumber, patient }]`. `400` for an unknown type, `409` when the simulator has no patients or no healthy patient is left. |
| `POST` | `/api/ops/exceptions/:id/acknowledge` | Acknowledge. `409` if already resolved. |
| `PUT` | `/api/ops/exceptions/:id/assignee` | Assign to a radiologist (yourself or another). Body: `{ "radiologistId": "..." }`. Also acknowledges an open exception. `400` bad or inactive id, `404` unknown id, `409` resolved. |
| `POST` | `/api/ops/exceptions/:id/resolve` | Resolve. Body: `{ "note": "what was done" }`, 3 to 500 characters (`400`). Acknowledges first if needed. `409` if already resolved. For a simulated patient, the fix is applied to the patient so it moves on. |
| `GET` | `/api/events` | Poll events. Query: `?since=<eventId>`, `?studyInstanceUid=` |
| `GET` | `/api/events/stream` | SSE stream. Pushes `AI_COMPLETED`, `REPORT_OVERDUE` and the operations tags. After a reconnect, it replays the messages of both tags missed since `Last-Event-ID` or `?since=` |
| `GET` | `/api/events/tags` | All event tags (read-only list, for display in the webapp) |
| `GET` | `/health` | Liveness and database state |

## AI rollback (one step)

- When a new analysis starts (analyze or retry) and the current AI result completed, the backend copies `study.ai` to `study.previousAi`. It copies the report draft to `report.previous`, with `savedAt`.
- The draft copy holds the model, the suggestions with their decisions, findings, impression, `body`, uncertainty, limitations, reviewer, `authorship` and `computedAuthorship`.
- Only one version back is kept.
- A failed run is not a version. If the current run failed, the previous version stays the last successful one.
- `POST /api/studies/:uid/ai/rollback` swaps the current and the previous AI result and report draft. So a second rollback goes forward again. The study status becomes `REPORT_PENDING`.
- If the current run failed, the rollback drops the failed run and clears `previousAi`.
- If the report has no saved previous draft (a draft made before this feature), the draft is rebuilt from the restored AI result. The decisions are reset.
- Emits `AI_ROLLED_BACK` with `{ rolledBackBy, restoredModel, replacedModel }`. Logged, not pushed.
- Errors: `409` "No previous AI output to roll back to". `409` while the analysis runs or when the report is final (same check as analyze and retry). `404` for an unknown study.

## Authorship (AI vs reviewer share)

Each report holds two values. The decision on which one to use is open (29/10/26).

- `computedAuthorship` (measured by the backend): recalculated on every save, every suggestion decision and the finalise. It counts the words of the final report, made of the kept suggestions, the findings and the impression. A word counts as AI text when it is in the longest word sequence that the final text shares with the AI's original text. Every other word counts as the reviewer's. Discarded suggestions are not counted. Fields: `aiPercent`, `humanPercent`, `aiWords`, `totalWords`, `computedAt`.
- `authorship` (reported by a client): optional on save and finalise, as `{ aiPercent, humanPercent, source }`. Send one percentage or both. They must be numbers from 0 to 100 that add up to 100. `source` is text of at most 50 characters. A save without it keeps the last value.
- A retry clears the reported value and the reviewer, and the new draft starts at 100% AI.
- Both values are on the report, on the `REPORT_SAVED` and `REPORT_FINALISED` events, and in the PDF.

## Event tags

`STUDY_RECEIVED`, `STUDY_REJECTED`, `AI_REQUESTED`, `AI_STREAM_CHUNK`, `AI_CHUNK_SENT`, `AI_COMPLETED`, `AI_FAILED`, `REPORT_PENDING`, `SCAN_VIEWED`, `SCAN_NOT_VIEWED`, `SUGGESTION_ACCEPTED`, `SUGGESTION_EDITED`, `SUGGESTION_DISCARDED`, `REPORT_SAVED`, `REPORT_FINALISED`, `REPORT_EXPORTED`, `SLA_SET`, `REPORT_OVERDUE`, `RADIOLOGIST_ASSIGNED`, `RADIOLOGIST_UNASSIGNED`, `SUGGESTION_RESET`, `REPORT_REOPENED`, `REPORT_IMAGE_ADDED`, `AI_ROLLED_BACK`, `STUDY_DELETED`, and for Operations `SIM_STARTED`, `SIM_FAULT_INJECTED`, `CASE_STAGE_CHANGED`, `OPS_EXCEPTION_RAISED`, `OPS_EXCEPTION_ACKNOWLEDGED`, `OPS_EXCEPTION_ASSIGNED`, `OPS_EXCEPTION_RESOLVED`, `OPS_EXCEPTION_CLEARED`

Only backend code sets tags, on each action. All of them go to the `events` log. `AI_COMPLETED`, `REPORT_OVERDUE` and the Operations tags are pushed over SSE.

## AI guard rails

Changed 30/10/26. Code: `src/services/aiGuard.js`. Checked before every analysis (auto, retry and analyze):

- Credit floor (dr7 only): below `AI_MIN_CREDIT_USD`, `503`. The credit comes from dr7's `x-dr7-credit-remaining` header on each reply.
- `AI_DAILY_LIMIT` analyses in the last 24 hours, all studies: `429`.
- `AI_PER_STUDY_DAILY_LIMIT` analyses of one study in the last 24 hours: `429`.
- `AI_MAX_CONCURRENT` analyses running: `429`. A run older than 15 minutes is treated as stale and not counted.
- Counts come from the `AI_REQUESTED` events, so they survive a restart.
- A blocked **automatic** analysis (a new study from Orthanc) does not fail the push: the study becomes `AI_FAILED` with the reason as `ai.error`, and the radiologist can report manually or run the AI later.
- Also: prompts at most 2000 characters, at most 4 images per dr7 analysis, `DR7_MAX_TOKENS` and `DR7_TIMEOUT_MS` per call.

## Operations (simulated centre and exceptions)

Added 30/10/26. Code: `src/services/simulator.js`, `opsExceptions.js`, `opsReport.js`, `src/constants/ops.js`. Webapp: the **Operations** page.

**Simulator.** Runs inside the backend; staff never see or control it. With `SIM_ENABLED` (default on), the backend starts it at boot: if there are no simulated patients it creates `SIM_PATIENTS`, spread over the five stages (registered, scanned, in PACS, reported, delivered), all healthy. Every `SIM_TICK_MS` it moves the `SIM_ADVANCE_PER_TICK` patients that have waited longest one stage on (in PACS takes two steps: viewed, then reported) and emits `CASE_STAGE_CHANGED`. Beyond 10 delivered patients, the oldest is replaced by a new registration, so the centre keeps flowing. Every `SIM_FAULT_EVERY_MINUTES` it injects one random failure into a healthy patient. A patient with a failure does not move until staff resolve it.

To inject failures on demand (live demo), set `OPS_DEMO_CONTROLS=true`: the Operations page then shows an **Inject failures** button (the default five, or one chosen type). The same is `POST /api/ops/simulation/inject` with `{}` or `{ "types": ["ID_MISMATCH"] }`.

**Rules.** Run every `WATCH_INTERVAL_MS`, after every simulator step and after each injection. Simulated patients and live Orthanc studies are both checked:

| Type | Raised when | Impacted stage | Base severity |
|---|---|---|---|
| `MISSED_SCAN` | Registered, and the booked time is `OPS_SCAN_GRACE_MINUTES` past with no scan | Acquisition | High |
| `PACS_TRANSFER_STUCK` | Scanned, and no images in PACS after `OPS_PACS_GRACE_MINUTES` | PACS transfer | High |
| `PARTIAL_TRANSFER` | In PACS with fewer images than acquired, after `OPS_PARTIAL_GRACE_MINUTES` | PACS transfer | Medium |
| `ID_MISMATCH` | The patient ID or name on the images differs from the order | PACS transfer | Critical |
| `NOT_VIEWED` | In PACS and not opened after `OPS_NOT_VIEWED_MINUTES`. Live studies: the existing `SCAN_NOT_VIEWED` flag. | Reporting | Medium |
| `REPORT_OVERDUE` | Past the report due time. Live studies: `sla.dueAt`. Simulated targets: STAT 60 min, urgent 240, routine 24 h from arrival in PACS. | Reporting | High |
| `DELIVERY_PENDING` | Reported, and not delivered after `OPS_DELIVERY_GRACE_MINUTES` | Delivery | Low |

Severity goes up one level for STAT, and one more once the problem is older than the type's `escalateAfter` (in `constants/ops.js`); it is re-checked on every pass. One exception per patient and type while it is open. A resolved live-study exception is never raised again for that study. When the problem stops being detected before anyone resolves it, the exception gets `clearedAt` and stays open: staff still resolve it.

**Human in the loop.** The rules only raise exceptions with a description and suggested steps. Nothing changes until a person acknowledges, assigns or resolves, and resolving needs a note. Every reply carries the disclaimer.

## Logs

- `[ORTHANC] push received: …`, then `[ORTHANC] <push|poll|retry>: study <uid> created|updated|unchanged|rejected …` with patient, modality, series and instance counts, and whether the AI started.
- `[ORTHANC] push refused from <ip>: wrong|missing X-Push-Secret`.
- `[ORTHANC] proxy GET <path> -> <status>` for image-proxy errors (status 400 and up).
- `[AI] study <uid> started|done|failed …`, `[AI] study <uid> not analysed: <guard reason>`.
- `[AI] dr7 <model>: <in> in + <out> out tokens, about $<cost>; credit left $<credit>` for each dr7 call. The cost uses the per-1K prices in `dr7Client.js` (dr7.ai/pricing, 30/10/26).
- `[STUDY] <uid> deleted by <name>`.
- `[SIM] started with <n> patients by <name>`, `[SIM] running with <n> patients, a failure every <m> min` (after a restart), `[SIM] injected <type> into <case>`, `[SIM] off (SIM_ENABLED=false)`.
- `[OPS] <severity> <type> raised for case|study <id> (<patient>)`, `[OPS] <type> for case|study <id> resolved by <name>`.

## AI providers

`AI_PROVIDER` selects the provider. `aiClient.js` routes the analysis and the model list.

- **mock** (default): the AI API contract below. `npm run mock-ai` implements it.
- **dr7** (`AI_PROVIDER=dr7`): dr7.ai, an OpenAI-style chat completions API. Code: `src/services/dr7Client.js`.

### dr7 provider

- **Images:** one image per series, the middle instance by InstanceNumber. At most 4 series.
  - Each image is a JPEG render from Orthanc: `GET /instances/<id>/rendered?width=768&height=768`.
  - It is sent as a base64 data URL.
- **Model list:** `GET <base>/models` with the Bearer key. The docs page names "List Models" but gives no path; the path was found by probing.
  - It returns 18 models, each with `id`, `category`, `supports_image` and `min_tier`.
  - The backend caches the list for 10 minutes.
  - `GET /api/models` returns every model as `{ id, name, version: "dr7", category, supportsImage, minTier, modalities }`.
  - `modalities`: `[]` for a text-only model. `chexagent`: CR, DX. Every other image model: all supported modalities.
  - Image models today: `chexagent`, `llava-med`, `med-flamingo`, `biomedclip`, `medsiglip-v1` (tier `CLINICAL_PLUS`), `med-gemini`. All need tier PRO or higher.
  - `medgemma-4b-it` (the POC model) is text only (`supports_image` false).
- **Model choice:**
  - No model given: CR or DX with body part chest or thorax uses `chexagent`. Everything else uses `med-gemini`.
  - The user picks a model with `POST /api/studies/:id/retry` `{ "model": "..." }`.
  - The retry checks that the model is in the list and supports the study's modality. Otherwise `400`, for example "Model medgemma-4b-it does not support modality CR".
- **Prompt:**
  - The images are labelled "Image 1:", "Image 2:", ... All images are series 1. The image number is the instance number.
  - It adds the modality and the body part. A retry prompt is added as "Additional instruction".
  - The model must reply with JSON only: `{"observations":[{"section","title","text","series":1,"instance":<image number>,"confidence":0-1,"limitation"}],"uncertainty"}`.
  - `section` is `findings` or `impression`. Each impression point is its own observation. `title` is at most 40 characters.
- **Stream mode:** one request with all the chosen images, streamed. Each finished line of text is recorded as an `AI_STREAM_CHUNK` event, `{ type: "text", data: <line> }`.
- **Chunk mode:** one request per image, not streamed. One `AI_CHUNK_SENT` event per image, `{ index, totalChunks, instances: 1 }`.
- **Parsing:**
  - The JSON is read from the first `{` to the last `}`, so a ```` ```json ```` fence works.
  - `confidence` is a number from 0 to 1. A value above 1 is read as a percent (64 becomes 0.64). Any other value is dropped.
  - `instance` must be from 1 to the number of images sent. Otherwise it is empty. When only one image was sent, an observation without an instance uses image 1.
  - An old-style `impression` string becomes one observation with section `impression` and title "Impression".
  - `title` is cut to 40 characters.
  - In chunk mode, `instance` is always the number of the image in that request.
  - An answer that is not valid JSON: each line becomes a finding with no confidence. A limitation line says how many answers were not JSON.
  - Duplicate text in the same section is removed. The first one is kept.
- **Result mapping:**
  - Each finding becomes an observation (`obs-1`, `obs-2`, ...) with `section`, `title`, `confidence`, `limitation`, `series` (1), `instance` and `source` (`seriesInstanceUid` and `sopInstanceUid` of that image).
  - The draft report's suggestions carry the same fields, so the webapp can open the right image. The PDF prints "series 1, image N" next to the confidence.
  - `findings` is `""`. `uncertainty` comes from the model, else "Not stated by the model."
  - No ROIs.
  - `limitations` say how many of the study's images the model saw, and that they were 768 px JPEG renders. A retry prompt is added there too.
- **Failure reason** (changed 30/10/26): an `AI_FAILED` study also gets `ai.failureReason`. `INCOMPLETE_STUDY`: the study has no instances, or no images could be sent. `NO_MODEL`: no model supports the modality. `PROCESSING_ERROR`: anything else. `OUT_OF_SCOPE` exists for the webapp but is never set: a study with no supported modality is rejected at ingest and never listed.
- **Errors** (the study becomes `AI_FAILED`):
  - No key: "AI_API_KEY is not set"
  - dr7 replies non-2xx: "dr7 <status>: <body>". A key below the model's tier gets a 402 or 403 style error.
  - Orthanc cannot render an image: the Orthanc error, for example `415`
- **Limits:** the model sees at most 4 images, not the full DICOM data.

## AI API contract (mock provider)

- **Stream mode:** `POST /v1/analyze/stream`, multipart with `meta` (JSON) and `files`. The reply is NDJSON lines: `model`, `observation`, `roi`, then `done` with the full result.
- **Chunk mode:**
  1. `POST /v1/jobs` with `{ meta, totalChunks }`. The reply holds the `jobId`.
  2. `POST /v1/jobs/:jobId/chunks`, multipart with `index` and `files`, once for each chunk.
  3. `POST /v1/jobs/:jobId/complete`. The reply holds the result.
- **Model list:** `GET /v1/models` lists the mock model zoo. Each model has `id`, `name`, `version` and `modalities`:

  | Model | Modalities |
  |---|---|
  | `cxr-findings-mock` | CR, DX |
  | `ct-segmentation-mock` | CT |
  | `mr-brain-mock` | MR (the default for MR) |
  | `mr-msk-mock` | MR |
  | `us-abdomen-mock` | US |

`meta` holds `studyInstanceUid`, `modality`, `bodyPart`, `series`, and the optional `model` and `prompt` from a retry. Without `model`, the AI picks the first model for the modality. A `model` that does not support the study's modality gets `422`.

The result has this shape: `{ model, observations[], rois[], findings, impression, uncertainty, limitations[] }`.

- **Observation:** `{ id, section, title, text, confidence, localizable, limitation, series, instance, source: { seriesInstanceUid, sopInstanceUid } }`.
  - `section` is `findings` or `impression`. The impression comes as observations with section `impression`, one per point.
  - `source` names the image the model looked at. If the AI gives only `sopInstanceUid`, the backend fills `seriesInstanceUid` from the study.
  - The mock gives a title on every observation, one impression observation, a source image on every observation, and a limitation when confidence is below 0.6.
- **ROI:** `{ observationId, sopInstanceUid, shape, x, y, width, height, imageWidth, imageHeight }`. `shape` is `rect` (default) or `ellipse`. `imageWidth` and `imageHeight` are the size of the coordinate space. The mock uses 512 x 512.
- **`findings`:** free text that adds something beyond the observations, else `""`. It is not the observations joined. The mock sends `""`.
- **`impression`:** an old-style string. The report's impression text uses it only when there are no impression observations. Otherwise the impression text starts as `""`.
