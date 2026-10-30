# dicom-study-backend

Backend for the **See Better** AI radiology co-pilot (hackathon, Team 1).

The backend pulls new studies from the PACS server (Orthanc) and creates the patient and visit entries. It sends each study to an AI model, by streaming or by chunking. See [docs/ORTHANC_INGEST.md](docs/ORTHANC_INGEST.md) for the full ingest path. It stores the AI draft and tells the webapp through SSE when the AI result is ready. A radiologist then reviews, edits and finalises the report, and the backend exports it as a PDF.

> AI output is a draft for review only. It is never a verified diagnosis. A qualified radiologist must review all clinical content.

## Run locally

Requirements: Node 24 and a local MongoDB. Orthanc, OHIF, the webapp and this backend all run on one machine.

1. `npm install`
2. Create `config/dev.env`. Git ignores this file.

   ```
   PORT=4000
   MONGO_URI=mongodb://localhost:27017/dicom_study
   ```

3. Start the mock AI: `npm run mock-ai`. It listens on port 4100.
4. Start the backend: `npm run dev`. It listens on port 4000.
5. Lint: `npm run lint`

MongoDB creates the database and its collections when the first study arrives from Orthanc. Until then, the database does not show in Compass.

### Optional settings (`config/dev.env`)

| Variable | Default | Purpose |
|---|---|---|
| `ORTHANC_URL` | `http://localhost:8042` | Orthanc REST address |
| `ORTHANC_USERNAME` / `ORTHANC_PASSWORD` | (none) | Orthanc basic-auth user |
| `ORTHANC_POLL_MS` | `60000` | Time between safety-net polls of the Orthanc change feed |
| `AUTO_ANALYZE` | `true` | Start the AI analysis when a new visit arrives |
| `AI_BASE_URL` | `http://localhost:4100` | AI API base URL |
| `AI_MODE` | `chunk` | Default AI mode: `stream` or `chunk` |
| `AI_CHUNK_SIZE` | `5` | Instances per chunk in chunk mode |
| `OHIF_VIEWER_URL` | `http://localhost:8042/ohif/viewer` | Base URL for the viewer links |
| `SCAN_NOT_VIEWED_MINUTES` | `15` | Time after AI completion before a study is flagged `SCAN_NOT_VIEWED` |
| `WATCH_INTERVAL_MS` | `30000` | How often the not-viewed check runs |
| `MOCK_AI_PORT` | `4100` | Mock AI port |
| `MOCK_AI_DELAY_MS` | `300` | Mock AI delay between streamed observations |

## Flow

1. When a study is complete, Orthanc calls `POST /api/studies/sync`. The backend then reads Orthanc's change feed and picks up each `StableStudy`. A 60-second poll, plus one poll at startup, catches any call that was lost.
2. The backend reads the study's tags from Orthanc, stores the patient and the visit, and starts the AI analysis in `stream` or `chunk` mode. It sends the images straight from Orthanc and keeps no copies.
3. The AI result is stored on the study, and a draft report is created. The study status becomes `REPORT_PENDING`.
4. The webapp keeps one SSE connection open to `/api/events/stream`. The stream pushes only `AI_COMPLETED`, which means the AI result and the draft report are ready. Its payload holds the new `status`, the `model` used and the `observations` count. Every other action is recorded in the event log (`GET /api/events`), but it is not pushed.
5. The webapp opens the images in OHIF with `viewerUrl`, and then calls `PUT /api/studies/:uid/viewed`.
6. The webapp opens the reporting screen with `GET /api/studies/:uid/report`.
7. The reviewer accepts, edits or discards each AI suggestion, then saves and finalises the report.
8. The report is exported as a PDF.

## Data model (MongoDB)

| Collection | Holds | Status |
|---|---|---|
| `patients` | One row per DICOM Patient ID: name, sex, birth date | `ACTIVE`, `INACTIVE` |
| `studies` | One row per visit's study (StudyInstanceUID): patient ref, accession, modality, series and instances, viewed flag, AI result (model, observations, ROIs, uncertainty, limitations) | `RECEIVED`, `AI_PROCESSING`, `AI_FAILED`, `REPORT_PENDING`, `REPORTED` |
| `reports` | One row per study: patient and study refs, AI suggestions with the reviewer's decision, findings and impression with their source (AI, AI edited by the reviewer, reviewer), disclaimer, reviewer | `draft`, `final` |
| `events` | Audit and notification log: tag, study, actor, payload | (the tag) |
| `syncstates` | The last Orthanc change number that was processed | — |

The same patient can come back for a new visit. Each visit's study links to the same `patients` row.

## API

All JSON responses use `{ code, message, data }`. `code` is `0` on success and `1` on failure, with a matching HTTP status.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/studies/sync` | Read the Orthanc change feed now. Orthanc calls this when a study is stable. |
| `POST` | `/api/studies/:id/retry` | Fetch the study from Orthanc again and re-run the AI. `:id` is the StudyInstanceUID or the Mongo `_id`. Body (all optional): `{ "model": "mr-msk-mock", "mode": "stream", "prompt": "Focus on C5-C6." }`. The prompt is text of at most 2000 characters. |
| `GET` | `/api/models` | The AI model zoo: `id`, `name`, `version`, `modalities` |
| `GET` | `/api/studies` | List studies. Filters: `?status=`, `?viewed=true/false` |
| `GET` | `/api/studies/:uid` | One study with its series, AI result and `viewerUrl` |
| `POST` | `/api/studies/:uid/analyze` | Run or re-run the AI analysis. Body: `{ "mode": "stream" }` |
| `PUT` | `/api/studies/:uid/viewed` | Mark the scan as viewed. Body: `{ "viewedBy": "..." }` |
| `GET` | `/api/studies/:uid/report` | Reporting screen data: study, AI summary, report |
| `PUT` | `/api/studies/:uid/report` | Save the findings and impression. Body: `{ findings, impression, reviewer, authorship }` (see Authorship) |
| `PATCH` | `/api/studies/:uid/report/suggestions/:observationId` | Decide on one suggestion. Body: `{ decision: accepted/edited/discarded, text, reviewer }` |
| `POST` | `/api/studies/:uid/report/finalise` | Finalise. Every suggestion must have a decision first. Body: `{ reviewer, authorship }` |
| `GET` | `/api/studies/:uid/report/pdf` | PDF export, labelled as a draft or a final reviewed draft |
| `GET` | `/api/patients` | List patients |
| `GET` | `/api/patients/:patientId` | One patient with all visits and reports |
| `GET` | `/api/events` | Poll events. Query: `?since=<eventId>`, `?studyInstanceUid=` |
| `GET` | `/api/events/stream` | SSE stream. Pushes only `AI_COMPLETED`. After a reconnect, it replays the `AI_COMPLETED` messages missed since `Last-Event-ID` or `?since=` |
| `GET` | `/api/events/tags` | All event tags (read-only list, for display in the webapp) |
| `GET` | `/health` | Liveness and database state |

## Authorship (AI vs reviewer share)

Each report holds two values. The decision on which one to use is open (29/10/26).

- `computedAuthorship` (measured by the backend): recalculated on every save, every suggestion decision and the finalise. It counts the words of the final report, made of the kept suggestions, the findings and the impression. A word counts as AI text when it is in the longest word sequence that the final text shares with the AI's original text. Every other word counts as the reviewer's. Discarded suggestions are not counted. Fields: `aiPercent`, `humanPercent`, `aiWords`, `totalWords`, `computedAt`.
- `authorship` (reported by a client): optional on save and finalise, as `{ aiPercent, humanPercent, source }`. Send one percentage or both. They must be numbers from 0 to 100 that add up to 100. `source` is text of at most 50 characters. A save without it keeps the last value.
- A retry clears the reported value and the reviewer, and the new draft starts at 100% AI.
- Both values are on the report, on the `REPORT_SAVED` and `REPORT_FINALISED` events, and in the PDF.

## Event tags

`STUDY_RECEIVED`, `STUDY_REJECTED`, `AI_REQUESTED`, `AI_STREAM_CHUNK`, `AI_CHUNK_SENT`, `AI_COMPLETED`, `AI_FAILED`, `REPORT_PENDING`, `SCAN_VIEWED`, `SCAN_NOT_VIEWED`, `SUGGESTION_ACCEPTED`, `SUGGESTION_EDITED`, `SUGGESTION_DISCARDED`, `REPORT_SAVED`, `REPORT_FINALISED`, `REPORT_EXPORTED`

## AI API contract (the mock implements it)

- **Stream mode:** `POST /v1/analyze/stream`, multipart with `meta` (JSON) and `files`. The reply is NDJSON lines: `model`, `observation`, `roi`, then `done` with the full result.
- **Chunk mode:**
  1. `POST /v1/jobs` with `{ meta, totalChunks }`. The reply holds the `jobId`.
  2. `POST /v1/jobs/:jobId/chunks`, multipart with `index` and `files`, once for each chunk.
  3. `POST /v1/jobs/:jobId/complete`. The reply holds the result.
- **Model list:** `GET /v1/models` lists the mock model zoo, keyed by modality (CR, DX, CT, MR, US).

`meta` holds `studyInstanceUid`, `modality`, `bodyPart`, `series`, and the optional `model` and `prompt` from a retry. Without `model`, the AI picks the first model for the modality. A `model` that does not support the study's modality gets `422`.

The result has this shape: `{ model, observations[], rois[], findings, impression, uncertainty, limitations[] }`.
