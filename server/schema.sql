-- LinkRotator PostgreSQL Schema

CREATE TABLE IF NOT EXISTS campaigns (
    id VARCHAR(255) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    is_active BOOLEAN DEFAULT true,
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
    is_active BOOLEAN DEFAULT true,
    redirect_type VARCHAR(50) DEFAULT 'whatsapp',
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
    last_scanned TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS member_events (
    id SERIAL PRIMARY KEY,
    whatsapp_group_id VARCHAR(255),
    group_name VARCHAR(255),
    phone VARCHAR(255),
    phone_partial VARCHAR(10),
    action VARCHAR(10) CHECK (action IN ('join', 'leave')),
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
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
    key VARCHAR(255) PRIMARY KEY,
    value JSONB DEFAULT '{}',
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_clicks_timestamp ON clicks(timestamp);
CREATE INDEX IF NOT EXISTS idx_clicks_link_id ON clicks(link_id);
CREATE INDEX IF NOT EXISTS idx_clicks_campaign_id ON clicks(campaign_id);
CREATE INDEX IF NOT EXISTS idx_member_events_timestamp ON member_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_member_events_group ON member_events(whatsapp_group_id);
CREATE INDEX IF NOT EXISTS idx_member_events_action ON member_events(action);
CREATE INDEX IF NOT EXISTS idx_alerts_read ON alerts(read);
CREATE INDEX IF NOT EXISTS idx_alerts_timestamp ON alerts(timestamp);
CREATE INDEX IF NOT EXISTS idx_links_campaign ON links(campaign_id);
