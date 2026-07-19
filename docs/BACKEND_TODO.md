# Backend TODO & Implementation Guide

Status as of the last update: Sections 1 and 3 are implemented in this repo. Section 2
(Supabase Auth) remains optional/not started.

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

## 2. Optional: Supabase Auth (bonus rubric credit) — NOT STARTED

Skip unless you specifically want the extra-credit point. Self-contained — doesn't block
anything else.

### 2.1 Android side

Add the Supabase Kotlin client, implement a simple email/password sign-in screen, and
attach the resulting session's access token to outgoing requests:

```kotlin
val accessToken = supabaseClient.auth.currentSessionOrNull()?.accessToken
```

Add an `Authorization` header to the Retrofit `ApiService` calls — either via an OkHttp
`Interceptor` (cleanest) or as a header parameter on each call.

### 2.2 Backend side — verify the token

```javascript
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'missing token' });

  const token = authHeader.replace('Bearer ', '');
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: 'invalid token' });

  req.userId = data.user.id;
  next();
}
```

Apply it in `index.js`:
```javascript
app.use('/jobs', requireAuth, require('./routes/jobs'));
```

If pursuing this, consider adding a `user_id` column to the `jobs` table so each user only
sees their own history — otherwise this is auth as a gate, not per-user isolation, which is
still a legitimate and simpler version to ship if time is short.

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
