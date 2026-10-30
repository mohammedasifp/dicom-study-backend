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
| `DR7_API_KEY` | (none) | dr7.ai API key, sent as a Bearer token. Required when `AI_PROVIDER=dr7`. Keep it in `config/dev.env` only. |
| `DR7_MODEL` | `medgemma-4b-it` | dr7.ai model |
| `DR7_URL` | `https://dr7.ai/api/v1/medical/chat/completions` | dr7.ai chat completions endpoint |
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
4. The webapp keeps one SSE connection open to `/api/events/stream`. The stream pushes two tags:
   - `AI_COMPLETED`: the AI result and the draft report are ready. Payload: the new `status`, the `model` used and the `observations` count.
   - `REPORT_OVERDUE`: the study's SLA timer ran out before the report was finalised. Payload: `status`, `minutes`, `dueAt`, `overdueAt`.

   Every other action is recorded in the event log (`GET /api/events`), but it is not pushed.
5. The webapp can set an SLA on a study with `PUT /api/studies/:uid/sla`. The watcher checks every `WATCH_INTERVAL_MS` and flags an overdue study once, so the push can be up to that interval late.
6. The webapp opens the images in OHIF with `viewerUrl`, and then calls `PUT /api/studies/:uid/viewed`.
7. The webapp opens the reporting screen with `GET /api/studies/:uid/report`.
8. The reviewer accepts, edits or discards each AI suggestion, then saves and finalises the report.
9. The report is exported as a PDF.

## Data model (MongoDB)

| Collection | Holds | Status |
|---|---|---|
| `patients` | One row per DICOM Patient ID: name, sex, birth date | `ACTIVE`, `INACTIVE` |
| `studies` | One row per visit's study (StudyInstanceUID): patient ref, accession, modality, series and instances, viewed flag, SLA timer (`sla`: minutes, setAt, setBy, dueAt, overdueAt), Orthanc ID and `orthancLastUpdate` (to skip an unchanged study), AI result (mode, requested model, prompt, model used, observations, ROIs, uncertainty, limitations) | `RECEIVED`, `AI_PROCESSING`, `AI_FAILED`, `REPORT_PENDING`, `REPORTED` |
| `reports` | One row per study: patient and study refs, AI suggestions with the reviewer's decision, findings and impression with their source (AI, AI edited by the reviewer, reviewer), disclaimer, reviewer | `draft`, `final` |
| `events` | Audit and notification log: tag, study, actor, payload | (the tag) |
| `syncstates` | The last Orthanc change number that was processed | — |

The same patient can come back for a new visit. Each visit's study links to the same `patients` row.

## API

All JSON responses use `{ code, message, data }`. `code` is `0` on success and `1` on failure, with a matching HTTP status.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/event/preregister` | Orthanc pushes a stable study here, with its full details. Outside `/api`, to match the Orthanc script. JSON limit 50 MB on this route only. Reply `200` with `data: { studyInstanceUid, result, status }` and `message` `created`, `updated` or `unchanged`. `400` if the body is not the Orthanc payload. `422` with the reason if the study is rejected. |
| `POST` | `/api/studies/sync` | Read the Orthanc change feed now (manual call, and the safety net). `ingested` counts only created or updated studies. |
| `POST` | `/api/studies/:id/retry` | Fetch the study from Orthanc again and re-run the AI. `:id` is the StudyInstanceUID or the Mongo `_id`. Body (all optional): `{ "model": "mr-msk-mock", "mode": "stream", "prompt": "Focus on C5-C6." }`. The prompt is text of at most 2000 characters. |
| `GET` | `/api/models` | The AI models: `id`, `name`, `version`, `modalities`. The list depends on the provider (see AI providers). |
| `GET` | `/api/studies` | List studies, each with its `sla`. Filters: `?status=`, `?viewed=true/false` |
| `GET` | `/api/studies/:uid` | One study with its series, AI result, `sla` and `viewerUrl` |
| `POST` | `/api/studies/:uid/analyze` | Run or re-run the AI analysis. Body: `{ "mode": "stream" }` |
| `PUT` | `/api/studies/:uid/viewed` | Mark the scan as viewed. Body: `{ "viewedBy": "..." }` |
| `PUT` | `/api/studies/:uid/sla` | Set the report SLA timer. Body: `{ "minutes": 30, "setBy": "..." }`. `minutes` is a number above 0 and is required. `setBy` is optional. `dueAt` = now + `minutes`. A second call restarts the timer and clears `overdueAt`. `400` for bad `minutes`, `404` for an unknown study, `409` if the report is finalised. |
| `GET` | `/api/studies/:uid/report` | Reporting screen data: study, AI summary, report |
| `PUT` | `/api/studies/:uid/report` | Save the findings and impression. Body: `{ findings, impression, reviewer, authorship }` (see Authorship) |
| `PATCH` | `/api/studies/:uid/report/suggestions/:observationId` | Decide on one suggestion. Body: `{ decision: accepted/edited/discarded, text, reviewer }` |
| `POST` | `/api/studies/:uid/report/finalise` | Finalise. Every suggestion must have a decision first. Body: `{ reviewer, authorship }` |
| `GET` | `/api/studies/:uid/report/pdf` | PDF export, labelled as a draft or a final reviewed draft |
| `GET` | `/api/patients` | List patients |
| `GET` | `/api/patients/:patientId` | One patient with all visits and reports |
| `GET` | `/api/events` | Poll events. Query: `?since=<eventId>`, `?studyInstanceUid=` |
| `GET` | `/api/events/stream` | SSE stream. Pushes `AI_COMPLETED` and `REPORT_OVERDUE`. After a reconnect, it replays the messages of both tags missed since `Last-Event-ID` or `?since=` |
| `GET` | `/api/events/tags` | All event tags (read-only list, for display in the webapp) |
| `GET` | `/health` | Liveness and database state |

## Authorship (AI vs reviewer share)

Each report holds two values. The decision on which one to use is open (29/10/26).

- `computedAuthorship` (measured by the backend): recalculated on every save, every suggestion decision and the finalise. It counts the words of the final report, made of the kept suggestions, the findings and the impression. A word counts as AI text when it is in the longest word sequence that the final text shares with the AI's original text. Every other word counts as the reviewer's. Discarded suggestions are not counted. Fields: `aiPercent`, `humanPercent`, `aiWords`, `totalWords`, `computedAt`.
- `authorship` (reported by a client): optional on save and finalise, as `{ aiPercent, humanPercent, source }`. Send one percentage or both. They must be numbers from 0 to 100 that add up to 100. `source` is text of at most 50 characters. A save without it keeps the last value.
- A retry clears the reported value and the reviewer, and the new draft starts at 100% AI.
- Both values are on the report, on the `REPORT_SAVED` and `REPORT_FINALISED` events, and in the PDF.

## Event tags

`STUDY_RECEIVED`, `STUDY_REJECTED`, `AI_REQUESTED`, `AI_STREAM_CHUNK`, `AI_CHUNK_SENT`, `AI_COMPLETED`, `AI_FAILED`, `REPORT_PENDING`, `SCAN_VIEWED`, `SCAN_NOT_VIEWED`, `SUGGESTION_ACCEPTED`, `SUGGESTION_EDITED`, `SUGGESTION_DISCARDED`, `REPORT_SAVED`, `REPORT_FINALISED`, `REPORT_EXPORTED`, `SLA_SET`, `REPORT_OVERDUE`

Only backend code sets tags, on each action. All of them go to the `events` log. Only `AI_COMPLETED` and `REPORT_OVERDUE` are pushed over SSE.

## AI providers

`AI_PROVIDER` selects the provider. `aiClient.js` routes the analysis and the model list.

- **mock** (default): the AI API contract below. `npm run mock-ai` implements it.
- **dr7** (`AI_PROVIDER=dr7`): dr7.ai, an OpenAI-style chat completions API. Code: `src/services/dr7Client.js`.

### dr7 provider

- **Images:** one image per series, the middle instance by InstanceNumber. At most 4 series.
  - Each image is a JPEG render from Orthanc: `GET /instances/<id>/rendered?width=768&height=768`.
  - It is sent as a base64 data URL.
- **Prompt:** asks for `FINDINGS` (one per line) and `IMPRESSION`. It adds the modality and the body part. A retry prompt is added as "Additional instruction".
- **Stream mode:** one request with all the chosen images, streamed. Each finished line of text is recorded as an `AI_STREAM_CHUNK` event, `{ type: "text", data: <line> }`.
- **Chunk mode:** one request per image, not streamed. One `AI_CHUNK_SENT` event per image, `{ index, totalChunks, instances: 1 }`.
- **Result mapping:**
  - Each findings line becomes an observation (`obs-1`, `obs-2`, ...). Duplicate lines across images are removed.
  - `impression` comes from the `IMPRESSION` section.
  - No ROIs. No confidence values; `uncertainty` says so.
  - `limitations` say how many of the study's images the model saw, and that they were 768 px JPEG renders. A retry prompt is added there too.
- **Model list:** `GET /api/models` returns one model, `DR7_MODEL`, for all supported modalities.
- **Errors** (the study becomes `AI_FAILED`):
  - No key: "DR7_API_KEY is not set"
  - dr7 replies non-2xx: "dr7 <status>: <body>"
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
