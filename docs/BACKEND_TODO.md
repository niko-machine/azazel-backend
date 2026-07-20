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

**On the Android side**, this isn't implemented yet — the app currently sends no
`Authorization` header at all, so every request from the app will now fail with `401`
until a login screen is added and the resulting token is attached to Retrofit calls (see
Section 2.1's original outline below for the shape of that work — still frontend-side, not
done as part of this backend change).

### Android side — not yet done

The Android app doesn't attach an `Authorization` header yet. Until it does, every request
from the app will fail with `401`. Needed: a sign-in screen using the Supabase Kotlin
client, and an OkHttp `Interceptor` (or per-call header) attaching
`supabaseClient.auth.currentSessionOrNull()?.accessToken` to outgoing Retrofit calls. This
is genuinely frontend work — track it there, not here.

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