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

3. Start the mock AI: `npm run mock-ai`. It listens on port 4100. Not needed with `AI_PROVIDER=dr7`.
4. Start the backend: `npm run dev`. It listens on port 4000.
5. Lint: `npm run lint`

MongoDB creates the database and its collections when the first study arrives from Orthanc. Until then, the database does not show in Compass.

### Optional settings (`config/dev.env`)

| Variable | Default | Purpose |
|---|---|---|
| `ORTHANC_URL` | `http://localhost:8042` | Orthanc REST address. The backend reads image files and the safety-net change feed here. The new Orthanc compose maps it to `http://localhost:8043`. |
| `ORTHANC_USERNAME` / `ORTHANC_PASSWORD` | (none) | Orthanc basic-auth user |
| `ORTHANC_POLL_MS` | `60000` | Time between safety-net polls of the Orthanc change feed |
| `AUTO_ANALYZE` | `true` | Start the AI analysis when a new visit arrives |
| `AI_PROVIDER` | (mock) | AI provider: unset for the mock AI API, `dr7` for dr7.ai. See AI providers. |
| `AI_API_KEY` | (none) | dr7.ai API key, sent as a Bearer token. Required when `AI_PROVIDER=dr7`. Keep it in `config/dev.env` only. |
| `DR7_BASE_URL` | `https://dr7.ai/api/v1/medical` | dr7.ai base URL. The backend calls `<base>/chat/completions` and `<base>/models`. |
| `AI_BASE_URL` | `http://localhost:4100` | AI API base URL (mock provider) |
| `AI_MODE` | `chunk` | Default AI mode: `stream` or `chunk` |
| `AI_CHUNK_SIZE` | `5` | Instances per chunk in chunk mode (mock provider) |
| `OHIF_VIEWER_URL` | `http://localhost:8042/ohif/viewer` | Base URL for the viewer links |
| `SCAN_NOT_VIEWED_MINUTES` | `15` | Time after AI completion before a study is flagged `SCAN_NOT_VIEWED` |
| `WATCH_INTERVAL_MS` | `30000` | How often the not-viewed check and the SLA overdue check run |
| `MOCK_AI_PORT` | `4100` | Mock AI port |
| `MOCK_AI_DELAY_MS` | `300` | Mock AI delay between streamed observations |

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
| `studies` | One row per visit's study (StudyInstanceUID): patient ref, accession, modality, description, series (each with `seriesNumber`) and instances, clinical context (`referringPhysician`, `clinicalHistory`, `technique`, `priority`, `patientClass`), `reportedAt`, viewed flag, SLA timer (`sla`: minutes, setAt, setBy, dueAt, overdueAt), radiologist assignment (`assignment`: radiologist ref, assignedAt, assignedBy), Orthanc ID and `orthancLastUpdate` (to skip an unchanged study), AI result (mode, requested model, prompt, model used, observations, ROIs, uncertainty, limitations), `previousAi` (the AI result before the last new run, same fields, one version only). Each observation holds `section`, `title`, `text`, `confidence`, `limitation`, `series`, `instance` (image number) and `source` (`seriesInstanceUid`, `sopInstanceUid`). See Clinical context fields. | `RECEIVED`, `AI_PROCESSING`, `AI_FAILED`, `REPORT_PENDING`, `REPORTED` |
| `reports` | One row per study: patient and study refs, AI suggestions with the reviewer's decision (each with `section`, `title`, `limitation`, `confidence`, `series`, `instance` and `source`, copied from the observation), findings and impression with their source (AI, AI edited by the reviewer, reviewer), `body` (the editor JSON, `null` until the first save), `history` (one entry per reopen: finalisedAt, reviewer, reopenedAt, reopenedBy, reason), `previous` (the draft before the last new run: model, suggestions with their decisions, findings, impression, body, uncertainty, limitations, reviewer, authorship, computedAuthorship, `savedAt`), disclaimer, reviewer | `draft`, `final` |
| `reportimages` | One row per image added to a report: studyInstanceUid, contentType, size, the image bytes | — |
| `radiologists` | One row per radiologist: name (required), email (optional, unique, lowercased), designation, subspecialty, modalities (from CR, DX, CT, MR, US) | `ACTIVE`, `INACTIVE` |
| `events` | Audit and notification log: tag, study, actor, payload | (the tag) |
| `syncstates` | The last Orthanc change number that was processed | — |

The same patient can come back for a new visit. Each visit's study links to the same `patients` row.

### Clinical context fields

Set on each ingest, from the study and its first instance. The push reads that instance's `dicomTags` in the payload. The pull reads `/instances/<id>/simplified-tags`.

| Field | Source |
|---|---|
| `description` | DICOM StudyDescription |
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
| `POST` | `/event/preregister` | Orthanc pushes a stable study here, with its full details. Outside `/api`, to match the Orthanc script. JSON limit 50 MB on this route only. Reply `200` with `data: { studyInstanceUid, result, status }` and `message` `created`, `updated` or `unchanged`. `400` if the body is not the Orthanc payload. `422` with the reason if the study is rejected. |
| `POST` | `/api/studies/sync` | Read the Orthanc change feed now (manual call, and the safety net). `ingested` counts only created or updated studies. |
| `POST` | `/api/studies/:id/retry` | Fetch the study from Orthanc again and re-run the AI. `:id` is the StudyInstanceUID or the Mongo `_id`. Body (all optional): `{ "model": "mr-msk-mock", "mode": "stream", "prompt": "Focus on C5-C6." }`. The prompt is text of at most 2000 characters. |
| `GET` | `/api/models` | The AI models: `id`, `name`, `version`, `modalities`. The list depends on the provider (see AI providers). With dr7, each model also has `category`, `supportsImage` and `minTier`. |
| `GET` | `/api/studies` | List studies. Each summary has `description`, `referringPhysician`, `clinicalHistory`, `technique`, `priority`, `patientClass`, `reportedAt`, `sla`, `assignment` (radiologist populated), `assignedTo` (radiologist id string, or `null`) and `hasPreviousAi` (`true` if a rollback is possible). Filters: `?status=`, `?viewed=true/false`, `?radiologist=<id>` (`400` if not an id) |
| `GET` | `/api/studies/:uid` | One study with its series (each with `seriesNumber`), clinical context fields, AI result, `previousAi`, `sla`, `assignment` (radiologist populated) and `viewerUrl` |
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
| `POST` | `/api/radiologists` | Add a radiologist. Body: `{ name, email, designation, subspecialty, modalities, status }`. Only `name` is required. Reply `201`. `400` on a validation error (for example a missing name or modality `MG`). `409` if the email is already used (case-insensitive). |
| `PATCH` | `/api/radiologists/:id` | Update any of the six fields, for example `{ "status": "INACTIVE" }`. `404` for an unknown id. There is no delete. Set `INACTIVE` instead. |
| `GET` | `/api/me` | The current radiologist, same shape as the list. There is no login. Header `X-User-Id` names the radiologist. Without it, the oldest `ACTIVE` radiologist. `400` for a bad id, `404` if none is found. |
| `GET` | `/api/events` | Poll events. Query: `?since=<eventId>`, `?studyInstanceUid=` |
| `GET` | `/api/events/stream` | SSE stream. Pushes `AI_COMPLETED` and `REPORT_OVERDUE`. After a reconnect, it replays the messages of both tags missed since `Last-Event-ID` or `?since=` |
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

`STUDY_RECEIVED`, `STUDY_REJECTED`, `AI_REQUESTED`, `AI_STREAM_CHUNK`, `AI_CHUNK_SENT`, `AI_COMPLETED`, `AI_FAILED`, `REPORT_PENDING`, `SCAN_VIEWED`, `SCAN_NOT_VIEWED`, `SUGGESTION_ACCEPTED`, `SUGGESTION_EDITED`, `SUGGESTION_DISCARDED`, `REPORT_SAVED`, `REPORT_FINALISED`, `REPORT_EXPORTED`, `SLA_SET`, `REPORT_OVERDUE`, `RADIOLOGIST_ASSIGNED`, `RADIOLOGIST_UNASSIGNED`, `SUGGESTION_RESET`, `REPORT_REOPENED`, `REPORT_IMAGE_ADDED`, `AI_ROLLED_BACK`

Only backend code sets tags, on each action. All of them go to the `events` log. Only `AI_COMPLETED` and `REPORT_OVERDUE` are pushed over SSE.

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
