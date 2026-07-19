# Notes — Architecture, Setup, and Known Issues

Context for anyone (including future you) picking this project back up. Reflects the
actual current state of this repo, not an idealized one.

---

## Architecture, in short

```
Android app  --HTTPS-->  Express server (Render, Docker)  --spawns-->  yt-dlp / ffmpeg
                                |
                                v
                        Supabase Storage (public URL)
                        Supabase Postgres (job status)
                                |
                                v
                    Android app downloads the finished file
```

The phone never runs a media binary itself — it only talks to the backend over HTTP and
polls job status. All actual conversion work happens server-side, inside a Docker
container that has `yt-dlp`, `ffmpeg`, Python, and Node installed.

Job status (`processing` / `done` / `failed`) is stored in a Supabase Postgres `jobs`
table, not an in-memory variable — this means status correctly survives a Render
restart/redeploy. See `BACKEND_TODO.md` for the table schema if it needs recreating.

---

## Environment variables & secrets (Render → Environment tab)

| Name | Type | Value |
|---|---|---|
| `SUPABASE_URL` | Environment Variable | Your Supabase project URL (Project Settings → API) |
| `SUPABASE_SERVICE_KEY` | Environment Variable | The `service_role` key, **not** `anon` — needed for both Storage and Postgres writes |

Cookie-related environment variables and secret files (`COOKIES_PATH`, the `cookies.txt`
secret file) have been **removed** — see Known Issue below for why. If you don't see them
in Render's dashboard anymore, that's expected; they can be deleted from the Render
Environment tab if they're still sitting there from earlier experimentation.

---

## Known issue: YouTube downloads are unsupported (by design, not a bug)

**Current behavior:** `POST /jobs` with a YouTube URL returns a `422` immediately, with
the message "YouTube downloads are currently unavailable, try another source." This is
intentional — see `routes/jobs.js`, the `YOUTUBE_PATTERN` check at the top of the POST
handler.

**What was tried before landing here, in order:**

1. **Cookies from a real YouTube account** (`--cookies`) — worked temporarily, but
   sessions rotate/expire on YouTube's side outside our control, and it ties the pipeline
   to one person's personal account. **This code path has since been removed entirely**
   from `routes/jobs.js` — it's not just unused, it's gone. If cookies are reintroduced
   later, they'd need to be re-added from scratch (the pattern is documented in git
   history / earlier chat sessions if needed as reference).
2. **PO Token provider** (`bgutil-ytdlp-pot-provider`, running as a sidecar process on
   port 4416 via `start.sh`) — **still active**, successfully clears the initial
   bot-detection wall (confirmed via `-v` logs showing token generation succeeding).
3. **JS challenge runtime** (`--js-runtimes node` + `yt-dlp-ejs` package +
   `--remote-components ejs:github`) — **still active**, needed for YouTube's "n
   challenge" signature solving, uses Node (already in the base image) rather than a
   separately-installed Deno.
4. Even with #2 and #3 both working correctly, YouTube's block on Render's datacenter IP
   range resurfaced. This is a known, active, unresolved arms race between YouTube and the
   yt-dlp project broadly — not a mistake in this codebase.

**Why cookies specifically were removed rather than left in (unlike PO token/JS
runtime, which stay):** cookies were the most operationally fragile piece (manual
re-export before every use, tied to a personal account, and didn't meaningfully improve
reliability over PO token + JS runtime alone once those were working). Removing dead/unused
mitigation code keeps `routes/jobs.js` honest about what's actually protecting requests.

**If picking this back up later,** the realistic remaining untried option is a
residential/rotating proxy for the server's outbound requests — addresses the actual root
cause (IP reputation) rather than another layer of client-side spoofing. Real cost and
infra complexity, so treat as a deliberate scope decision.

**For demos and testing:** use any non-YouTube source — direct video file URLs,
X/Twitter, or other yt-dlp-supported sites. These work with zero special handling.

---

## Running the backend locally

```bash
npm install
node index.js
```

Needs a local `.env` with `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`, and `yt-dlp` +
`ffmpeg` installed on your machine. Also needs the `jobs` table to exist in your Supabase
project — see `BACKEND_TODO.md` Section 1 for the schema.

Test with:
```bash
curl -X POST http://localhost:3000/jobs -H "Content-Type: application/json" -d '{"url": "..."}'
curl http://localhost:3000/jobs/JOB_ID
```

A YouTube URL should return a `422` instantly:
```bash
curl -X POST http://localhost:3000/jobs -H "Content-Type: application/json" -d '{"url": "https://youtu.be/anything"}'
```

---

## Running/deploying via Docker

The Dockerfile installs Python, ffmpeg, yt-dlp, yt-dlp-ejs, and the PO token provider,
then `start.sh` runs the PO token sidecar server in the background before starting the
Express app in the foreground. On Render, the service's Runtime must be set to **Docker**,
not the default Node buildpack — the default buildpack skips the Dockerfile entirely and
the app fails with `yt-dlp: command not found`.

---

## API contract (for frontend reference)

**POST `/jobs`**
```json
{ "url": "https://example.com/video", "format": "mp4" }
```
→ (non-YouTube URL)
```json
{ "id": "abc-123", "status": "processing", "outputUrl": null }
```
→ (YouTube URL)
```json
{ "error": "YouTube downloads are currently unavailable, try another source" }
```
with HTTP status `422`.

**GET `/jobs/{id}`** → same success shape as above; `status` is one of `processing`,
`done`, `failed`; on `done`, `outputUrl` is a public Supabase Storage link.

This contract is unchanged from earlier versions of the backend — the Postgres migration
was a storage swap, not an API change.
