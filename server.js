const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const config = require('./config/runtimeConfig');
const cacheProvider = require('./cache/cacheProvider');
const mergeQueue = require('./queue/mergeQueue');

const app = express();

// 1. Hardened Security Headers & CORS Middleware
app.use(express.json());
app.use(cors({
  origin: '*', // For MVP/Universal client fetch. In production, restrict to your frontend domain.
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Correlation-ID', 'Idempotency-Key']
}));

// Apply basic secure headers (HSTS, CSP, etc.)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  
  // Set X-Correlation-ID for distributed tracing across logs
  const correlationId = req.headers['x-correlation-id'] || crypto.randomUUID();
  req.correlationId = correlationId;
  res.setHeader('X-Correlation-ID', correlationId);
  next();
});

// 2. Rate Limiting Middleware
const apiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: config.RATE_LIMITS.GUEST * 10, // Max requests for metadata fetching
  message: { error: 'Too many requests from this IP. Please try again in an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const mergeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: config.RATE_LIMITS.GUEST, // Strict limit on heavy ffmpeg merges
  message: { error: 'Merge download limit reached for this hour. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// --- HELPER FUNCTIONS ---

// Sanitize URL and generate composite cache key
function generateCacheKey(videoUrl) {
  try {
    const parsed = new URL(videoUrl);
    // Strip common tracking parameters to maximize cache hits
    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 's', 'igsh', 'fbclid'];
    trackingParams.forEach(param => parsed.searchParams.delete(param));
    
    const sanitizedUrl = parsed.toString();
    return crypto.createHash('sha256').update(sanitizedUrl).digest('hex');
  } catch (err) {
    return crypto.createHash('sha256').update(videoUrl).digest('hex');
  }
}

// Clean and sanitize raw yt-dlp metadata for frontend consumption
function cleanMetadata(raw) {
  const formats = (raw.formats || []).map(f => {
    // Determine quality description
    let quality = f.resolution || 'audio';
    if (f.vcodec !== 'none' && f.acodec !== 'none') {
      quality += ' (Merged)';
    } else if (f.vcodec !== 'none') {
      quality += ' (Video Only)';
    } else if (f.acodec !== 'none') {
      quality = 'Audio Only';
    }

    return {
      formatId: f.format_id,
      ext: f.ext,
      resolution: f.resolution,
      qualityLabel: quality,
      filesize: f.filesize || f.filesize_approx || null,
      url: f.url, // Streaming CDN URL
      vcodec: f.vcodec,
      acodec: f.acodec,
    };
  });

  return {
    title: raw.title || 'Untitled Video',
    description: raw.description || '',
    duration: raw.duration || 0,
    thumbnail: raw.thumbnail || (raw.thumbnails && raw.thumbnails.length > 0 ? raw.thumbnails[raw.thumbnails.length - 1].url : null),
    uploader: raw.uploader || 'Unknown',
    extractor: raw.extractor_key || raw.extractor || 'generic',
    formats: formats.filter(f => f.url), // Only send formats with working CDN links
  };
}

// --- API ENDPOINTS (v1) ---

// Get video formats and metadata
app.get('/api/v1/metadata', apiLimiter, async (req, res) => {
  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'Missing video url parameter.' });
  }

  const cacheKey = generateCacheKey(url);
  console.log(`[API v1] [Trace: ${req.correlationId}] Querying metadata for URL: ${url} (Key: ${cacheKey})`);

  try {
    // Check Cache (Hit)
    const cachedData = await cacheProvider.get(cacheKey);
    if (cachedData) {
      console.log(`[API v1] Cache Hit! Key: ${cacheKey}`);
      return res.json({ cache: 'HIT', metadata: cachedData });
    }

    // Cache Miss. Exec yt-dlp to extract info
    let cmd = `yt-dlp -J "${url}"`;
    if (config.COOKIE_FILE_PATH) {
      cmd += ` --cookies "${config.COOKIE_FILE_PATH}"`;
    }

    console.log(`[API v1] Cache Miss. Spawning extraction: ${cmd}`);
    exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, async (error, stdout, stderr) => {
      if (error) {
        console.error(`[API v1 Error] yt-dlp failed:`, stderr || error.message);
        return res.status(500).json({ error: 'Failed to extract stream metadata from URL.', details: stderr || error.message });
      }

      try {
        const rawJson = JSON.parse(stdout);
        const cleaned = cleanMetadata(rawJson);

        // Cache the cleaned metadata (TTL 30 minutes)
        await cacheProvider.set(cacheKey, cleaned, 1800);
        res.json({ cache: 'MISS', metadata: cleaned });
      } catch (parseErr) {
        res.status(502).json({ error: 'Failed to parse platform metadata.', details: parseErr.message });
      }
    });

  } catch (err) {
    res.status(500).json({ error: 'Internal Server Error.', details: err.message });
  }
});

// Create a server-side merge download job (Idempotent by nature)
app.post('/api/v1/jobs', mergeLimiter, (req, res) => {
  const { url, resolution, format } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'Missing video URL parameter.' });
  }

  // Generate unique Job ID based on request parameters (Idempotency Key)
  const hashInput = `${url}_${resolution || 'best'}_${format || 'mp4'}`;
  const jobId = crypto.createHash('sha256').update(hashInput).digest('hex').substring(0, 16);

  console.log(`[API v1] [Trace: ${req.correlationId}] Received job creation request. Job ID: ${jobId}`);

  const job = mergeQueue.addJob(jobId, url, resolution, format);
  res.status(202).json({
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    createdAt: job.createdAt
  });
});

// Check status of a merge job
app.get('/api/v1/jobs/:id', (req, res) => {
  const job = mergeQueue.getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found.' });
  }

  res.json({
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    error: job.error
  });
});

// Stream/Download completed file
app.get('/api/v1/download/:id', (req, res) => {
  const job = mergeQueue.getJob(req.params.id);
  if (!job || job.status !== 'completed' || !job.downloadPath) {
    return res.status(404).json({ error: 'Download not ready or expired.' });
  }

  if (!fs.existsSync(job.downloadPath)) {
    return res.status(410).json({ error: 'Merged file was cleaned up or does not exist.' });
  }

  const stat = fs.statSync(job.downloadPath);
  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="video_${job.id}.mp4"`
  });

  const stream = fs.createReadStream(job.downloadPath);
  stream.pipe(res);

  // Immediate file cleanup handshake
  res.on('finish', () => {
    console.log(`[API Download] Stream successfully completed for Job ID: ${job.id}. Triggering file unlink.`);
    mergeQueue.cleanupJobFile(job.id);
  });

  res.on('close', () => {
    // Handles if user cancels download mid-way
    console.log(`[API Download] Connection closed for Job ID: ${job.id}. Cleaning temporary files.`);
    mergeQueue.cleanupJobFile(job.id);
  });
});

// --- TELEMETRY & HEALTH ENDPOINTS ---

app.get('/live', (req, res) => res.sendStatus(200));

app.get('/ready', async (req, res) => {
  // Verifies SQLite cache is connected
  if (cacheProvider.activeDriver === 'sqlite' && !cacheProvider.sqliteDb) {
    return res.status(503).send('Database unavailable');
  }
  res.sendStatus(200);
});

app.get('/health', (req, res) => {
  const memory = process.memoryUsage();
  res.json({
    uptime: process.uptime(),
    memory: {
      heapTotal: `${Math.round(memory.heapTotal / 1024 / 1024)} MB`,
      heapUsed: `${Math.round(memory.heapUsed / 1024 / 1024)} MB`,
      rss: `${Math.round(memory.rss / 1024 / 1024)} MB`,
    },
    cache: {
      activeDriver: cacheProvider.activeDriver,
    },
    queue: {
      activeJobs: mergeQueue.activeJobs.size,
      queueLength: mergeQueue.queue.length,
      activeThreads: mergeQueue.runningCount,
    }
  });
});

// --- BOOTSTRAP INITIALIZATION ---

async function bootstrap() {
  // Initialize Cache Engine first
  await cacheProvider.init();

  app.listen(config.PORT, () => {
    console.log(`====================================================`);
    console.log(`🚀 Node.js Metadata API Server Running on port: ${config.PORT}`);
    console.log(`Active Profile Mode: MVP (Single Node, SQLite Caching)`);
    console.log(`Distributed Trace: ENABLED (Correlation-ID generated)`);
    console.log(`====================================================`);
  });
}

bootstrap().catch(err => {
  console.error('[Bootstrap Fail] API crashed during startup:', err.message);
  process.exit(1);
});
