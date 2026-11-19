# File Converter Physical Drop Box

A Docker-first prototype of the File Converter Drop Box proposal: **press a button, upload to S3, see the status on an LED.** A browser dashboard, Node.js REST API and PostgreSQL run together with Docker Compose.

The physical device and Amazon S3 are **simulated**. Each virtual drop box has a PRESS button and a status LED. A press sends a generated sample CSV file to a simulated S3 input bucket, converts it to JSON into a simulated output bucket, and records every step in PostgreSQL. Failures and offline drop boxes raise P1/P2/P3 incidents automatically.

## Architecture

Browser -> Nginx frontend container -> Node.js API container -> PostgreSQL container

- `web` (Nginx) serves the dashboard on host port 8080 and proxies `/api/` to the API.
- `api` (Node.js / Express) runs the press -> upload -> convert pipeline, the simulated heartbeats and the incident rules.
- `db` (PostgreSQL 16) stores devices, uploads and incidents in the named volume `dropbox_db_data`.
- The simulated S3 buckets (`input/` and `output/`) are folders in the named volume `dropbox_bucket_data`, mounted in the API container at `/data/buckets`.

## Prerequisites

- Docker Desktop (Windows/macOS) or Docker Engine + Docker Compose plugin (Linux)
- A modern web browser

No local Node.js or PostgreSQL installation is required.

## Run locally with Docker

1. Extract this ZIP and open a terminal in the `file-converter-drop-box` folder.
2. Optional: copy `.env.example` to `.env` and change `POSTGRES_PASSWORD`.
3. Build and start:

   ```bash
   docker compose up --build -d
   ```

4. Open the dashboard at **http://localhost:8080**.
5. Check containers with `docker compose ps`; view logs with `docker compose logs -f`.

## LED meaning

| LED | Meaning |
|-----|---------|
| White | Button pressed |
| Blue (pulsing) | Uploading / converting |
| Green | Converted successfully |
| Red | Needs attention; an incident is open |

## Demo flow (about 5 minutes)

1. Show the three drop boxes and the dashboard counters.
2. Press **PRESS** on Drop Box 01: the LED turns white, then blue.
3. The file reaches the input bucket; conversion runs; the LED turns green and the dashboard updates.
4. Choose a failure mode in **Demo failure for next press** and press again:
   - *Fails once, retry succeeds* -> **P3** incident (single failure that retried successfully)
   - *Fails twice* -> LED turns red, **P2** incident (repeated failure on one device)
5. Click **Simulate offline** on a box. After about 30 seconds it is marked offline and a **P2** incident is raised. Take every box offline to raise a **P1** "All drop boxes offline" incident.
6. Click **Resolve** on incidents; refresh the browser to show that history is kept.

## Severity and escalation

| Severity | Trigger in this prototype | Response | Escalate to |
|----------|---------------------------|----------|-------------|
| P1 Critical | All drop boxes offline (pipeline stopped) | Within 15 minutes | On-call engineer, then engineering manager |
| P2 Major | Attempt and retry both fail on one drop box, or one drop box goes offline | Within 1 hour | Support team, then on-call engineer |
| P3 Minor | A single failure that the automatic retry fixed | Next business day | Support team queue |

## API endpoints

- `GET /api/health` - API and database health
- `GET /api/summary` - counters for the dashboard
- `GET /api/devices` - drop boxes with status and LED colour
- `POST /api/devices/:id/press` - button press; optional body `{ "failure": "none|upload|convert", "persistent": false }`
- `POST /api/devices/:id/offline` / `POST /api/devices/:id/online` - simulate losing / regaining the connection
- `GET /api/uploads` - latest 50 uploads
- `GET /api/incidents` - list incidents
- `PATCH /api/incidents/:id/resolve` - resolve an incident
- `DELETE /api/incidents/:id` - delete an incident

Settings (environment variables on the `api` service): `UPLOAD_DELAY_MS`, `CONVERT_DELAY_MS`, `OFFLINE_AFTER_SECONDS`.

## Stop and reset

```bash
docker compose down        # keeps database and bucket volumes
docker compose down -v     # also deletes all demo data
```

## Scope and next steps

This is a proof-of-concept. It does **not** include real ESP32/Raspberry Pi hardware, AWS IoT Core, S3, Lambda, CloudWatch/SNS notifications or Grafana; those belong to the pilot and production phases of the proposal. Do not describe the demo as production monitoring. Before any real deployment: change the default database password, add authentication, use HTTPS, and configure backups.

## Project structure

```text
file-converter-drop-box/
├── docker-compose.yml
├── .env.example
├── README.md
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   └── server.js
└── frontend/
    ├── Dockerfile
    ├── nginx.conf
    ├── package.json
    └── public/
        ├── index.html
        ├── styles.css
        └── app.js
```
