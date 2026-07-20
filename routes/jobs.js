const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const supabase = require('../lib/supabase');

const YOUTUBE_PATTERN = /(youtube\.com|youtu\.be)/i;

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
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'url is required' });
  }

  if (YOUTUBE_PATTERN.test(url)) {
    return res.status(422).json({
      error: 'YouTube downloads are currently unavailable, try another source',
    });
  }

  const jobId = uuidv4();

  const { error: insertError } = await supabase
    .from('jobs')
    .insert({ id: jobId, url, status: 'processing', output_url: null, user_id: req.userId });

  if (insertError) {
    console.error(`Job ${jobId} failed to create:`, insertError);
    return res.status(500).json({ error: 'failed to create job' });
  }

  res.json({ id: jobId, status: 'processing', outputUrl: null });

  const outTemplate = path.join('/tmp', `${jobId}.%(ext)s`);

  const args = [
    '-f', 'bv*+ba/b/b',
    '-o', outTemplate,
    '--extractor-args', 'youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416',
    '--js-runtimes', 'node',
    '--remote-components', 'ejs:github',
    url,
  ];

  execFile('yt-dlp', args, async (err) => {
    if (err) {
      console.error(`Job ${jobId} failed:`, err.message);
      await supabase.from('jobs').update({ status: 'failed' }).eq('id', jobId);
      return;
    }
    await uploadResult(jobId);
  });
});

// Finds whatever yt-dlp actually wrote for this job (extension varies: mp4/webm for
// video, jpg/png/webp for images, etc.) rather than assuming a fixed format.
function findOutputFile(jobId) {
  const match = fs.readdirSync('/tmp').find((name) => name.startsWith(`${jobId}.`));
  return match ? path.join('/tmp', match) : null;
}

async function uploadResult(jobId) {
  const outPath = findOutputFile(jobId);
  if (!outPath) {
    console.error(`Job ${jobId} upload failed: no output file found`);
    await supabase.from('jobs').update({ status: 'failed' }).eq('id', jobId);
    return;
  }

  const ext = path.extname(outPath).slice(1) || 'bin';
  const fileBuffer = fs.readFileSync(outPath);
  const storagePath = `outputs/${jobId}.${ext}`;

  const { error } = await supabase.storage
    .from('downloads')
    .upload(storagePath, fileBuffer, { contentType: contentTypeFor(ext) });

  if (error) {
    console.error(`Job ${jobId} upload failed:`, error.message);
    await supabase.from('jobs').update({ status: 'failed' }).eq('id', jobId);
    return;
  }

  const { data } = supabase.storage.from('downloads').getPublicUrl(storagePath);
  await supabase
    .from('jobs')
    .update({ status: 'done', output_url: data.publicUrl })
    .eq('id', jobId);
  fs.unlinkSync(outPath);
}

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

  res.json({ id: data.id, status: data.status, outputUrl: data.output_url });
});

module.exports = router;