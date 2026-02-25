-- Migration: Add missing columns for full frontend support
-- Run this on the live database after the initial schema.sql

-- Campaigns: extra fields for tracking pixels, rotation, slug
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS slug VARCHAR(255);
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS rotation_mode VARCHAR(50) DEFAULT 'random';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS alert_threshold INTEGER DEFAULT 90;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS fb_pixel_id VARCHAR(255) DEFAULT '';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS fb_event_name VARCHAR(100) DEFAULT 'Lead';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS tt_pixel_id VARCHAR(255) DEFAULT '';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS tt_event_name VARCHAR(100) DEFAULT 'SubmitForm';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS gtm_id VARCHAR(255) DEFAULT '';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS gtm_event_name VARCHAR(100) DEFAULT 'whatsapp_click';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS gads_id VARCHAR(255) DEFAULT '';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS gads_conversion_label VARCHAR(255) DEFAULT '';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS created_by VARCHAR(255);

-- Links: extra fields for weight, fullness, deactivation
ALTER TABLE links ADD COLUMN IF NOT EXISTS weight INTEGER DEFAULT 1;
ALTER TABLE links ADD COLUMN IF NOT EXISTS is_full BOOLEAN DEFAULT false;
ALTER TABLE links ADD COLUMN IF NOT EXISTS health_check_failures INTEGER DEFAULT 0;
ALTER TABLE links ADD COLUMN IF NOT EXISTS deactivated_reason TEXT;
ALTER TABLE links ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMP;
ALTER TABLE links ADD COLUMN IF NOT EXISTS created_by VARCHAR(255);
ALTER TABLE links ADD COLUMN IF NOT EXISTS order_num INTEGER DEFAULT 0;

-- Users: last login tracking
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMP;

-- Alerts: extra context fields
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS link_name VARCHAR(255);
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS campaign_name VARCHAR(255);
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS percent INTEGER;

-- Clicks: OS field
ALTER TABLE clicks ADD COLUMN IF NOT EXISTS os VARCHAR(100);

-- Index on campaign slug for redirect lookups
CREATE INDEX IF NOT EXISTS idx_campaigns_slug ON campaigns(slug);

-- Reset false positive health_check_failures (from false positive detections)
UPDATE links SET health_check_failures = 0 WHERE health_check_failures > 0 AND is_active = true;
