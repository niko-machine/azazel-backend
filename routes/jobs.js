const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const supabase = require('../lib/supabase');

const YOUTUBE_PATTERN = /(youtube\.com|youtu\.be)/i;

// POST /jobs   body: { url, format? }
// YouTube URLs are rejected immediately — see docs/NOTES.md for why.
// All other job state now lives in Supabase Postgres (see docs/BACKEND_TODO.md, Section 1)
// instead of an in-memory Map, so status survives a Render restart/redeploy.
router.post('/', async (req, res) => {
  const { url, format = 'mp4' } = req.body;
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

  const outPath = path.join('/tmp', `${jobId}.${format}`);

  const args = [
    '-f', 'bv*+ba/b',
    '--merge-output-format', 'mp4',
    '-o', outPath,
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
    await uploadResult(jobId, outPath, format);
  });
});

async function uploadResult(jobId, outPath, format) {
  const fileBuffer = fs.readFileSync(outPath);
  const storagePath = `outputs/${jobId}.${format}`;

  const { error } = await supabase.storage
    .from('downloads')
    .upload(storagePath, fileBuffer, { contentType: 'video/mp4' });

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