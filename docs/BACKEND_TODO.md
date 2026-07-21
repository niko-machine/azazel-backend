# Backend TODO & Implementation Guide

Status as of the last update: all three sections are implemented in this repo.

---

## 1. Persistent job history — DONE

`routes/jobs.js` now reads/writes job status from a Supabase Postgres `jobs` table instead
of an in-memory `Map`. Run this once against your Supabase project if the table doesn't
exist yet (SQL Editor in the Supabase dashboard):

```sql
create table jobs (
  id uuid primary key,
  url text not null,
  status text not null,
  output_url text,
  created_at timestamp default now()
);
```

If you're setting up a **new** Supabase project for this backend (as opposed to reusing
one that already has the old in-memory-only version deployed), this is the only manual
step needed beyond the usual environment variables — the code already expects this table
to exist.

**Verify it's working:** trigger a manual redeploy on Render mid-job, then confirm
`GET /jobs/:id` for a job created before the redeploy still returns the correct status.
That's the actual behavior this change exists to fix.

---

## 2. Supabase Auth — DONE

`POST /jobs` and `GET /jobs/:id` are now gated behind a valid Supabase auth token. Every
request must include an `Authorization: Bearer <access_token>` header, or it returns `401`.

**Migration needed** — run once in Supabase SQL Editor if not already applied:
```sql
alter table jobs add column user_id uuid references auth.users(id);
```

**What's implemented:**
- `lib/auth.js` — `requireAuth` middleware, verifies the token via
  `supabase.auth.getUser(token)` and attaches `req.userId`
- `index.js` — `requireAuth` applied to the `/jobs` route
- `routes/jobs.js` — jobs are stored with the creating user's `user_id`, and
  `GET /jobs/:id` only returns a job if it belongs to the requesting user (not just a
  login gate — genuine per-user isolation)

**Testing with curl now requires a real token.** Get one via Supabase's Auth REST API
(replace `YOUR_PROJECT` and `YOUR_ANON_KEY` — the anon key, not service_role, for this
call specifically, since this is a client-side auth request):

```bash
# Sign up a test user (once)
curl -X POST 'https://YOUR_PROJECT.supabase.co/auth/v1/signup' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com", "password": "testpassword123"}'

# Sign in to get an access_token
curl -X POST 'https://YOUR_PROJECT.supabase.co/auth/v1/token?grant_type=password' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com", "password": "testpassword123"}'
```

Copy `access_token` from the sign-in response, then use it in your existing job tests:
```bash
curl -X POST http://localhost:3000/jobs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -d '{"url": "..."}'
```

**On the Android side**, sign-in/sign-up and token attachment are now implemented (a
login screen scoped to the Downloads tab only — Browse remains unauthenticated, see the
frontend repo's docs for details).

### Android side — implemented

The app now has a login/register screen shown only when the Downloads tab is opened
without a valid session, and attaches the resulting token to `/jobs` requests via an
OkHttp interceptor. Session expiry mid-use is also handled (clears the stale token and
returns to login with an explanation, rather than silently failing jobs). See the
frontend repo for the actual implementation.

---

## 3. YouTube URL validation — DONE

`routes/jobs.js` now checks incoming URLs against a YouTube pattern before doing anything
else, returning a `422` immediately instead of running the full pipeline and failing
slowly:

```javascript
const YOUTUBE_PATTERN = /(youtube\.com|youtu\.be)/i;
```

This is a UX nicety around the documented YouTube limitation (see `NOTES.md`), not a fix
for it — YouTube remains unsupported, this just fails fast and clearly instead of making
the user wait through a `processing` → `failed` cycle.

---

## Known limitation to be aware of

YouTube is intentionally unsupported — see `NOTES.md` for the full mitigation history and
why. Nothing in this file works around that; Section 3 is designed specifically to
communicate it clearly, not bypass it.

---

## 4. Job history, required output name, and spam cooldown — DONE

Three related changes, all in `routes/jobs.js`:

**Migration needed** — run once in Supabase SQL Editor if not already applied:
```sql
alter table jobs add column output_name text;
```

**`GET /jobs`** (new) — lists the requesting user's job history, most recent first,
capped at 100. This is what lets the Android app show persistent history instead of an
in-memory list that resets on every app restart — the frontend should call this once on
`DownloadsFragment` load and populate the job list from it, rather than starting empty
every time.

**Required output name** — `POST /jobs` now requires a non-empty `outputName` field in the
body; a request without one gets `400`. The name is sanitized server-side (path-traversal
and filesystem-invalid characters stripped, length capped) regardless of what the client
already validated — never trust client-side validation alone for something that ends up
in a storage path. The sanitized name becomes part of the actual Supabase Storage path
(`outputs/{jobId}-{name}.{ext}`), with the jobId prefix kept specifically so two different
jobs requesting the same name never collide.

**Server-side cooldown** — a user must wait `COOLDOWN_MS` (currently 15000ms / 15s,
adjust the constant in `routes/jobs.js` if a different value is wanted) between job
creations. A request inside the cooldown window gets `429` with a `retryAfterMs` field so
the frontend can show an accurate countdown rather than a generic error. This is enforced
by checking the user's own most recent job's `created_at` — deliberately server-side, not
just a disabled button, since a client-side-only cooldown doesn't stop anything from a
second device or a direct API call.

---

## 5. Persisted, real failure reasons — DONE

**Migration needed** — run once in Supabase SQL Editor if not already applied:
```sql
alter table jobs add column error_message text;
```

Previously, `err.message` from a failed `yt-dlp` invocation was only ever `console.error`'d
to Render's logs — never persisted, never returned to the client. Every `failed` job in the
app looked identical regardless of cause (bad URL, unsupported site, extraction failure,
upload failure), forcing manual log-diving every time.

Now: `execFile`'s actual `stderr` output (not just `err.message`, which is often just
"Command failed with exit code 1" and tells you nothing useful) is captured, trimmed to the
last 500 characters (yt-dlp's real error is almost always at the end of its output), and
saved to the new `error_message` column. Upload failures and the "no output file produced"
case are captured the same way. All three job-returning endpoints (`POST /jobs`,
`GET /jobs/:id`, `GET /jobs`) now include `errorMessage` in the response — frontend should
display it on failed jobs instead of just "Status: failed".

**On the TikTok short-link failure reported alongside this fix** (`vt.tiktok.com`): once
this ships and redeployed, retry that URL and check the job's `errorMessage` — that'll
show the actual yt-dlp failure reason (e.g. an extractor error, a geo/rate limit, or
something else entirely) instead of guessing blind. Worth revisiting with real data rather
than speculative fixes.