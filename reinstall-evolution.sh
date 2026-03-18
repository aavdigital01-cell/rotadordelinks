#!/bin/bash
# ============================================
# Evolution API - Reinstalação Limpa do Zero
# Remove tudo e instala novamente
# ============================================

set -e

echo ""
echo "==========================================="
echo "  Evolution API - Reinstalação Limpa"
echo "==========================================="
echo ""

# ===== ETAPA 1: PARAR TUDO =====
echo "[1/6] Parando todos os containers Evolution API..."

# Para docker-compose se existir
if [ -f /opt/evolution-api/docker-compose.yml ]; then
    cd /opt/evolution-api
    docker compose down -v 2>/dev/null || docker-compose down -v 2>/dev/null || true
    echo "  -> docker-compose parado e volumes removidos"
fi

# Para qualquer container avulso com nome evolution
for c in $(docker ps -aq --filter "name=evolution" 2>/dev/null); do
    docker stop "$c" 2>/dev/null || true
    docker rm -f "$c" 2>/dev/null || true
    echo "  -> Container $c removido"
done

echo "  OK"

# ===== ETAPA 2: LIMPAR VOLUMES E DADOS =====
echo ""
echo "[2/6] Removendo volumes e dados antigos..."

# Remove volumes Docker relacionados
for v in $(docker volume ls -q 2>/dev/null | grep -i "evolution\|evo_"); do
    docker volume rm "$v" 2>/dev/null || true
    echo "  -> Volume $v removido"
done

# Remove diretório antigo
rm -rf /opt/evolution-api
echo "  -> /opt/evolution-api removido"

# Limpa imagens antigas
docker image rm atendai/evolution-api:latest 2>/dev/null || true
echo "  -> Imagem antiga removida (será baixada nova)"

echo "  OK"

# ===== ETAPA 3: CRIAR ESTRUTURA NOVA =====
echo ""
echo "[3/6] Criando estrutura nova..."

mkdir -p /opt/evolution-api
cd /opt/evolution-api

# Gera senha segura para o PostgreSQL
PG_PASS="evo_$(openssl rand -hex 8)"
# API Key segura para Evolution API
API_KEY="evo_$(openssl rand -hex 16)"

echo "  -> Diretório criado"
echo "  -> Senha PostgreSQL: $PG_PASS"
echo "  -> API Key: $API_KEY"

# ===== ETAPA 4: CRIAR DOCKER-COMPOSE =====
echo ""
echo "[4/6] Criando docker-compose.yml..."

cat > /opt/evolution-api/docker-compose.yml << ENDOFFILE
services:
  postgres:
    image: postgres:15-alpine
    container_name: evolution-postgres
    restart: always
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${PG_PASS}
      POSTGRES_DB: evolution
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d evolution"]
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 10s
    networks:
      - evolution-net

  redis:
    image: redis:7-alpine
    container_name: evolution-redis
    restart: always
    command: redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy allkeys-lru
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
    networks:
      - evolution-net

  evolution-api:
    image: atendai/evolution-api:latest
    container_name: evolution-api
    restart: always
    ports:
      - "8080:8080"
    environment:
      # Autenticação
      AUTHENTICATION_API_KEY: ${API_KEY}
      AUTHENTICATION_EXPOSE_IN_FETCH_INSTANCES: "true"
      # Banco de Dados
      DATABASE_PROVIDER: postgresql
      DATABASE_CONNECTION_URI: postgresql://postgres:${PG_PASS}@postgres:5432/evolution
      DATABASE_URL: postgresql://postgres:${PG_PASS}@postgres:5432/evolution
      # Cache Redis
      CACHE_REDIS_ENABLED: "true"
      CACHE_REDIS_URI: redis://redis:6379
      CACHE_REDIS_PREFIX_KEY: evolution
      CACHE_LOCAL_ENABLED: "false"
      # Log
      LOG_LEVEL: WARN
    volumes:
      - evolution_instances:/evolution/instances
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    networks:
      - evolution-net

volumes:
  postgres_data:
  redis_data:
  evolution_instances:

networks:
  evolution-net:
    driver: bridge
ENDOFFILE

echo "  OK"

# ===== ETAPA 5: SUBIR CONTAINERS =====
echo ""
echo "[5/6] Iniciando containers (pode demorar 1-2 min no primeiro pull)..."

cd /opt/evolution-api
docker compose pull
docker compose up -d

echo "  -> Aguardando PostgreSQL ficar saudável..."
for i in $(seq 1 30); do
    if docker inspect --format='{{.State.Health.Status}}' evolution-postgres 2>/dev/null | grep -q "healthy"; then
        echo "  -> PostgreSQL: healthy"
        break
    fi
    sleep 2
done

echo "  -> Aguardando Evolution API iniciar (30s)..."
sleep 30

# Verifica se está respondendo
echo ""
echo "[6/6] Verificando instalação..."

HTTP_CODE=$(curl -s -o /tmp/evo_response.txt -w "%{http_code}" http://localhost:8080/instance/fetchInstances -H "apikey: ${API_KEY}" 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ]; then
    echo ""
    echo "==========================================="
    echo "  SUCESSO! Evolution API instalada!"
    echo "==========================================="
    echo ""
    echo "  URL:      http://localhost:8080"
    echo "  API Key:  ${API_KEY}"
    echo "  PG Pass:  ${PG_PASS}"
    echo ""
    echo "  Containers:"
    docker ps --filter "network=evolution-api_evolution-net" --format "  {{.Names}}\t{{.Status}}"
    echo ""

    # Salva credenciais para referência
    cat > /opt/evolution-api/credentials.txt << CRED
# Evolution API - Credenciais (gerado em $(date))
EVOLUTION_API_URL=http://localhost:8080
EVOLUTION_API_KEY=${API_KEY}
PG_PASSWORD=${PG_PASS}
CRED
    chmod 600 /opt/evolution-api/credentials.txt
    echo "  Credenciais salvas em: /opt/evolution-api/credentials.txt"

    # Atualiza o .env do linkrotator se existir
    ENV_FILE="/root/rotadordelinks/server/.env"
    if [ -f "$ENV_FILE" ]; then
        echo ""
        echo "  Atualizando $ENV_FILE..."
        # Atualiza EVOLUTION_API_KEY
        if grep -q "EVOLUTION_API_KEY" "$ENV_FILE"; then
            sed -i "s|EVOLUTION_API_KEY=.*|EVOLUTION_API_KEY=${API_KEY}|" "$ENV_FILE"
        else
            echo "EVOLUTION_API_KEY=${API_KEY}" >> "$ENV_FILE"
        fi
        # Garante EVOLUTION_API_URL
        if grep -q "EVOLUTION_API_URL" "$ENV_FILE"; then
            sed -i "s|EVOLUTION_API_URL=.*|EVOLUTION_API_URL=http://localhost:8080|" "$ENV_FILE"
        else
            echo "EVOLUTION_API_URL=http://localhost:8080" >> "$ENV_FILE"
        fi
        echo "  -> .env atualizado com nova API Key"
        echo ""
        echo "  Reiniciando linkrotator..."
        pm2 restart linkrotator 2>/dev/null || true
        sleep 5
        echo "  -> linkrotator reiniciado"
    else
        echo ""
        echo "  ATENÇÃO: Atualize manualmente o .env do seu projeto:"
        echo "    EVOLUTION_API_URL=http://localhost:8080"
        echo "    EVOLUTION_API_KEY=${API_KEY}"
    fi

    echo ""
    echo "==========================================="
    echo "  Próximo passo: Conecte o WhatsApp pelo painel"
    echo "==========================================="
else
    echo ""
    echo "  ERRO: Evolution API não respondeu (HTTP $HTTP_CODE)"
    echo "  Resposta: $(cat /tmp/evo_response.txt 2>/dev/null)"
    echo ""
    echo "  Logs do container:"
    docker logs evolution-api --tail 30 2>&1
    echo ""
    echo "  Status dos containers:"
    docker ps -a --filter "name=evolution"
fi
