const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const supabase = require('../lib/supabase');

const YOUTUBE_PATTERN = /(youtube\.com|youtu\.be)/i;

// How long a user must wait between starting jobs. Enforced server-side because a
// client-side-only disabled button is trivially bypassed (a second device, a direct
// API call, etc.) — this is the actual spam protection, the frontend cooldown is just UX.
const COOLDOWN_MS = 15000;

// Storage paths still carry the jobId prefix even with a custom name, so two jobs
// requesting the same output name never collide.
function sanitizeOutputName(name) {
  return name
    .trim()
    .replace(/[/\\?%*:|"<>]/g, '') // strip characters invalid in filenames / path-traversal-relevant
    .slice(0, 100);
}

// Minimal extension -> content-type map. yt-dlp/generic extractors cover both
// video sites and direct image links, so the output is not always mp4 — we
// look at what actually landed on disk instead of assuming.
const CONTENT_TYPES = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

function contentTypeFor(ext) {
  return CONTENT_TYPES[ext.toLowerCase()] || 'application/octet-stream';
}

// POST /jobs   body: { url }
// YouTube URLs are rejected immediately — see docs/NOTES.md for why.
// All other job state now lives in Supabase Postgres (see docs/BACKEND_TODO.md, Section 1)
// instead of an in-memory Map, so status survives a Render restart/redeploy.
//
// No `format` is requested from yt-dlp anymore. This endpoint supports both video
// and image URLs (see docs/NOTES.md), and forcing `--merge-output-format mp4` broke
// anything that wasn't a video (images have no streams to merge, so the request would
// still succeed, but every uploaded file was mislabeled as `video/mp4`). Instead we let
// yt-dlp pick the real extension via `%(ext)s` and read that back off disk before upload.
router.post('/', async (req, res) => {
  const { url, outputName } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'url is required' });
  }

  const cleanName = sanitizeOutputName(outputName || '');
  if (!cleanName) {
    return res.status(400).json({ error: 'outputName is required' });
  }

  if (YOUTUBE_PATTERN.test(url)) {
    return res.status(422).json({
      error: 'YouTube downloads are currently unavailable, try another source',
    });
  }

  // Server-side cooldown: look up this user's most recent job and reject if it's
  // too soon, regardless of what the client's own cooldown timer thinks.
  const { data: recentJobs, error: recentError } = await supabase
    .from('jobs')
    .select('created_at')
    .eq('user_id', req.userId)
    .order('created_at', { ascending: false })
    .limit(1);

  if (!recentError && recentJobs && recentJobs.length > 0) {
    const elapsed = Date.now() - new Date(recentJobs[0].created_at).getTime();
    if (elapsed < COOLDOWN_MS) {
      return res.status(429).json({
        error: 'Please wait before starting another download',
        retryAfterMs: COOLDOWN_MS - elapsed,
      });
    }
  }

  const jobId = uuidv4();

  const { error: insertError } = await supabase
    .from('jobs')
    .insert({
      id: jobId,
      url,
      status: 'processing',
      output_url: null,
      user_id: req.userId,
      output_name: cleanName,
    });

  if (insertError) {
    console.error(`Job ${jobId} failed to create:`, insertError);
    return res.status(500).json({ error: 'failed to create job' });
  }

  res.json({ id: jobId, status: 'processing', outputUrl: null, url, outputName: cleanName });

  const outTemplate = path.join('/tmp', `${jobId}.%(ext)s`);

  const args = [
    '-f', 'bv*+ba/b/b',
    '-o', outTemplate,
    '--extractor-args', 'youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416',
    '--js-runtimes', 'node',
    '--remote-components', 'ejs:github',
    url,
  ];

  execFile('yt-dlp', args, async (err, stdout, stderr) => {
    if (err) {
      // yt-dlp's real failure reason is almost always in stderr, not err.message
      // (which is often just "Command failed with exit code 1"). Trim to something
      // reasonable for display — full yt-dlp output can be long and noisy.
      const reason = (stderr || err.message || 'Unknown error').trim().slice(-500);
      console.error(`Job ${jobId} failed:`, reason);
      await supabase.from('jobs').update({ status: 'failed', error_message: reason }).eq('id', jobId);
      return;
    }
    await uploadResult(jobId, cleanName);
  });
});

// Finds whatever yt-dlp actually wrote for this job (extension varies: mp4/webm for
// video, jpg/png/webp for images, etc.) rather than assuming a fixed format.
function findOutputFile(jobId) {
  const match = fs.readdirSync('/tmp').find((name) => name.startsWith(`${jobId}.`));
  return match ? path.join('/tmp', match) : null;
}

async function uploadResult(jobId, outputName) {
  const outPath = findOutputFile(jobId);
  if (!outPath) {
    const reason = 'Download completed but no output file was produced (the source may not contain downloadable media)';
    console.error(`Job ${jobId} upload failed: no output file found`);
    await supabase.from('jobs').update({ status: 'failed', error_message: reason }).eq('id', jobId);
    return;
  }

  const ext = path.extname(outPath).slice(1) || 'bin';
  const fileBuffer = fs.readFileSync(outPath);
  // jobId prefix guarantees uniqueness even if two users pick the same output name
  const storagePath = `outputs/${jobId}-${outputName}.${ext}`;

  const { error } = await supabase.storage
    .from('downloads')
    .upload(storagePath, fileBuffer, { contentType: contentTypeFor(ext) });

  if (error) {
    console.error(`Job ${jobId} upload failed:`, error.message);
    await supabase.from('jobs').update({ status: 'failed', error_message: `Upload failed: ${error.message}` }).eq('id', jobId);
    return;
  }

  const { data } = supabase.storage.from('downloads').getPublicUrl(storagePath);
  await supabase
    .from('jobs')
    .update({ status: 'done', output_url: data.publicUrl })
    .eq('id', jobId);
  fs.unlinkSync(outPath);
}

// GET /jobs — list this user's job history, most recent first. This is what makes
// download history survive an app restart instead of living only in memory on the
// client (see docs/BACKEND_TODO.md for the frontend side of this).
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('jobs')
    .select()
    .eq('user_id', req.userId)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    console.error('Failed to list jobs:', error);
    return res.status(500).json({ error: 'failed to list jobs' });
  }

  res.json(
    data.map((job) => ({
      id: job.id,
      status: job.status,
      outputUrl: job.output_url,
      url: job.url,
      outputName: job.output_name,
      errorMessage: job.error_message,
    }))
  );
});

// GET /jobs/:id
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('jobs')
    .select()
    .eq('id', req.params.id)
    .eq('user_id', req.userId)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'not found' });
  }

  res.json({
    id: data.id,
    status: data.status,
    outputUrl: data.output_url,
    url: data.url,
    outputName: data.output_name,
    errorMessage: data.error_message,
  });
});

module.exports = router;