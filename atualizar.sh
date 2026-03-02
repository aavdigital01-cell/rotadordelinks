#!/bin/bash
# ============================================
# LinkRotator Pro - Atualizar
# Puxa as últimas mudanças e reinicia tudo
# ============================================

REPO_DIR="/root/rotadordelinks"
SERVER_DIR="/root/rotadordelinks/server"
BRANCH="claude/whatsapp-link-rotator-ElC9M"

echo ""
echo "==========================================="
echo "  LinkRotator Pro - Atualizando..."
echo "==========================================="
echo ""

cd "$REPO_DIR" || { echo "ERRO: Pasta $REPO_DIR não encontrada!"; exit 1; }

# 1. Puxa as últimas mudanças do GitHub
echo "[1/4] Baixando atualizações do GitHub..."
git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"
echo "      OK!"
echo ""

# 2. Instala/atualiza dependências do servidor
echo "[2/4] Atualizando dependências..."
cd "$SERVER_DIR" || { echo "ERRO: Pasta server não encontrada!"; exit 1; }
npm install --production
echo "      OK!"
echo ""

# 3. Reinicia o servidor com PM2
echo "[3/4] Reiniciando servidor..."
if pm2 describe linkrotator > /dev/null 2>&1; then
    pm2 restart linkrotator
    echo "      Servidor reiniciado!"
else
    pm2 start "$SERVER_DIR/index.js" --name linkrotator
    pm2 save
    echo "      Servidor iniciado!"
fi
echo ""

# 4. Mostra status
echo "[4/4] Status atual:"
echo ""
pm2 status linkrotator
echo ""
echo "==========================================="
echo "  Atualização concluída!"
echo "==========================================="
echo ""
echo "  Comandos úteis:"
echo "    pm2 logs linkrotator   - Ver logs"
echo "    pm2 status             - Ver status"
echo "    atualizar              - Atualizar novamente"
echo ""
