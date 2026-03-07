#!/bin/bash
# ============================================
# LinkRotator Pro - Setup VPS
# Instala tudo automaticamente
# Usa: Node.js + PostgreSQL + Evolution API (Docker)
# ============================================

echo ""
echo "==========================================="
echo "  LinkRotator Pro - Instalando no VPS"
echo "==========================================="
echo ""

# Verifica se Node.js >= 20 está instalado
NODE_VERSION=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ -z "$NODE_VERSION" ] || [ "$NODE_VERSION" -lt 20 ]; then
  echo "[ERRO] Node.js >= 20 é necessário."
  echo "  Instale com: curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs"
  exit 1
fi
echo "[OK] Node.js $(node -v) detectado"

# Verifica se Docker está instalado
if ! command -v docker &>/dev/null; then
  echo "[ERRO] Docker é necessário para rodar a Evolution API."
  echo "  Instale com: curl -fsSL https://get.docker.com | bash"
  exit 1
fi
echo "[OK] Docker detectado"

# Cria diretórios
mkdir -p /root/rotadordelinks/server
cd /root/rotadordelinks/server

echo ""
echo "[1/4] Instalando dependências Node.js..."
npm install

echo ""
echo "[2/4] Configurando Evolution API (Docker)..."
mkdir -p /opt/evolution-api
cat > /opt/evolution-api/docker-compose.yml << 'EOF'
services:
  evolution-api:
    image: atendai/evolution-api:latest
    restart: always
    ports:
      - "8080:8080"
    environment:
      - AUTHENTICATION_API_KEY=TROQUE_POR_SUA_CHAVE_SECRETA
      - AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES=true
      - DATABASE_PROVIDER=postgresql
      - DATABASE_CONNECTION_URI=postgresql://postgres:evo_pass_2026@postgres:5432/evolution
      - DATABASE_URL=postgresql://postgres:evo_pass_2026@postgres:5432/evolution
      - CACHE_REDIS_ENABLED=true
      - CACHE_REDIS_URI=redis://redis:6379
      - CACHE_REDIS_PREFIX_KEY=evolution
      - CACHE_LOCAL_ENABLED=false
    volumes:
      - evolution_instances:/evolution/instances
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_started
  redis:
    image: redis:7-alpine
    restart: always
    command: redis-server --appendonly yes
    volumes:
      - redis_data:/data
  postgres:
    image: postgres:15-alpine
    restart: always
    environment:
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=evo_pass_2026
      - POSTGRES_DB=evolution
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5
volumes:
  evolution_instances:
  redis_data:
  postgres_data:
EOF

echo "[3/4] Subindo Evolution API..."
cd /opt/evolution-api && docker compose up -d
cd /root/rotadordelinks/server

echo ""
echo "[4/4] Criando .env (se não existir)..."
if [ ! -f .env ]; then
  cp .env.example .env
  echo "[OK] .env criado a partir do .env.example"
  echo "[ATENÇÃO] Edite o .env com suas configurações!"
else
  echo "[OK] .env já existe"
fi

echo ""
echo "==========================================="
echo "  INSTALAÇÃO CONCLUÍDA!"
echo "==========================================="
echo ""
echo "  Próximos passos:"
echo ""
echo "  1. Configure a chave da Evolution API:"
echo "     Edite /opt/evolution-api/docker-compose.yml"
echo "     Troque AUTHENTICATION_API_KEY por uma chave segura"
echo "     Depois: cd /opt/evolution-api && docker compose up -d"
echo ""
echo "  2. Configure o .env do servidor:"
echo "     nano /root/rotadordelinks/server/.env"
echo "     - EVOLUTION_API_URL=http://localhost:8080"
echo "     - EVOLUTION_API_KEY=SuaChaveSecretaAqui (mesma do passo 1)"
echo "     - PG_HOST, PG_PASSWORD, etc."
echo ""
echo "  3. Configure o PostgreSQL do app:"
echo "     psql -h localhost -U linkrotator linkrotator_db < schema.sql"
echo ""
echo "  4. Inicie o servidor:"
echo "     cd /root/rotadordelinks/server && node index.js"
echo ""
echo "==========================================="
