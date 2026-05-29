/**
 * updater.cron.ts
 * Runs yt-dlp -U daily at 3 AM server time.
 * Uses a lock file to prevent concurrent updates.
 * Safe: uses spawn (not execSync) so it never blocks the event loop.
 */

import { spawn, execFile } from "node:child_process";
import { existsSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LOCK_FILE     = "/tmp/ytdlp-update.lock";

function log(level: string, msg: string, extra?: any) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, service: "updater", msg, ...extra }) + "\n");
}

async function getYtDlpVersion(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("yt-dlp", ["--version"], { timeout: 10_000 });
    return stdout.trim();
  } catch { return "unknown"; }
}

async function runUpdate(): Promise<void> {
  // Prevent concurrent updates
  if (existsSync(LOCK_FILE)) {
    const lockAge = Date.now() - statSync(LOCK_FILE).mtimeMs;
    if (lockAge < 10 * 60_000) {
      log("info", "Update already running (lock file exists), skipping");
      return;
    }
    // Stale lock — remove it
    unlinkSync(LOCK_FILE);
  }

  const before = await getYtDlpVersion();
  log("info", "Starting yt-dlp update", { versionBefore: before });

  writeFileSync(LOCK_FILE, String(Date.now()));

  return new Promise((resolve) => {
    const proc = spawn("yt-dlp", ["-U"], {
      stdio:    "pipe",
      detached: false,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

    proc.on("close", async (code) => {
      try { unlinkSync(LOCK_FILE); } catch { /* ignore */ }

      const after = await getYtDlpVersion();

      if (code === 0) {
        if (before !== after) {
          log("info", "yt-dlp updated successfully", { from: before, to: after });
        } else {
          log("info", "yt-dlp already up to date", { version: after });
        }
      } else {
        log("warn", "yt-dlp update failed", { code, stderr: stderr.slice(0, 200) });
      }

      resolve();
    });

    proc.on("error", (err) => {
      try { unlinkSync(LOCK_FILE); } catch { /* ignore */ }
      log("error", "yt-dlp update process error", { error: err.message });
      resolve();
    });
  });
}

function scheduleDaily(): void {
  // Run immediately on startup check
  runUpdate();

  // Schedule to run at 3 AM daily
  function msUntilNextRun(): number {
    const now  = new Date();
    const next = new Date();
    next.setHours(3, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
  }

  function schedule() {
    const delay = msUntilNextRun();
    log("info", `Next yt-dlp update scheduled in ${Math.round(delay / 3_600_000)}h`);
    setTimeout(() => {
      runUpdate();
      setInterval(runUpdate, 24 * 60 * 60_000); // every 24h after first run
    }, delay);
  }

  schedule();
}

export { scheduleDaily, runUpdate };