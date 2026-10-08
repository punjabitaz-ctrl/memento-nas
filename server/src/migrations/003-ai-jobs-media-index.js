'use strict';

// backfill() asks "does this recording already have a pending/running transcribe job?" for every recording.
// Without this index each of those lookups scans ai_jobs.
module.exports = function up(db) {
  db.exec('CREATE INDEX IF NOT EXISTS idx_ai_jobs_media ON ai_jobs(media_id)');
};
