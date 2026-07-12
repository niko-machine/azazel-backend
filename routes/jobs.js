const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const supabase = require('../lib/supabase');

// In-memory job tracking: Map<jobId, { id, status, outputUrl }>
// Resets on server restart — fine for now, see the optional upgrade at the bottom.
const jobs = new Map();
const COOKIES_PATH = process.env.COOKIES_PATH || path.join(__dirname, '../cookies.txt');
const COOKIES_SOURCE = process.env.COOKIES_PATH || path.join(__dirname, '../cookies.txt');
const COOKIES_WRITABLE = '/tmp/cookies.txt';

router.post('/', (req, res) => {
  const { url, format = 'mp4' } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const jobId = uuidv4();
  jobs.set(jobId, { id: jobId, status: 'processing', outputUrl: null });
  res.json(jobs.get(jobId));

  const outPath = path.join('/tmp', `${jobId}.${format}`);

  const args = [
    '-f', 'bv*+ba/b',
    '--merge-output-format', 'mp4',
    '-o', outPath,
    '--extractor-args', 'youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416',
    '--extractor-args', 'youtube:player_client=android,web',
  ];

  if (fs.existsSync(COOKIES_SOURCE)) {
    fs.copyFileSync(COOKIES_SOURCE, COOKIES_WRITABLE);
    args.push('--cookies', COOKIES_WRITABLE);
  }

  args.push(url);

  execFile('yt-dlp', args, (err) => {
    if (err) {
      console.error(`Job ${jobId} failed:`, err.message);
      jobs.set(jobId, { id: jobId, status: 'failed', outputUrl: null });
      return;
    }
    uploadResult(jobId, outPath, format);
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
    jobs.set(jobId, { id: jobId, status: 'failed', outputUrl: null });
    return;
  }

  const { data } = supabase.storage.from('downloads').getPublicUrl(storagePath);
  jobs.set(jobId, { id: jobId, status: 'done', outputUrl: data.publicUrl });
  fs.unlinkSync(outPath);
}

// GET /jobs/:id
router.get('/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'not found' });
  }
  res.json(job);
});

module.exports = router;