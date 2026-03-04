-- Migration: Adicionar FOREIGN KEY com ON DELETE CASCADE/SET NULL
-- Para banco de dados existente na VPS
--
-- USO:
--   sudo -u postgres psql -d linkrotator_db -f /root/rotadordelinks/server/migration-cascade.sql
--
-- IMPORTANTE: Faz backup antes!
--   sudo -u postgres pg_dump linkrotator_db > /root/backup_antes_cascade_$(date +%Y%m%d_%H%M%S).sql

SET timezone = 'America/Sao_Paulo';

-- ============================================================
-- 1) Limpar registros órfãos ANTES de criar as constraints
--    (senão o ALTER TABLE falha se existir dado inconsistente)
-- ============================================================

-- Links com campaign_id que não existe mais
DELETE FROM clicks WHERE campaign_id IS NOT NULL AND campaign_id NOT IN (SELECT id FROM campaigns);
DELETE FROM clicks WHERE link_id IS NOT NULL AND link_id NOT IN (SELECT id FROM links);
DELETE FROM links WHERE campaign_id IS NOT NULL AND campaign_id NOT IN (SELECT id FROM campaigns);

-- Links com whatsapp_group_id que não existe — só limpa a referência
UPDATE links SET whatsapp_group_id = NULL WHERE whatsapp_group_id IS NOT NULL AND whatsapp_group_id NOT IN (SELECT id FROM whatsapp_groups);

-- Member events com grupo inexistente
DELETE FROM member_events WHERE whatsapp_group_id IS NOT NULL AND whatsapp_group_id NOT IN (SELECT id FROM whatsapp_groups);

-- Alerts com grupo inexistente — só limpa a referência
UPDATE alerts SET whatsapp_group_id = NULL WHERE whatsapp_group_id IS NOT NULL AND whatsapp_group_id NOT IN (SELECT id FROM whatsapp_groups);

-- Lead contacts com grupo inexistente — só limpa a referência
UPDATE lead_contacts SET whatsapp_group_id = NULL WHERE whatsapp_group_id IS NOT NULL AND whatsapp_group_id NOT IN (SELECT id FROM whatsapp_groups);

-- ============================================================
-- 2) Adicionar FOREIGN KEYS (idempotente: só cria se não existir)
-- ============================================================

-- links.campaign_id -> campaigns.id ON DELETE CASCADE
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'fk_links_campaign' AND table_name = 'links') THEN
    ALTER TABLE links ADD CONSTRAINT fk_links_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE;
    RAISE NOTICE 'FK fk_links_campaign criada com sucesso';
  ELSE
    RAISE NOTICE 'FK fk_links_campaign já existe, pulando';
  END IF;
END $$;

-- links.whatsapp_group_id -> whatsapp_groups.id ON DELETE SET NULL
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'fk_links_whatsapp_group' AND table_name = 'links') THEN
    ALTER TABLE links ADD CONSTRAINT fk_links_whatsapp_group FOREIGN KEY (whatsapp_group_id) REFERENCES whatsapp_groups(id) ON DELETE SET NULL;
    RAISE NOTICE 'FK fk_links_whatsapp_group criada com sucesso';
  ELSE
    RAISE NOTICE 'FK fk_links_whatsapp_group já existe, pulando';
  END IF;
END $$;

-- clicks.link_id -> links.id ON DELETE CASCADE
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'fk_clicks_link' AND table_name = 'clicks') THEN
    ALTER TABLE clicks ADD CONSTRAINT fk_clicks_link FOREIGN KEY (link_id) REFERENCES links(id) ON DELETE CASCADE;
    RAISE NOTICE 'FK fk_clicks_link criada com sucesso';
  ELSE
    RAISE NOTICE 'FK fk_clicks_link já existe, pulando';
  END IF;
END $$;

-- clicks.campaign_id -> campaigns.id ON DELETE CASCADE
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'fk_clicks_campaign' AND table_name = 'clicks') THEN
    ALTER TABLE clicks ADD CONSTRAINT fk_clicks_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE;
    RAISE NOTICE 'FK fk_clicks_campaign criada com sucesso';
  ELSE
    RAISE NOTICE 'FK fk_clicks_campaign já existe, pulando';
  END IF;
END $$;

-- member_events.whatsapp_group_id -> whatsapp_groups.id ON DELETE CASCADE
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'fk_member_events_group' AND table_name = 'member_events') THEN
    ALTER TABLE member_events ADD CONSTRAINT fk_member_events_group FOREIGN KEY (whatsapp_group_id) REFERENCES whatsapp_groups(id) ON DELETE CASCADE;
    RAISE NOTICE 'FK fk_member_events_group criada com sucesso';
  ELSE
    RAISE NOTICE 'FK fk_member_events_group já existe, pulando';
  END IF;
END $$;

-- alerts.whatsapp_group_id -> whatsapp_groups.id ON DELETE SET NULL
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'fk_alerts_whatsapp_group' AND table_name = 'alerts') THEN
    ALTER TABLE alerts ADD CONSTRAINT fk_alerts_whatsapp_group FOREIGN KEY (whatsapp_group_id) REFERENCES whatsapp_groups(id) ON DELETE SET NULL;
    RAISE NOTICE 'FK fk_alerts_whatsapp_group criada com sucesso';
  ELSE
    RAISE NOTICE 'FK fk_alerts_whatsapp_group já existe, pulando';
  END IF;
END $$;

-- lead_contacts.whatsapp_group_id -> whatsapp_groups.id ON DELETE SET NULL
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'fk_lead_contacts_group' AND table_name = 'lead_contacts') THEN
    ALTER TABLE lead_contacts ADD CONSTRAINT fk_lead_contacts_group FOREIGN KEY (whatsapp_group_id) REFERENCES whatsapp_groups(id) ON DELETE SET NULL;
    RAISE NOTICE 'FK fk_lead_contacts_group criada com sucesso';
  ELSE
    RAISE NOTICE 'FK fk_lead_contacts_group já existe, pulando';
  END IF;
END $$;

-- broadcast_logs.broadcast_id já tem FK no schema original, mas garante
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'broadcast_logs_broadcast_id_fkey' AND table_name = 'broadcast_logs')
     AND NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'fk_broadcast_logs_message' AND table_name = 'broadcast_logs') THEN
    ALTER TABLE broadcast_logs ADD CONSTRAINT fk_broadcast_logs_message FOREIGN KEY (broadcast_id) REFERENCES broadcast_messages(id) ON DELETE CASCADE;
    RAISE NOTICE 'FK fk_broadcast_logs_message criada com sucesso';
  ELSE
    RAISE NOTICE 'FK broadcast_logs já existe, pulando';
  END IF;
END $$;

-- ============================================================
-- Pronto! Verifique as constraints criadas:
-- ============================================================
SELECT
  tc.table_name,
  tc.constraint_name,
  kcu.column_name,
  ccu.table_name AS foreign_table,
  ccu.column_name AS foreign_column
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
ORDER BY tc.table_name;
