/**
 * updater.cron.ts
 * Updates yt-dlp daily at 3 AM via pip (not yt-dlp -U which doesn't work with pip installs).
 */

import { spawn, execFile } from "node:child_process";
import { existsSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LOCK_FILE     = "/tmp/ytdlp-update.lock";

function log(level: string, msg: string, extra?: any) {
  process.stdout.write(JSON.stringify({
    ts: new Date().toISOString(), level, service: "updater", msg, ...extra,
  }) + "\n");
}

async function getYtDlpVersion(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("yt-dlp", ["--version"], { timeout: 10_000 });
    return stdout.trim();
  } catch { return "unknown"; }
}

async function runUpdate(): Promise<void> {
  // ── Lock check ────────────────────────────────────────────────────────────
  if (existsSync(LOCK_FILE)) {
    const lockAge = Date.now() - statSync(LOCK_FILE).mtimeMs;
    if (lockAge < 10 * 60_000) {
      log("info", "Update already running (lock file exists), skipping");
      return;
    }
    unlinkSync(LOCK_FILE); // stale lock
  }

  const before = await getYtDlpVersion();
  log("info", "Starting yt-dlp update", { versionBefore: before });

  writeFileSync(LOCK_FILE, ""); // touch — mtime is what matters

  return new Promise((resolve) => {
    // ── Use pip install --upgrade (works with pip-installed yt-dlp) ──────────
    const proc = spawn("pip3", [
      "install",
      "--break-system-packages",
      "--no-cache-dir",
      "--upgrade",
      "yt-dlp",
    ], {
      stdio:    "pipe",
      detached: false,
    });

    let stderr = "";
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

function msUntilNextRun(): number {
  const now  = new Date();
  const next = new Date();
  next.setHours(3, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

function scheduleDaily(): void {
  // ── Run on startup ─────────────────────────────────────────────────────────
  runUpdate().catch(err =>
    log("error", "Startup update failed", { error: err?.message })
  );

  // ── Schedule at 3 AM daily — recursive to avoid drift ─────────────────────
  function schedule() {
    const delay = msUntilNextRun();
    log("info", `Next yt-dlp update scheduled in ${Math.round(delay / 3_600_000)}h`);
    setTimeout(async () => {
      await runUpdate().catch(err =>
        log("error", "Scheduled update failed", { error: err?.message })
      );
      schedule(); // always reschedule for next 3 AM — no drift
    }, delay);
  }

  schedule();
}

export { scheduleDaily, runUpdate };