-- Fix table ownership: Run this as postgres superuser
-- Usage: sudo -u postgres psql -d linkrotator_db -f fix-ownership.sql

-- Transfer ownership of all existing tables to linkrotator
ALTER TABLE IF EXISTS campaigns OWNER TO linkrotator;
ALTER TABLE IF EXISTS links OWNER TO linkrotator;
ALTER TABLE IF EXISTS clicks OWNER TO linkrotator;
ALTER TABLE IF EXISTS users OWNER TO linkrotator;
ALTER TABLE IF EXISTS alerts OWNER TO linkrotator;
ALTER TABLE IF EXISTS whatsapp_groups OWNER TO linkrotator;
ALTER TABLE IF EXISTS member_events OWNER TO linkrotator;
ALTER TABLE IF EXISTS meta_campaigns OWNER TO linkrotator;
ALTER TABLE IF EXISTS settings OWNER TO linkrotator;
ALTER TABLE IF EXISTS whatsapp_numbers OWNER TO linkrotator;
ALTER TABLE IF EXISTS broadcast_messages OWNER TO linkrotator;
ALTER TABLE IF EXISTS broadcast_logs OWNER TO linkrotator;
ALTER TABLE IF EXISTS lead_contacts OWNER TO linkrotator;
ALTER TABLE IF EXISTS shopee_commissions OWNER TO linkrotator;
ALTER TABLE IF EXISTS shopee_links OWNER TO linkrotator;

-- Transfer ownership of all sequences
DO $$
DECLARE
  seq RECORD;
BEGIN
  FOR seq IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER SEQUENCE %I OWNER TO linkrotator', seq.sequencename);
  END LOOP;
END $$;

-- Grant full privileges
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO linkrotator;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO linkrotator;
GRANT ALL PRIVILEGES ON SCHEMA public TO linkrotator;

-- Set default privileges for future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO linkrotator;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO linkrotator;
