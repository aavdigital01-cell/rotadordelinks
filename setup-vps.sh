#!/bin/bash
# ============================================
# LinkRotator Pro - Setup VPS
# Instala tudo automaticamente
# ============================================

echo ""
echo "==========================================="
echo "  LinkRotator Pro - Instalando no VPS"
echo "==========================================="
echo ""

# Cria diretórios
mkdir -p /root/rotadordelinks/server
cd /root/rotadordelinks/server

echo "[1/5] Criando package.json..."
cat > package.json << 'ENDOFFILE'
{
  "name": "linkrotator-server",
  "version": "1.0.0",
  "description": "Backend para LinkRotator Pro - Meta Ads API + WhatsApp Monitor",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "dev": "node index.js"
  },
  "dependencies": {
    "cors": "^2.8.5",
    "dotenv": "^16.3.1",
    "express": "^4.18.2",
    "firebase-admin": "^12.0.0",
    "node-fetch": "^2.7.0",
    "qrcode": "^1.5.3",
    "qrcode-terminal": "^0.12.0",
    "whatsapp-web.js": "^1.23.0"
  }
}
ENDOFFILE

echo "[2/5] Criando index.js..."
cat > index.js << 'ENDOFFILE'
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const metaApi = require('./meta-api');
const whatsappMonitor = require('./whatsapp-monitor');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== FIREBASE ADMIN =====
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n')
  })
});
const db = admin.firestore();

// ===== MIDDLEWARE =====
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json());

// Auth middleware simples - verifica Firebase token
async function authMiddleware(req, res, next) {
  var token = req.headers.authorization;
  if (!token || !token.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token nao fornecido' });
  }
  try {
    var decoded = await admin.auth().verifyIdToken(token.split('Bearer ')[1]);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token invalido' });
  }
}

// ===== META ADS API ROUTES =====

// Listar campanhas do Meta
app.get('/api/meta/campaigns', authMiddleware, async function(req, res) {
  try {
    var campaigns = await metaApi.getCampaigns();
    res.json(campaigns);
  } catch (err) {
    console.error('Erro ao buscar campanhas Meta:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Insights de uma campanha especifica
app.get('/api/meta/campaigns/:id/insights', authMiddleware, async function(req, res) {
  try {
    var dateRange = req.query.date_range || 'last_7d';
    var insights = await metaApi.getCampaignInsights(req.params.id, dateRange);
    res.json(insights);
  } catch (err) {
    console.error('Erro ao buscar insights:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Insights gerais da conta
app.get('/api/meta/account/insights', authMiddleware, async function(req, res) {
  try {
    var dateRange = req.query.date_range || 'today';
    var insights = await metaApi.getAccountInsights(dateRange);
    res.json(insights);
  } catch (err) {
    console.error('Erro ao buscar insights da conta:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Atualizar status da campanha (ACTIVE, PAUSED)
app.post('/api/meta/campaigns/:id/status', authMiddleware, async function(req, res) {
  try {
    var result = await metaApi.updateCampaignStatus(req.params.id, req.body.status);
    res.json(result);
  } catch (err) {
    console.error('Erro ao atualizar status:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Atualizar orcamento da campanha
app.post('/api/meta/campaigns/:id/budget', authMiddleware, async function(req, res) {
  try {
    var result = await metaApi.updateCampaignBudget(req.params.id, req.body.budget, req.body.type);
    res.json(result);
  } catch (err) {
    console.error('Erro ao atualizar orcamento:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Adsets de uma campanha
app.get('/api/meta/campaigns/:id/adsets', authMiddleware, async function(req, res) {
  try {
    var adsets = await metaApi.getAdsets(req.params.id);
    res.json(adsets);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sincronizar dados Meta -> Firestore
app.post('/api/meta/sync', authMiddleware, async function(req, res) {
  try {
    await syncMetaToFirestore();
    res.json({ success: true, message: 'Dados sincronizados' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== WHATSAPP ROUTES =====

// Status da conexao
app.get('/api/whatsapp/status', authMiddleware, function(req, res) {
  res.json(whatsappMonitor.getStatus());
});

// QR Code para autenticar
app.get('/api/whatsapp/qr', authMiddleware, function(req, res) {
  var qr = whatsappMonitor.getQR();
  if (qr) {
    res.json({ qr: qr, status: 'waiting_scan' });
  } else if (whatsappMonitor.getStatus().connected) {
    res.json({ qr: null, status: 'connected' });
  } else {
    res.json({ qr: null, status: 'initializing' });
  }
});

// Listar grupos
app.get('/api/whatsapp/groups', authMiddleware, async function(req, res) {
  try {
    var groups = await whatsappMonitor.getGroups();
    res.json(groups);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dados de membros de um grupo
app.get('/api/whatsapp/groups/:id/members', authMiddleware, async function(req, res) {
  try {
    var members = await whatsappMonitor.getGroupMembers(req.params.id);
    res.json(members);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Vincular grupo WhatsApp a um link do rotador
app.post('/api/whatsapp/groups/:groupId/link', authMiddleware, async function(req, res) {
  try {
    var linkId = req.body.linkId;
    await db.collection('links').doc(linkId).update({
      whatsappGroupId: req.params.groupId
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== STATS COMBINADOS =====
app.get('/api/stats/overview', authMiddleware, async function(req, res) {
  try {
    var [metaInsights, groupStats] = await Promise.all([
      metaApi.getAccountInsights('today').catch(function() { return null; }),
      getGroupStats()
    ]);

    res.json({
      meta: metaInsights,
      groups: groupStats,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function getGroupStats() {
  var snap = await db.collection('group_members').get();
  var totalMembers = 0;
  var groups = [];
  snap.forEach(function(doc) {
    var data = doc.data();
    totalMembers += (data.currentMembers || 0);
    groups.push({ id: doc.id, ...data });
  });
  return { totalMembers: totalMembers, groups: groups };
}

// ===== SYNC META -> FIRESTORE =====
async function syncMetaToFirestore() {
  try {
    var campaigns = await metaApi.getCampaigns();
    if (!campaigns || !campaigns.data) return;

    var batch = db.batch();
    for (var camp of campaigns.data) {
      var insights = await metaApi.getCampaignInsights(camp.id, 'today');
      var insightData = insights && insights.data && insights.data[0] ? insights.data[0] : {};

      var ref = db.collection('meta_campaigns').doc(camp.id);
      batch.set(ref, {
        metaId: camp.id,
        name: camp.name,
        status: camp.status || camp.effective_status,
        objective: camp.objective,
        dailyBudget: camp.daily_budget ? parseFloat(camp.daily_budget) / 100 : 0,
        spend: insightData.spend ? parseFloat(insightData.spend) : 0,
        impressions: insightData.impressions ? parseInt(insightData.impressions) : 0,
        clicks: insightData.clicks ? parseInt(insightData.clicks) : 0,
        cpc: insightData.cpc ? parseFloat(insightData.cpc) : 0,
        cpm: insightData.cpm ? parseFloat(insightData.cpm) : 0,
        ctr: insightData.ctr ? parseFloat(insightData.ctr) : 0,
        reach: insightData.reach ? parseInt(insightData.reach) : 0,
        conversions: insightData.actions ? extractConversions(insightData.actions) : 0,
        costPerResult: insightData.cost_per_action_type ? extractCostPerResult(insightData.cost_per_action_type) : 0,
        lastSynced: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }
    await batch.commit();
    console.log('[META] Sincronizados ' + campaigns.data.length + ' campanhas');
  } catch (err) {
    console.error('[META] Erro na sincronizacao:', err.message);
  }
}

function extractConversions(actions) {
  if (!actions) return 0;
  var conv = actions.find(function(a) {
    return a.action_type === 'offsite_conversion.fb_pixel_lead' ||
           a.action_type === 'lead' ||
           a.action_type === 'onsite_conversion.messaging_first_reply';
  });
  return conv ? parseInt(conv.value) : 0;
}

function extractCostPerResult(costPerAction) {
  if (!costPerAction) return 0;
  var cost = costPerAction.find(function(a) {
    return a.action_type === 'offsite_conversion.fb_pixel_lead' ||
           a.action_type === 'lead';
  });
  return cost ? parseFloat(cost.value) : 0;
}

// Auto-sync a cada 5 minutos
setInterval(syncMetaToFirestore, 5 * 60 * 1000);

// ===== INICIA SERVIDOR =====
app.listen(PORT, function() {
  console.log('');
  console.log('===========================================');
  console.log('  LinkRotator Pro - Servidor Backend');
  console.log('  Rodando na porta ' + PORT);
  console.log('===========================================');
  console.log('');

  // Inicia WhatsApp Monitor
  whatsappMonitor.initialize(db);

  // Primeira sync do Meta
  if (process.env.META_ACCESS_TOKEN && process.env.META_ACCESS_TOKEN !== 'SEU_TOKEN_META_AQUI') {
    console.log('[META] Iniciando primeira sincronizacao...');
    syncMetaToFirestore();
  } else {
    console.log('[META] Token nao configurado. Configure META_ACCESS_TOKEN no .env');
  }
});
ENDOFFILE

echo "[3/5] Criando meta-api.js..."
cat > meta-api.js << 'ENDOFFILE'
/**
 * Meta (Facebook) Marketing API Module
 * Gerencia campanhas, adsets e coleta insights
 */

const fetch = require('node-fetch');

const BASE_URL = 'https://graph.facebook.com/v19.0';

function getToken() {
  return process.env.META_ACCESS_TOKEN;
}

function getAdAccountId() {
  return process.env.META_AD_ACCOUNT_ID;
}

async function apiCall(endpoint, method, body) {
  method = method || 'GET';
  var url = BASE_URL + endpoint;
  var separator = url.includes('?') ? '&' : '?';
  url += separator + 'access_token=' + getToken();

  var options = { method: method, headers: { 'Content-Type': 'application/json' } };
  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }

  var response = await fetch(url, options);
  var data = await response.json();

  if (data.error) {
    throw new Error(data.error.message || 'Meta API error');
  }

  return data;
}

// ===== CAMPANHAS =====

async function getCampaigns() {
  return await apiCall(
    '/' + getAdAccountId() + '/campaigns?fields=id,name,status,effective_status,objective,daily_budget,lifetime_budget,budget_remaining,created_time,updated_time&limit=100'
  );
}

async function getCampaignInsights(campaignId, dateRange) {
  var datePreset = convertDateRange(dateRange);
  return await apiCall(
    '/' + campaignId + '/insights?fields=spend,impressions,clicks,cpc,cpm,ctr,reach,frequency,actions,cost_per_action_type,cost_per_unique_click,unique_clicks,unique_ctr&date_preset=' + datePreset
  );
}

async function getAccountInsights(dateRange) {
  var datePreset = convertDateRange(dateRange);
  return await apiCall(
    '/' + getAdAccountId() + '/insights?fields=spend,impressions,clicks,cpc,cpm,ctr,reach,actions,cost_per_action_type&date_preset=' + datePreset
  );
}

async function getCampaignInsightsDaily(campaignId, days) {
  days = days || 30;
  var since = new Date();
  since.setDate(since.getDate() - days);
  var sinceStr = since.toISOString().split('T')[0];
  var untilStr = new Date().toISOString().split('T')[0];

  return await apiCall(
    '/' + campaignId + '/insights?fields=spend,impressions,clicks,cpc,actions,cost_per_action_type&time_range={"since":"' + sinceStr + '","until":"' + untilStr + '"}&time_increment=1'
  );
}

// ===== GERENCIAMENTO =====

async function updateCampaignStatus(campaignId, status) {
  if (status !== 'ACTIVE' && status !== 'PAUSED') {
    throw new Error('Status deve ser ACTIVE ou PAUSED');
  }
  return await apiCall('/' + campaignId, 'POST', { status: status });
}

async function updateCampaignBudget(campaignId, budget, type) {
  type = type || 'daily';
  var budgetCents = Math.round(budget * 100);
  var field = type === 'daily' ? 'daily_budget' : 'lifetime_budget';
  var payload = {};
  payload[field] = budgetCents.toString();
  return await apiCall('/' + campaignId, 'POST', payload);
}

async function getAdsets(campaignId) {
  return await apiCall(
    '/' + campaignId + '/adsets?fields=id,name,status,daily_budget,targeting,optimization_goal,bid_strategy&limit=100'
  );
}

async function exchangeToken(shortToken) {
  var appId = process.env.META_APP_ID;
  var appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) throw new Error('META_APP_ID e META_APP_SECRET necessarios');

  return await apiCall(
    '/oauth/access_token?grant_type=fb_exchange_token&client_id=' + appId +
    '&client_secret=' + appSecret + '&fb_exchange_token=' + shortToken
  );
}

// ===== HELPERS =====

function convertDateRange(range) {
  var map = {
    'today': 'today',
    'yesterday': 'yesterday',
    'last_7d': 'last_7d',
    'last_14d': 'last_14d',
    'last_30d': 'last_30d',
    'this_month': 'this_month',
    'last_month': 'last_month',
    'this_year': 'this_year'
  };
  return map[range] || 'today';
}

module.exports = {
  getCampaigns: getCampaigns,
  getCampaignInsights: getCampaignInsights,
  getCampaignInsightsDaily: getCampaignInsightsDaily,
  getAccountInsights: getAccountInsights,
  updateCampaignStatus: updateCampaignStatus,
  updateCampaignBudget: updateCampaignBudget,
  getAdsets: getAdsets,
  exchangeToken: exchangeToken
};
ENDOFFILE

echo "[4/5] Criando whatsapp-monitor.js..."
cat > whatsapp-monitor.js << 'ENDOFFILE'
/**
 * WhatsApp Group Monitor
 * Monitora entradas/saidas de membros nos grupos
 * Usa whatsapp-web.js (API nao-oficial)
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');

let client = null;
let db = null;
let currentQR = null;
let connectionStatus = {
  connected: false,
  ready: false,
  phone: null,
  lastDisconnect: null,
  error: null
};

function initialize(firestore) {
  db = firestore;

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: './whatsapp-session' }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--disable-gpu'
      ]
    }
  });

  // QR Code para autenticacao
  client.on('qr', function(qr) {
    currentQR = qr;
    console.log('');
    console.log('[WHATSAPP] Escaneie o QR Code abaixo com seu WhatsApp:');
    console.log('');
    qrcode.generate(qr, { small: true });
    console.log('');
    console.log('[WHATSAPP] Ou acesse o painel para ver o QR Code');
  });

  // Autenticado
  client.on('authenticated', function() {
    console.log('[WHATSAPP] Autenticado com sucesso!');
    currentQR = null;
  });

  // Pronto para usar
  client.on('ready', async function() {
    connectionStatus.connected = true;
    connectionStatus.ready = true;
    connectionStatus.error = null;

    var info = client.info;
    connectionStatus.phone = info ? info.wid.user : 'N/A';
    console.log('[WHATSAPP] Conectado! Numero: ' + connectionStatus.phone);

    // Faz scan inicial dos grupos
    await scanGroups();
  });

  // Membro entrou no grupo
  client.on('group_join', async function(notification) {
    try {
      var groupId = notification.chatId;
      var memberId = notification.recipientIds ? notification.recipientIds[0] : notification.id.participant;
      var memberPhone = memberId ? memberId.replace('@c.us', '') : 'desconhecido';

      console.log('[WHATSAPP] Membro entrou: ' + memberPhone + ' no grupo ' + groupId);

      // Registra evento no Firestore
      await db.collection('member_events').add({
        whatsappGroupId: groupId,
        phone: hashPhone(memberPhone),
        phonePartial: memberPhone.slice(-4),
        action: 'join',
        timestamp: require('firebase-admin').firestore.FieldValue.serverTimestamp()
      });

      // Atualiza contagem de membros
      await updateGroupMemberCount(groupId);

      // Cria alerta de novo membro
      var groupInfo = await getGroupInfo(groupId);
      await db.collection('alerts').add({
        type: 'member_joined',
        whatsappGroupId: groupId,
        groupName: groupInfo ? groupInfo.name : groupId,
        memberPhone: '***' + memberPhone.slice(-4),
        timestamp: require('firebase-admin').firestore.FieldValue.serverTimestamp(),
        read: false
      });

    } catch (err) {
      console.error('[WHATSAPP] Erro ao registrar entrada:', err.message);
    }
  });

  // Membro saiu do grupo
  client.on('group_leave', async function(notification) {
    try {
      var groupId = notification.chatId;
      var memberId = notification.recipientIds ? notification.recipientIds[0] : notification.id.participant;
      var memberPhone = memberId ? memberId.replace('@c.us', '') : 'desconhecido';

      console.log('[WHATSAPP] Membro saiu: ' + memberPhone + ' do grupo ' + groupId);

      // Registra evento
      await db.collection('member_events').add({
        whatsappGroupId: groupId,
        phone: hashPhone(memberPhone),
        phonePartial: memberPhone.slice(-4),
        action: 'leave',
        timestamp: require('firebase-admin').firestore.FieldValue.serverTimestamp()
      });

      // Atualiza contagem
      await updateGroupMemberCount(groupId);

    } catch (err) {
      console.error('[WHATSAPP] Erro ao registrar saida:', err.message);
    }
  });

  // Desconectado
  client.on('disconnected', function(reason) {
    connectionStatus.connected = false;
    connectionStatus.ready = false;
    connectionStatus.lastDisconnect = new Date().toISOString();
    connectionStatus.error = reason;
    console.log('[WHATSAPP] Desconectado. Motivo:', reason);

    // Tenta reconectar apos 30s
    setTimeout(function() {
      console.log('[WHATSAPP] Tentando reconectar...');
      client.initialize().catch(function(err) {
        console.error('[WHATSAPP] Falha ao reconectar:', err.message);
      });
    }, 30000);
  });

  // Erro de autenticacao
  client.on('auth_failure', function(msg) {
    connectionStatus.error = 'Falha na autenticacao: ' + msg;
    console.error('[WHATSAPP] Falha na autenticacao:', msg);
  });

  // Inicia
  console.log('[WHATSAPP] Inicializando cliente...');
  client.initialize().catch(function(err) {
    connectionStatus.error = err.message;
    console.error('[WHATSAPP] Erro ao inicializar:', err.message);
    console.log('[WHATSAPP] Verifique se o Chromium esta instalado');
  });
}

async function scanGroups() {
  try {
    var chats = await client.getChats();
    var groups = chats.filter(function(c) { return c.isGroup; });

    console.log('[WHATSAPP] Encontrados ' + groups.length + ' grupos');

    for (var group of groups) {
      try {
        var participants = group.participants || [];
        var memberCount = participants.length;

        var groupChat = await client.getChatById(group.id._serialized);
        if (groupChat && groupChat.participants) {
          memberCount = groupChat.participants.length;
        }

        await db.collection('group_members').doc(group.id._serialized).set({
          whatsappGroupId: group.id._serialized,
          groupName: group.name,
          currentMembers: memberCount,
          lastScanned: require('firebase-admin').firestore.FieldValue.serverTimestamp()
        }, { merge: true });

      } catch (err) {
        console.error('[WHATSAPP] Erro ao escanear grupo ' + group.name + ':', err.message);
      }
    }

    console.log('[WHATSAPP] Scan de grupos concluido');
  } catch (err) {
    console.error('[WHATSAPP] Erro no scan:', err.message);
  }
}

async function updateGroupMemberCount(groupId) {
  try {
    var chat = await client.getChatById(groupId);
    if (chat && chat.participants) {
      await db.collection('group_members').doc(groupId).set({
        whatsappGroupId: groupId,
        groupName: chat.name,
        currentMembers: chat.participants.length,
        lastUpdated: require('firebase-admin').firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }
  } catch (err) {
    console.error('[WHATSAPP] Erro ao atualizar contagem:', err.message);
  }
}

async function getGroupInfo(groupId) {
  try {
    var chat = await client.getChatById(groupId);
    return chat ? { name: chat.name, participants: chat.participants ? chat.participants.length : 0 } : null;
  } catch (err) {
    return null;
  }
}

// ===== API PUBLICAS =====

function getStatus() {
  return connectionStatus;
}

function getQR() {
  return currentQR;
}

async function getGroups() {
  if (!client || !connectionStatus.ready) {
    var snap = await db.collection('group_members').get();
    var groups = [];
    snap.forEach(function(doc) { groups.push({ id: doc.id, ...doc.data() }); });
    return groups;
  }

  try {
    var chats = await client.getChats();
    var groups = chats.filter(function(c) { return c.isGroup; });

    return groups.map(function(g) {
      return {
        id: g.id._serialized,
        name: g.name,
        participants: g.participants ? g.participants.length : 0,
        isReadOnly: g.isReadOnly
      };
    });
  } catch (err) {
    throw new Error('Erro ao listar grupos: ' + err.message);
  }
}

async function getGroupMembers(groupId) {
  if (!client || !connectionStatus.ready) {
    throw new Error('WhatsApp nao conectado');
  }

  try {
    var chat = await client.getChatById(groupId);
    if (!chat || !chat.participants) {
      throw new Error('Grupo nao encontrado');
    }

    return {
      groupName: chat.name,
      totalMembers: chat.participants.length,
      participants: chat.participants.map(function(p) {
        return {
          id: p.id._serialized,
          phone: '***' + p.id.user.slice(-4),
          isAdmin: p.isAdmin || p.isSuperAdmin,
          isSuperAdmin: p.isSuperAdmin
        };
      })
    };
  } catch (err) {
    throw new Error('Erro ao listar membros: ' + err.message);
  }
}

// Hash simples para privacidade dos telefones
function hashPhone(phone) {
  var hash = 0;
  for (var i = 0; i < phone.length; i++) {
    var char = phone.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return 'ph_' + Math.abs(hash).toString(36);
}

// Re-scan periodico (a cada 15 minutos)
setInterval(function() {
  if (connectionStatus.ready) {
    scanGroups();
  }
}, 15 * 60 * 1000);

module.exports = {
  initialize: initialize,
  getStatus: getStatus,
  getQR: getQR,
  getGroups: getGroups,
  getGroupMembers: getGroupMembers
};
ENDOFFILE

echo "[5/5] Criando .env..."
cat > .env << 'ENDOFFILE'
# ============================================
# CONFIGURACAO DO SERVIDOR LINKROTATOR
# ============================================

# Porta do servidor
PORT=3000

# URL do seu site (para CORS)
FRONTEND_URL=*

# ============================================
# FIREBASE (Service Account)
# ============================================
# Baixe o JSON em: Firebase Console > Engrenagem > Contas de servico > Gerar nova chave privada
FIREBASE_PROJECT_ID=linkrotator-2bae9
FIREBASE_CLIENT_EMAIL=COLE_O_CLIENT_EMAIL_AQUI
FIREBASE_PRIVATE_KEY="COLE_A_PRIVATE_KEY_AQUI"

# ============================================
# META ADS API (configure depois)
# ============================================
META_ACCESS_TOKEN=SEU_TOKEN_META_AQUI
META_AD_ACCOUNT_ID=act_123456789
META_APP_ID=123456789
META_APP_SECRET=abc123def456
ENDOFFILE

echo ""
echo "[INSTALANDO] Instalando dependencias..."
npm install

echo ""
echo "[CHROMIUM] Instalando Chromium para WhatsApp..."
apt-get update -qq && apt-get install -y -qq chromium-browser 2>/dev/null || apt-get install -y -qq chromium 2>/dev/null || echo "[AVISO] Instale o Chromium manualmente: apt install chromium-browser"

echo ""
echo "==========================================="
echo "  INSTALACAO CONCLUIDA!"
echo "==========================================="
echo ""
echo "  Proximos passos:"
echo "  1. Configure o .env com as credenciais do Firebase"
echo "     nano /root/rotadordelinks/server/.env"
echo ""
echo "  2. Depois inicie o servidor:"
echo "     cd /root/rotadordelinks/server"
echo "     node index.js"
echo ""
echo "==========================================="
