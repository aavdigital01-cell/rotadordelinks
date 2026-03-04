-- Migration: Add missing columns for full frontend support
-- Run this on the live database after the initial schema.sql
--
-- IMPORTANT: If tables were created by the 'postgres' user, run this first as postgres:
--   sudo -u postgres psql -d linkrotator_db -c "
--     ALTER TABLE campaigns OWNER TO linkrotator;
--     ALTER TABLE links OWNER TO linkrotator;
--     ALTER TABLE clicks OWNER TO linkrotator;
--     ALTER TABLE users OWNER TO linkrotator;
--     ALTER TABLE alerts OWNER TO linkrotator;
--     ALTER TABLE whatsapp_groups OWNER TO linkrotator;
--     ALTER TABLE member_events OWNER TO linkrotator;
--     ALTER TABLE meta_campaigns OWNER TO linkrotator;
--     ALTER TABLE settings OWNER TO linkrotator;
--     GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO linkrotator;
--     GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO linkrotator;
--   "

-- Configura fuso horário do Brasil
SET timezone = 'America/Sao_Paulo';

-- Campaigns: extra fields for tracking pixels, rotation, slug
DO $$ BEGIN
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
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipping campaigns ALTER - not owner. Run fix-ownership.sql as postgres first.';
END $$;

-- Links: extra fields for weight, fullness, deactivation
DO $$ BEGIN
  ALTER TABLE links ADD COLUMN IF NOT EXISTS weight INTEGER DEFAULT 1;
  ALTER TABLE links ADD COLUMN IF NOT EXISTS is_full BOOLEAN DEFAULT false;
  ALTER TABLE links ADD COLUMN IF NOT EXISTS health_check_failures INTEGER DEFAULT 0;
  ALTER TABLE links ADD COLUMN IF NOT EXISTS deactivated_reason TEXT;
  ALTER TABLE links ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMP;
  ALTER TABLE links ADD COLUMN IF NOT EXISTS created_by VARCHAR(255);
  ALTER TABLE links ADD COLUMN IF NOT EXISTS order_num INTEGER DEFAULT 0;
  ALTER TABLE links ADD COLUMN IF NOT EXISTS auto_pause_enabled BOOLEAN DEFAULT true;
  ALTER TABLE links ADD COLUMN IF NOT EXISTS auto_pause_threshold INTEGER DEFAULT 90;
  ALTER TABLE links ADD COLUMN IF NOT EXISTS auto_reactivate_below INTEGER DEFAULT 500;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipping links ALTER - not owner. Run fix-ownership.sql as postgres first.';
END $$;

-- Users: last login tracking
DO $$ BEGIN
  ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMP;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipping users ALTER - not owner.';
END $$;

-- Alerts: extra context fields
DO $$ BEGIN
  ALTER TABLE alerts ADD COLUMN IF NOT EXISTS link_name VARCHAR(255);
  ALTER TABLE alerts ADD COLUMN IF NOT EXISTS campaign_name VARCHAR(255);
  ALTER TABLE alerts ADD COLUMN IF NOT EXISTS percent INTEGER;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipping alerts ALTER - not owner.';
END $$;

-- Clicks: OS field
DO $$ BEGIN
  ALTER TABLE clicks ADD COLUMN IF NOT EXISTS os VARCHAR(100);
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipping clicks ALTER - not owner.';
END $$;

-- WhatsApp groups: extra fields
DO $$ BEGIN
  ALTER TABLE whatsapp_groups ADD COLUMN IF NOT EXISTS max_members INTEGER DEFAULT 1024;
  ALTER TABLE whatsapp_groups ADD COLUMN IF NOT EXISTS member_snapshot JSONB;
  ALTER TABLE whatsapp_groups ADD COLUMN IF NOT EXISTS invite_code VARCHAR(255);
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipping whatsapp_groups ALTER - not owner.';
END $$;

-- Campaigns: sequential counter persistence (survives server restarts)
DO $$ BEGIN
  ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS sequential_counter INTEGER DEFAULT 0;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipping campaigns sequential_counter ALTER - not owner.';
END $$;

-- Member events: source field
DO $$ BEGIN
  ALTER TABLE member_events ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'realtime';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Skipping member_events ALTER - not owner.';
END $$;

-- Index on campaign slug for redirect lookups
CREATE INDEX IF NOT EXISTS idx_campaigns_slug ON campaigns(slug);

-- Reset false positive health_check_failures (from false positive detections)
UPDATE links SET health_check_failures = 0 WHERE health_check_failures > 0 AND is_active = true;

-- ===== NEW FEATURES: Multi-WhatsApp, Broadcast, Lead Backup, Shopee =====

-- WhatsApp Numbers: support for multiple connected numbers
CREATE TABLE IF NOT EXISTS whatsapp_numbers (
    id VARCHAR(255) PRIMARY KEY,
    phone_number VARCHAR(50),
    label VARCHAR(255) DEFAULT '',
    status VARCHAR(50) DEFAULT 'disconnected',
    is_primary BOOLEAN DEFAULT false,
    use_for_broadcast BOOLEAN DEFAULT true,
    session_data_path VARCHAR(500),
    warm_up_start TIMESTAMP,
    messages_sent_today INTEGER DEFAULT 0,
    messages_sent_total INTEGER DEFAULT 0,
    last_message_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Broadcast Messages: message templates and sends
CREATE TABLE IF NOT EXISTS broadcast_messages (
    id SERIAL PRIMARY KEY,
    message_text TEXT NOT NULL,
    media_url TEXT,
    media_type VARCHAR(50),
    target_type VARCHAR(50) DEFAULT 'groups',
    target_ids TEXT[],
    mention_all BOOLEAN DEFAULT false,
    sent_by VARCHAR(255),
    status VARCHAR(50) DEFAULT 'pending',
    total_targets INTEGER DEFAULT 0,
    total_sent INTEGER DEFAULT 0,
    total_failed INTEGER DEFAULT 0,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Broadcast Logs: individual send tracking
CREATE TABLE IF NOT EXISTS broadcast_logs (
    id SERIAL PRIMARY KEY,
    broadcast_id INTEGER REFERENCES broadcast_messages(id) ON DELETE CASCADE,
    target_id VARCHAR(255),
    target_name VARCHAR(255),
    whatsapp_number_id VARCHAR(255),
    status VARCHAR(50) DEFAULT 'pending',
    error_message TEXT,
    sent_at TIMESTAMP
);

-- Lead Contacts: backup of real phone numbers for re-inviting
CREATE TABLE IF NOT EXISTS lead_contacts (
    id SERIAL PRIMARY KEY,
    phone VARCHAR(50) NOT NULL,
    whatsapp_group_id VARCHAR(255),
    group_name VARCHAR(255),
    joined_at TIMESTAMP DEFAULT NOW(),
    left_at TIMESTAMP,
    is_active BOOLEAN DEFAULT true,
    invite_sent BOOLEAN DEFAULT false,
    invite_sent_at TIMESTAMP,
    UNIQUE(phone, whatsapp_group_id)
);

-- Shopee Commissions: imported commission data
CREATE TABLE IF NOT EXISTS shopee_commissions (
    id SERIAL PRIMARY KEY,
    order_id VARCHAR(255),
    item_id VARCHAR(255),
    item_name VARCHAR(500),
    shop_name VARCHAR(255),
    order_amount DECIMAL(10,2) DEFAULT 0,
    commission DECIMAL(10,2) DEFAULT 0,
    commission_rate DECIMAL(5,2) DEFAULT 0,
    status VARCHAR(50),
    sub_id VARCHAR(255),
    order_created_at TIMESTAMP,
    click_time TIMESTAMP,
    imported_at TIMESTAMP DEFAULT NOW()
);

-- Shopee Affiliate Links: generated links
CREATE TABLE IF NOT EXISTS shopee_links (
    id SERIAL PRIMARY KEY,
    original_url TEXT,
    affiliate_url TEXT,
    sub_id VARCHAR(255) DEFAULT 'whatsapp',
    product_name VARCHAR(500),
    product_image TEXT,
    price DECIMAL(10,2),
    commission_rate DECIMAL(5,2),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for new tables
CREATE INDEX IF NOT EXISTS idx_lead_contacts_group ON lead_contacts(whatsapp_group_id);
CREATE INDEX IF NOT EXISTS idx_lead_contacts_phone ON lead_contacts(phone);
CREATE INDEX IF NOT EXISTS idx_lead_contacts_active ON lead_contacts(is_active);
CREATE INDEX IF NOT EXISTS idx_broadcast_logs_broadcast ON broadcast_logs(broadcast_id);
CREATE INDEX IF NOT EXISTS idx_shopee_commissions_subid ON shopee_commissions(sub_id);
CREATE INDEX IF NOT EXISTS idx_shopee_commissions_date ON shopee_commissions(order_created_at);
CREATE INDEX IF NOT EXISTS idx_member_events_source ON member_events(source);

-- Grant permissions (will only work if run by a superuser or table owner)
DO $$ BEGIN
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO linkrotator;
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO linkrotator;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Could not grant privileges - run as postgres superuser to fix ownership.';
END $$;
