const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const config = require('./config/runtimeConfig');
const cacheProvider = require('./cache/cacheProvider');
const mergeQueue = require('./queue/mergeQueue');

// Hardened Security: Crash server immediately if METRICS_TOKEN is omitted in production
if (!process.env.METRICS_TOKEN) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error("CRITICAL SECURITY ERROR: The 'METRICS_TOKEN' environment variable is required to start this server.");
  } else {
    process.env.METRICS_TOKEN = 'dev-token-123';
  }
}
const PROCESS_METRICS_TOKEN = process.env.METRICS_TOKEN;

// Synchronous Active Slots (Atomic Semaphore)
let activeSlotsCount = 0;
const MAX_CONCURRENT_MERGES = 15;
const activeFFmpegProcesses = new Set();

// Telemetry Metrics Store
const metrics = {
  totalCompleted: 0,
  totalFailed: 0,
  totalAborted: 0,
  responses429: 0,
  activeYtDlp: 0
};

// Structured JSON Logger Helper
function logEvent(level, message, metadata = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...metadata
  }));
}

const app = express();

// Trust reverse proxy (OpenLiteSpeed/Cloudflare) to allow express-rate-limit to read X-Forwarded-For headers safely
app.set('trust proxy', 1);

// 1. Hardened Security Headers & CORS Middleware
app.use(express.json());
app.use(cors({
  origin: '*', // For MVP/Universal client fetch. In production, restrict to your frontend domain.
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Correlation-ID', 'Idempotency-Key', 'Range']
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
  validate: { trustProxy: false }
});

const mergeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: config.RATE_LIMITS.GUEST, // Strict limit on heavy ffmpeg merges
  message: { error: 'Merge download limit reached for this hour. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false }
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

async function resolveFreshSignedUrls(url, videoFormat, audioFormat) {
  return new Promise((resolve, reject) => {
    let cmd = `yt-dlp -J --js-runtimes "node:${process.execPath}" --remote-components ejs:github -f "${videoFormat}+${audioFormat}" "${url}"`;
    const cookiePath = config.getCookiePath ? config.getCookiePath() : null;
    if (cookiePath) {
      cmd += ` --cookies "${cookiePath}"`;
    }
    
    exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        return reject(new Error(stderr || error.message));
      }
      try {
        const rawJson = JSON.parse(stdout);
        let videoUrl = null;
        let audioUrl = null;
        let audioCodec = null;

        if (rawJson.requested_formats) {
          for (const f of rawJson.requested_formats) {
            if (f.vcodec !== 'none' && f.acodec === 'none') videoUrl = f.url;
            else if (f.acodec !== 'none' && f.vcodec === 'none') {
              audioUrl = f.url;
              audioCodec = f.acodec;
            } else if (f.vcodec !== 'none' && f.acodec !== 'none') {
               videoUrl = f.url;
               audioUrl = f.url;
               audioCodec = f.acodec;
            }
          }
          if (!videoUrl && rawJson.requested_formats.length > 0) videoUrl = rawJson.requested_formats[0].url;
          if (!audioUrl && rawJson.requested_formats.length > 1) {
            audioUrl = rawJson.requested_formats[1].url;
            audioCodec = rawJson.requested_formats[1].acodec;
          } else if (!audioUrl && rawJson.requested_formats.length > 0) {
             audioUrl = rawJson.requested_formats[0].url;
             audioCodec = rawJson.requested_formats[0].acodec;
          }
        } else {
          videoUrl = rawJson.url;
          audioUrl = rawJson.url;
          audioCodec = rawJson.acodec;
        }

        resolve({ videoUrl, audioUrl, audioCodec });
      } catch (err) {
        reject(new Error('Failed to parse yt-dlp JSON output.'));
      }
    });
  });
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
    let cmd = `yt-dlp -J --js-runtimes "node:${process.execPath}" --remote-components ejs:github "${url}"`;
    const cookiePath = config.getCookiePath();
    if (cookiePath) {
      cmd += ` --cookies "${cookiePath}"`;
    }

    console.log(`[API v1] Cache Miss. Spawning extraction: ${cmd}`);
    exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, async (error, stdout, stderr) => {
      if (error) {
        console.error(`[API v1 Error] yt-dlp failed:`, stderr || error.message);
        // Use HTTP 200 instead of 400/502 to force OpenLiteSpeed to pass the raw JSON error intact without HTML overrides
        return res.status(200).json({ error: 'Failed to extract stream metadata from URL.', details: stderr || error.message });
      }

      try {
        const rawJson = JSON.parse(stdout);
        const cleaned = cleanMetadata(rawJson);

        // Cache the cleaned metadata (TTL 30 minutes)
        await cacheProvider.set(cacheKey, cleaned, 1800);
        res.json({ cache: 'MISS', metadata: cleaned });
      } catch (parseErr) {
        // Use HTTP 200 instead of 400/502 to force OpenLiteSpeed pass-through
        res.status(200).json({ error: 'Failed to parse platform metadata.', details: parseErr.message });
      }
    });

  } catch (err) {
    // Use HTTP 200 instead of 400/500 to force OpenLiteSpeed pass-through
    res.status(200).json({ error: 'Internal Server Error.', details: err.message });
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

// VPS Direct Streaming Proxy Endpoint (Act as final fallback for Chunked downloads)
app.get('/api/v1/download-stream', (req, res) => {
  const { url, download, title } = req.query;
  if (!url) {
    // Return HTTP 200 with JSON to prevent OpenLiteSpeed HTML overrides
    return res.status(200).json({ error: 'Missing target stream url parameter.' });
  }

  try {
    const http = require('http');
    const https = require('https');

    const forwardHeaders = {};
    if (req.headers.range) {
      forwardHeaders['range'] = req.headers.range;
    }
    
    // Add fake headers to look like a standard browser request
    forwardHeaders['user-agent'] = req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    
    try {
      const urlObj = new URL(url);
      forwardHeaders['Origin'] = urlObj.origin;
      forwardHeaders['Referer'] = urlObj.origin + '/';
    } catch (_) {}

    const clientModule = url.startsWith('https') ? https : http;

    const proxyReq = clientModule.request(url, {
      method: 'GET',
      headers: forwardHeaders
    }, (proxyRes) => {
      const responseHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, ETag'
      };

      const headersToForward = [
        'content-type',
        'content-length',
        'content-range',
        'accept-ranges',
        'etag',
        'cache-control',
        'last-modified'
      ];

      for (const h of headersToForward) {
        const val = proxyRes.headers[h];
        if (val) {
          responseHeaders[h] = val;
        }
      }

      // If direct native browser attachment is requested
      if (download === 'true') {
        const safeTitle = (title || 'video').replace(/[^a-z0-9\s]/gi, '_').trim();
        responseHeaders['Content-Disposition'] = `attachment; filename="${safeTitle}.mp4"`;
      }

      res.writeHead(proxyRes.statusCode, responseHeaders);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error('[Download Stream Proxy Error]:', err.message);
      // Return HTTP 200 with JSON to prevent OpenLiteSpeed HTML overrides
      res.status(200).json({ error: 'VPS Proxy failed to fetch target stream.', details: err.message });
    });

    proxyReq.end();

  } catch (err) {
    console.error('[Download Stream Proxy Error]:', err.message);
    res.status(200).json({ error: 'VPS Proxy crashed.', details: err.message });
  }
});

// --- NEW V7 MERGE ENGINE ---
app.get('/api/v1/download-merge', async (req, res) => {
  const { url, videoFormat, audioFormat, title } = req.query;
  const requestId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(7);

  if (!url || !videoFormat || !audioFormat) {
    logEvent('WARN', 'Missing parameters in merge request', { requestId, query: req.query });
    return res.status(400).json({ error: 'Missing required parameters: url, videoFormat, and audioFormat are required.' });
  }

  if (activeSlotsCount >= MAX_CONCURRENT_MERGES) {
    metrics.responses429++;
    logEvent('INFO', 'Pipeline full. Rejecting request with 429', { requestId, activeSlotsCount });
    return res.status(429).json({ 
      error: 'pipeline_busy', 
      message: 'All merging slots are currently occupied. Please retry in 10-15 seconds.' 
    });
  }

  activeSlotsCount++;
  logEvent('INFO', 'Concurrency slot acquired successfully', { requestId, activeSlotsCount });

  let ffmpegProcess = null;
  let cleaned = false;

  function releaseSlot(category = 'completed') {
    if (cleaned) return;
    cleaned = true;

    activeSlotsCount = Math.max(0, activeSlotsCount - 1);
    
    if (category === 'aborted') metrics.totalAborted++;
    if (category === 'failed') metrics.totalFailed++;
    if (category === 'completed') metrics.totalCompleted++;

    if (ffmpegProcess) {
      activeFFmpegProcesses.delete(ffmpegProcess);
      
      if (category !== 'completed') {
        if (ffmpegProcess.stdout) {
          ffmpegProcess.stdout.unpipe(res);
        }
        res.end();
      }

      try {
        logEvent('INFO', 'Sending SIGTERM to FFmpeg process', { requestId });
        ffmpegProcess.kill('SIGTERM');

        const forceKillTimeout = setTimeout(() => {
          if (ffmpegProcess && !ffmpegProcess.killed) {
            logEvent('WARN', 'FFmpeg did not exit on SIGTERM. Escalating to SIGKILL', { requestId });
            ffmpegProcess.kill('SIGKILL');
          }
        }, 2500);

        ffmpegProcess.once('exit', () => clearTimeout(forceKillTimeout));
      } catch (e) {
        logEvent('ERROR', 'Error during FFmpeg process cleanup', { requestId, error: e.message });
      }
    } else if (category !== 'completed') {
      res.end();
    }
  }

  try {
    logEvent('INFO', 'Starting URL extraction...', { requestId });
    let streamMetadata = null;
    
    try {
      metrics.activeYtDlp++;
      streamMetadata = await resolveFreshSignedUrls(url, videoFormat, audioFormat);
    } finally {
      metrics.activeYtDlp--;
    }

    if (!streamMetadata || !streamMetadata.videoUrl || !streamMetadata.audioUrl) {
      throw new Error('Failed to resolve signed platform URLs.');
    }

    const { videoUrl, audioUrl, audioCodec } = streamMetadata;

    const safeTitle = (title || 'video').replace(/[^a-z0-9\s]/gi, '_').trim();
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.mp4"`);

    const isAudioAac = audioCodec === 'aac' || audioCodec === 'mp4a' || audioFormat.includes('140');
    const audioCodecFlag = isAudioAac ? 'copy' : 'aac';

    const ffmpegArgs = [
      '-headers', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)\\r\\n',
      '-i', videoUrl,
      '-headers', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)\\r\\n',
      '-i', audioUrl,
      '-c:v', 'copy',
      '-c:a', audioCodecFlag,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-fflags', '+genpts',
      '-shortest',
      '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov',
      'pipe:1'
    ];

    logEvent('INFO', 'Spawning FFmpeg stream copy process', { requestId, audioStrategy: audioCodecFlag });
    
    ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    activeFFmpegProcesses.add(ffmpegProcess);

    ffmpegProcess.stderr.resume();

    ffmpegProcess.stdout.pipe(res);

    const abortHandler = () => {
      logEvent('WARN', 'Client connection aborted or closed.', { requestId });
      releaseSlot('aborted');
    };
    req.on('close', abortHandler);
    req.on('aborted', abortHandler);

    const watchdogTimer = setTimeout(() => {
      logEvent('WARN', 'Execution hit maximum duration ceiling. Forcing exit', { requestId });
      releaseSlot('failed');
    }, 10 * 60 * 1000);

    ffmpegProcess.once('exit', (code, signal) => {
      clearTimeout(watchdogTimer);
      
      if (signal) {
        logEvent('WARN', 'FFmpeg process terminated by signal', { requestId, signal });
        releaseSlot(signal === 'SIGTERM' || signal === 'SIGKILL' ? 'aborted' : 'failed');
      } else if (code === 0) {
        logEvent('INFO', 'FFmpeg process completed successfully', { requestId });
        releaseSlot('completed');
      } else {
        logEvent('ERROR', 'FFmpeg process exited with error status', { requestId, code });
        releaseSlot('failed');
      }
    });

  } catch (err) {
    logEvent('ERROR', 'Merging engine processing exception occurred', { requestId, error: err.message });
    
    if (!res.headersSent) {
      res.status(502).json({ error: 'extraction_failed', message: err.message });
    }
    
    releaseSlot('failed');
  }
});

app.get('/api/v1/metrics', (req, res) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized. Missing Bearer token.' });
  }

  const clientToken = authHeader.split(' ')[1];
  if (clientToken !== PROCESS_METRICS_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized. Invalid Bearer token.' });
  }

  res.status(200).json({
    telemetry: {
      active_ffmpeg_processes: activeFFmpegProcesses.size,
      active_slots: activeSlotsCount,
      active_ytdlp_resolutions: Math.max(0, metrics.activeYtDlp),
      total_completed_merges: metrics.totalCompleted,
      total_failed_merges: metrics.totalFailed,
      total_aborted_merges: metrics.totalAborted,
      total_429_busy_responses: metrics.responses429,
      current_vps_time: new Date().toISOString()
    }
  });
});

// --- TELEMETRY & HEALTH ENDPOINTS ---

app.get(['/live', '/api/live'], (req, res) => res.sendStatus(200));

app.get(['/ready', '/api/ready'], async (req, res) => {
  // Verifies SQLite cache is connected
  if (cacheProvider.activeDriver === 'sqlite' && !cacheProvider.sqliteDb) {
    return res.status(503).send('Database unavailable');
  }
  res.sendStatus(200);
});

app.get(['/health', '/api/health'], (req, res) => {
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
