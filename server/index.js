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
    return res.status(401).json({ error: 'Token não fornecido' });
  }
  try {
    var decoded = await admin.auth().verifyIdToken(token.split('Bearer ')[1]);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido' });
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

// Insights de uma campanha específica
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

// Atualizar orçamento da campanha
app.post('/api/meta/campaigns/:id/budget', authMiddleware, async function(req, res) {
  try {
    var result = await metaApi.updateCampaignBudget(req.params.id, req.body.budget, req.body.type);
    res.json(result);
  } catch (err) {
    console.error('Erro ao atualizar orçamento:', err.message);
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

// Sincronizar dados Meta → Firestore
app.post('/api/meta/sync', authMiddleware, async function(req, res) {
  try {
    await syncMetaToFirestore();
    res.json({ success: true, message: 'Dados sincronizados' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== WHATSAPP ROUTES =====

// Status da conexão
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
    // Busca dados em paralelo
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

// ===== SYNC META → FIRESTORE =====
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
    console.error('[META] Erro na sincronização:', err.message);
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
    console.log('[META] Iniciando primeira sincronização...');
    syncMetaToFirestore();
  } else {
    console.log('[META] Token não configurado. Configure META_ACCESS_TOKEN no .env');
  }
});
