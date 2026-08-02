const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('../config/runtimeConfig');

class MergeQueue {
  constructor() {
    this.queue = [];
    this.activeJobs = new Map(); // id -> job details
    this.concurrencyLimit = 2; // Max parallel ffmpeg merges to protect MVP CPU
    this.runningCount = 0;
    
    // Create local scratch space
    this.scratchDir = path.join(os.tmpdir(), 'downloader_scratch');
    if (!fs.existsSync(this.scratchDir)) {
      fs.mkdirSync(this.scratchDir, { recursive: true });
    }

    // Periodically clean up old leaked scratch files (GC)
    setInterval(() => this.scratchGC(), 15 * 60 * 1000);
  }

  // Add a new download-merge job to the queue (idempotent)
  addJob(id, videoUrl, resolutionId, formatId) {
    if (this.activeJobs.has(id)) {
      return this.activeJobs.get(id);
    }

    const job = {
      id,
      url: videoUrl,
      resolution: resolutionId,
      format: formatId,
      status: 'pending',
      progress: 0,
      downloadPath: null,
      error: null,
      createdAt: Date.now()
    };

    this.activeJobs.set(id, job);
    this.queue.push(id);
    console.log(`[Queue] Added new job ${id} to queue. Current length: ${this.queue.length}`);
    
    // Process next in queue asynchronously
    process.nextTick(() => this.processNext());
    
    return job;
  }

  getJob(id) {
    return this.activeJobs.get(id);
  }

  async processNext() {
    if (this.runningCount >= this.concurrencyLimit || this.queue.length === 0) {
      return;
    }

    const jobId = this.queue.shift();
    const job = this.activeJobs.get(jobId);

    if (!job) {
      this.processNext();
      return;
    }

    this.runningCount++;
    job.status = 'processing';
    console.log(`[Queue] Processing job ${jobId}. Active threads: ${this.runningCount}`);

    try {
      await this.executeDownloadAndMerge(job);
      job.status = 'completed';
      job.progress = 100;
      console.log(`[Queue] Job ${jobId} completed successfully!`);
    } catch (err) {
      job.status = 'failed';
      job.error = err.message;
      console.error(`[Queue] Job ${jobId} failed:`, err.message);
    } finally {
      this.runningCount--;
      // Trigger next in queue
      process.nextTick(() => this.processNext());
    }
  }

  executeDownloadAndMerge(job) {
    return new Promise((resolve, reject) => {
      const outputFilename = `${job.id}.mp4`;
      const outputPath = path.join(this.scratchDir, outputFilename);
      job.downloadPath = outputPath;

      // Select specific formats. In yt-dlp: video_format+audio_format
      // If formatId is specified, we request that, otherwise default to bestvideo+bestaudio
      let formatSelector = 'bestvideo+bestaudio/best';
      if (job.format && job.resolution) {
        formatSelector = `${job.resolution}+bestaudio/best`;
      }

      // Build yt-dlp command. Uses ffmpeg automatically to merge tracks on server side.
      let cmd = `yt-dlp -f "${formatSelector}" --merge-output-format mp4 "${job.url}" -o "${outputPath}"`;
      
      // Inject secure cookies path if configured
      if (config.COOKIE_FILE_PATH) {
        cmd += ` --cookies "${config.COOKIE_FILE_PATH}"`;
      }

      console.log(`[Queue Runner] Executing: ${cmd}`);

      const proc = exec(cmd, (error, stdout, stderr) => {
        if (error) {
          return reject(new Error(`yt-dlp execution error: ${stderr || error.message}`));
        }
        resolve();
      });

      // Track progress logs asynchronously from stderr/stdout
      proc.stdout.on('data', (data) => {
        const match = data.match(/\[download\]\s+(\d+\.\d+)%/);
        if (match) {
          job.progress = Math.round(parseFloat(match[1]));
        }
      });
    });
  }

  // Immediate clean up once file is served/streamed
  cleanupJobFile(id) {
    const job = this.activeJobs.get(id);
    if (job && job.downloadPath && fs.existsSync(job.downloadPath)) {
      try {
        fs.unlinkSync(job.downloadPath);
        console.log(`[Queue Cleanup] Successfully deleted temporary job file: ${job.downloadPath}`);
        this.activeJobs.delete(id);
      } catch (err) {
        console.error(`[Queue Cleanup] Error unlinking file ${job.downloadPath}:`, err.message);
      }
    }
  }

  // Garbage Collector for orphaned scratch files older than 15 mins
  scratchGC() {
    fs.readdir(this.scratchDir, (err, files) => {
      if (err) return;
      const now = Date.now();
      const expirationTime = 15 * 60 * 1000; // 15 mins

      files.forEach((file) => {
        const filePath = path.join(this.scratchDir, file);
        fs.stat(filePath, (err, stats) => {
          if (err) return;
          if (now - stats.mtimeMs > expirationTime) {
            fs.unlink(filePath, () => {
              console.log(`[Queue GC] Cleaned up stale merge file: ${file}`);
            });
          }
        });
      });
    });
  }
}

module.exports = new MergeQueue();
