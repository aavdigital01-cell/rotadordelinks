-- ============================================
-- MULTI-TENANT MIGRATION
-- Converte o LinkRotator Pro para SaaS multi-tenant
-- Cada usuário vê apenas seus próprios dados
-- ============================================

-- 1. Adicionar owner_uid em todas as tabelas de dados

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS owner_uid VARCHAR(255);
ALTER TABLE links ADD COLUMN IF NOT EXISTS owner_uid VARCHAR(255);
ALTER TABLE clicks ADD COLUMN IF NOT EXISTS owner_uid VARCHAR(255);
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS owner_uid VARCHAR(255);
ALTER TABLE member_events ADD COLUMN IF NOT EXISTS owner_uid VARCHAR(255);
ALTER TABLE whatsapp_groups ADD COLUMN IF NOT EXISTS owner_uid VARCHAR(255);
ALTER TABLE whatsapp_numbers ADD COLUMN IF NOT EXISTS owner_uid VARCHAR(255);
ALTER TABLE broadcast_messages ADD COLUMN IF NOT EXISTS owner_uid VARCHAR(255);
ALTER TABLE broadcast_logs ADD COLUMN IF NOT EXISTS owner_uid VARCHAR(255);
ALTER TABLE lead_contacts ADD COLUMN IF NOT EXISTS owner_uid VARCHAR(255);
ALTER TABLE shopee_links ADD COLUMN IF NOT EXISTS owner_uid VARCHAR(255);
ALTER TABLE shopee_commissions ADD COLUMN IF NOT EXISTS owner_uid VARCHAR(255);
ALTER TABLE meta_campaigns ADD COLUMN IF NOT EXISTS owner_uid VARCHAR(255);

-- 2. Settings: adicionar owner_uid e mudar PK para (key, owner_uid)
ALTER TABLE settings ADD COLUMN IF NOT EXISTS owner_uid VARCHAR(255) DEFAULT '__global__';
ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_pkey;
ALTER TABLE settings ADD PRIMARY KEY (key, owner_uid);

-- 3. Indexes para performance em queries filtradas por owner_uid

CREATE INDEX IF NOT EXISTS idx_campaigns_owner ON campaigns(owner_uid);
CREATE INDEX IF NOT EXISTS idx_links_owner ON links(owner_uid);
CREATE INDEX IF NOT EXISTS idx_clicks_owner ON clicks(owner_uid);
CREATE INDEX IF NOT EXISTS idx_clicks_owner_timestamp ON clicks(owner_uid, timestamp);
CREATE INDEX IF NOT EXISTS idx_alerts_owner ON alerts(owner_uid);
CREATE INDEX IF NOT EXISTS idx_alerts_owner_read ON alerts(owner_uid, read);
CREATE INDEX IF NOT EXISTS idx_member_events_owner ON member_events(owner_uid);
CREATE INDEX IF NOT EXISTS idx_member_events_owner_timestamp ON member_events(owner_uid, timestamp);
CREATE INDEX IF NOT EXISTS idx_whatsapp_groups_owner ON whatsapp_groups(owner_uid);
CREATE INDEX IF NOT EXISTS idx_whatsapp_numbers_owner ON whatsapp_numbers(owner_uid);
CREATE INDEX IF NOT EXISTS idx_broadcast_messages_owner ON broadcast_messages(owner_uid);
CREATE INDEX IF NOT EXISTS idx_broadcast_logs_owner ON broadcast_logs(owner_uid);
CREATE INDEX IF NOT EXISTS idx_lead_contacts_owner ON lead_contacts(owner_uid);
CREATE INDEX IF NOT EXISTS idx_shopee_links_owner ON shopee_links(owner_uid);
CREATE INDEX IF NOT EXISTS idx_shopee_commissions_owner ON shopee_commissions(owner_uid);
CREATE INDEX IF NOT EXISTS idx_meta_campaigns_owner ON meta_campaigns(owner_uid);
CREATE INDEX IF NOT EXISTS idx_settings_owner ON settings(owner_uid);

-- 4. Slug deve ser globalmente único (redirect público sem auth)
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaigns_slug_unique ON campaigns(slug) WHERE slug IS NOT NULL AND slug != '';

-- 5. Migrar dados existentes para o SuperAdmin atual

DO $$
DECLARE
  sa_uid VARCHAR(255);
BEGIN
  SELECT uid INTO sa_uid FROM users WHERE role='superadmin' LIMIT 1;

  IF sa_uid IS NULL THEN
    RAISE NOTICE 'Nenhum superadmin encontrado. Dados ficarão sem owner_uid até que um superadmin seja criado.';
    RETURN;
  END IF;

  UPDATE campaigns SET owner_uid = sa_uid WHERE owner_uid IS NULL;
  UPDATE links SET owner_uid = sa_uid WHERE owner_uid IS NULL;
  UPDATE clicks SET owner_uid = sa_uid WHERE owner_uid IS NULL;
  UPDATE alerts SET owner_uid = sa_uid WHERE owner_uid IS NULL;
  UPDATE member_events SET owner_uid = sa_uid WHERE owner_uid IS NULL;
  UPDATE whatsapp_groups SET owner_uid = sa_uid WHERE owner_uid IS NULL;
  UPDATE whatsapp_numbers SET owner_uid = sa_uid WHERE owner_uid IS NULL;
  UPDATE broadcast_messages SET owner_uid = sa_uid WHERE owner_uid IS NULL;
  UPDATE broadcast_logs SET owner_uid = sa_uid WHERE owner_uid IS NULL;
  UPDATE lead_contacts SET owner_uid = sa_uid WHERE owner_uid IS NULL;
  UPDATE shopee_links SET owner_uid = sa_uid WHERE owner_uid IS NULL;
  UPDATE shopee_commissions SET owner_uid = sa_uid WHERE owner_uid IS NULL;
  UPDATE meta_campaigns SET owner_uid = sa_uid WHERE owner_uid IS NULL;
  UPDATE settings SET owner_uid = sa_uid WHERE owner_uid = '__global__';

  RAISE NOTICE 'Todos os dados migrados para superadmin: %', sa_uid;
END $$;

-- 6. Tornar owner_uid NOT NULL nas tabelas core (após migração)
ALTER TABLE campaigns ALTER COLUMN owner_uid SET NOT NULL;
ALTER TABLE links ALTER COLUMN owner_uid SET NOT NULL;
