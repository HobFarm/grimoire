-- DLQ escalation: track retry attempts, mark permanently failed after 3 retries
ALTER TABLE failed_operations ADD COLUMN retry_count INTEGER DEFAULT 0;
ALTER TABLE failed_operations ADD COLUMN permanently_failed INTEGER DEFAULT 0;
ALTER TABLE failed_operations ADD COLUMN failure_reason TEXT;
