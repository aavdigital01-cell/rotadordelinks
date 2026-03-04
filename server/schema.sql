-- LinkRotator PostgreSQL Schema (complete)

-- Configura fuso horário do Brasil para todas as operações
SET timezone = 'America/Sao_Paulo';
ALTER DATABASE linkrotator_db SET timezone TO 'America/Sao_Paulo';

CREATE TABLE IF NOT EXISTS campaigns (
    id VARCHAR(255) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255),
    rotation_mode VARCHAR(50) DEFAULT 'random',
    alert_threshold INTEGER DEFAULT 90,
    is_active BOOLEAN DEFAULT true,
    fb_pixel_id VARCHAR(255) DEFAULT '',
    fb_event_name VARCHAR(100) DEFAULT 'Lead',
    tt_pixel_id VARCHAR(255) DEFAULT '',
    tt_event_name VARCHAR(100) DEFAULT 'SubmitForm',
    gtm_id VARCHAR(255) DEFAULT '',
    gtm_event_name VARCHAR(100) DEFAULT 'whatsapp_click',
    gads_id VARCHAR(255) DEFAULT '',
    gads_conversion_label VARCHAR(255) DEFAULT '',
    sequential_counter INTEGER DEFAULT 0,
    created_by VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS links (
    id VARCHAR(255) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    url TEXT DEFAULT '',
    campaign_id VARCHAR(255),
    whatsapp_group_id VARCHAR(255),
    current_clicks INTEGER DEFAULT 0,
    max_vacancies INTEGER DEFAULT 1000,
    weight INTEGER DEFAULT 1,
    is_active BOOLEAN DEFAULT true,
    is_full BOOLEAN DEFAULT false,
    redirect_type VARCHAR(50) DEFAULT 'whatsapp',
    health_check_failures INTEGER DEFAULT 0,
    deactivated_reason TEXT,
    deactivated_at TIMESTAMP,
    created_by VARCHAR(255),
    order_num INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clicks (
    id SERIAL PRIMARY KEY,
    link_id VARCHAR(255),
    link_name VARCHAR(255),
    campaign_id VARCHAR(255),
    device VARCHAR(100),
    browser VARCHAR(100),
    os VARCHAR(100),
    city VARCHAR(100),
    country VARCHAR(100),
    country_code VARCHAR(10),
    ip VARCHAR(45),
    referrer TEXT,
    timestamp TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS whatsapp_groups (
    id VARCHAR(255) PRIMARY KEY,
    group_name VARCHAR(255),
    current_members INTEGER DEFAULT 0,
    max_members INTEGER DEFAULT 1024,
    invite_code VARCHAR(255),
    member_snapshot JSONB,
    last_scanned TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS member_events (
    id SERIAL PRIMARY KEY,
    whatsapp_group_id VARCHAR(255),
    group_name VARCHAR(255),
    phone VARCHAR(255),
    phone_partial VARCHAR(10),
    action VARCHAR(10) CHECK (action IN ('join', 'leave')),
    source VARCHAR(20) DEFAULT 'realtime',
    timestamp TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS meta_campaigns (
    id VARCHAR(255) PRIMARY KEY,
    name VARCHAR(255),
    status VARCHAR(50),
    objective VARCHAR(100),
    daily_budget DECIMAL(10,2) DEFAULT 0,
    spend DECIMAL(10,2) DEFAULT 0,
    impressions INTEGER DEFAULT 0,
    clicks INTEGER DEFAULT 0,
    cpc DECIMAL(10,4) DEFAULT 0,
    cpm DECIMAL(10,4) DEFAULT 0,
    ctr DECIMAL(10,4) DEFAULT 0,
    reach INTEGER DEFAULT 0,
    conversions INTEGER DEFAULT 0,
    cost_per_result DECIMAL(10,4) DEFAULT 0,
    last_synced TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS alerts (
    id SERIAL PRIMARY KEY,
    type VARCHAR(100),
    whatsapp_group_id VARCHAR(255),
    group_name VARCHAR(255),
    member_phone VARCHAR(255),
    link_name VARCHAR(255),
    campaign_name VARCHAR(255),
    percent INTEGER,
    message TEXT DEFAULT '',
    read BOOLEAN DEFAULT false,
    timestamp TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
    uid VARCHAR(255) PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    display_name VARCHAR(255),
    role VARCHAR(50) DEFAULT 'admin',
    created_by VARCHAR(255),
    last_login TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
    key VARCHAR(255) PRIMARY KEY,
    value JSONB DEFAULT '{}',
    updated_at TIMESTAMP DEFAULT NOW()
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

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_clicks_timestamp ON clicks(timestamp);
CREATE INDEX IF NOT EXISTS idx_clicks_link_id ON clicks(link_id);
CREATE INDEX IF NOT EXISTS idx_clicks_campaign_id ON clicks(campaign_id);
CREATE INDEX IF NOT EXISTS idx_member_events_timestamp ON member_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_member_events_group ON member_events(whatsapp_group_id);
CREATE INDEX IF NOT EXISTS idx_member_events_action ON member_events(action);
CREATE INDEX IF NOT EXISTS idx_member_events_source ON member_events(source);
CREATE INDEX IF NOT EXISTS idx_alerts_read ON alerts(read);
CREATE INDEX IF NOT EXISTS idx_alerts_timestamp ON alerts(timestamp);
CREATE INDEX IF NOT EXISTS idx_links_campaign ON links(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_slug ON campaigns(slug);
CREATE INDEX IF NOT EXISTS idx_lead_contacts_group ON lead_contacts(whatsapp_group_id);
CREATE INDEX IF NOT EXISTS idx_lead_contacts_phone ON lead_contacts(phone);
CREATE INDEX IF NOT EXISTS idx_lead_contacts_active ON lead_contacts(is_active);
CREATE INDEX IF NOT EXISTS idx_broadcast_logs_broadcast ON broadcast_logs(broadcast_id);
CREATE INDEX IF NOT EXISTS idx_shopee_commissions_subid ON shopee_commissions(sub_id);
