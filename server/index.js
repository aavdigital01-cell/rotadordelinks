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

// ===== SETTINGS =====

// Buscar configurações gerais
app.get('/api/settings', authMiddleware, async function(req, res) {
  try {
    var doc = await db.collection('settings').doc('general').get();
    if (!doc.exists) {
      return res.json({});
    }
    res.json(doc.data());
  } catch (err) {
    console.error('Erro ao buscar configurações:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Salvar configurações gerais
app.post('/api/settings', authMiddleware, async function(req, res) {
  try {
    var settings = req.body;
    settings.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    await db.collection('settings').doc('general').set(settings, { merge: true });
    res.json({ success: true, message: 'Configurações salvas' });
  } catch (err) {
    console.error('Erro ao salvar configurações:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Salvar credenciais Meta API e hot-reload
app.post('/api/settings/meta', authMiddleware, async function(req, res) {
  try {
    var metaCredentials = req.body;
    metaCredentials.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    await db.collection('settings').doc('general').set({
      meta: metaCredentials
    }, { merge: true });

    // Hot-reload: atualizar variáveis de ambiente
    if (metaCredentials.accessToken) {
      process.env.META_ACCESS_TOKEN = metaCredentials.accessToken;
    }
    if (metaCredentials.adAccountId) {
      process.env.META_AD_ACCOUNT_ID = metaCredentials.adAccountId;
    }
    if (metaCredentials.appId) {
      process.env.META_APP_ID = metaCredentials.appId;
    }
    if (metaCredentials.appSecret) {
      process.env.META_APP_SECRET = metaCredentials.appSecret;
    }

    // Reiniciar sincronização com novas credenciais
    console.log('[META] Credenciais atualizadas, reiniciando sincronização...');
    syncMetaToFirestore();

    res.json({ success: true, message: 'Credenciais Meta atualizadas e sincronização reiniciada' });
  } catch (err) {
    console.error('Erro ao salvar credenciais Meta:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== MEMBER EVENTS =====

// Eventos de membros de hoje (entradas e saídas)
app.get('/api/member-events/today', authMiddleware, async function(req, res) {
  try {
    var now = new Date();
    var startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    var snapshot = await db.collection('member_events')
      .where('timestamp', '>=', startOfDay)
      .get();

    var joins = 0;
    var leaves = 0;
    var events = [];

    snapshot.forEach(function(doc) {
      var data = doc.data();
      if (data.action === 'join') {
        joins++;
      } else if (data.action === 'leave') {
        leaves++;
      }
      events.push({ id: doc.id, ...data });
    });

    res.json({
      joins: joins,
      leaves: leaves,
      net: joins - leaves,
      total: events.length,
      events: events
    });
  } catch (err) {
    console.error('Erro ao buscar eventos de membros:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== MEMBER EVENTS PER GROUP =====

// Eventos de membros por grupo (para WhatsApp Monitor detalhado)
app.get('/api/member-events/by-group', authMiddleware, async function(req, res) {
  try {
    var now = new Date();
    var startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    var snapshot = await db.collection('member_events')
      .where('timestamp', '>=', startOfDay)
      .get();

    var groupStats = {};

    snapshot.forEach(function(doc) {
      var data = doc.data();
      var groupId = data.whatsappGroupId || 'unknown';
      if (!groupStats[groupId]) {
        groupStats[groupId] = { joins: 0, leaves: 0, groupName: data.groupName || groupId };
      }
      if (data.action === 'join') {
        groupStats[groupId].joins++;
      } else if (data.action === 'leave') {
        groupStats[groupId].leaves++;
      }
    });

    res.json(groupStats);
  } catch (err) {
    console.error('Erro member-events/by-group:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Eventos de membros por período customizado
app.get('/api/member-events/range', authMiddleware, async function(req, res) {
  try {
    var days = parseInt(req.query.days) || 7;
    var startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    startDate.setHours(0, 0, 0, 0);

    var snapshot = await db.collection('member_events')
      .where('timestamp', '>=', startDate)
      .get();

    var dailyStats = {};
    var groupStats = {};
    var totalJoins = 0, totalLeaves = 0;

    snapshot.forEach(function(doc) {
      var data = doc.data();
      var ts = data.timestamp && data.timestamp.toDate ? data.timestamp.toDate() : new Date();
      var dayKey = ts.toISOString().split('T')[0];
      var groupId = data.whatsappGroupId || 'unknown';

      if (!dailyStats[dayKey]) dailyStats[dayKey] = { joins: 0, leaves: 0 };
      if (!groupStats[groupId]) groupStats[groupId] = { joins: 0, leaves: 0, groupName: data.groupName || groupId };

      if (data.action === 'join') {
        dailyStats[dayKey].joins++;
        groupStats[groupId].joins++;
        totalJoins++;
      } else if (data.action === 'leave') {
        dailyStats[dayKey].leaves++;
        groupStats[groupId].leaves++;
        totalLeaves++;
      }
    });

    res.json({
      totalJoins: totalJoins,
      totalLeaves: totalLeaves,
      net: totalJoins - totalLeaves,
      retentionRate: totalJoins > 0 ? Math.round(((totalJoins - totalLeaves) / totalJoins) * 100) : 0,
      evasionRate: totalJoins > 0 ? Math.round((totalLeaves / totalJoins) * 100) : 0,
      dailyStats: dailyStats,
      groupStats: groupStats
    });
  } catch (err) {
    console.error('Erro member-events/range:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== COMPREHENSIVE DASHBOARD STATS =====
app.get('/api/stats/dashboard', authMiddleware, async function(req, res) {
  try {
    var now = new Date();
    var startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // Parallel fetches
    var [groupSnap, eventsSnap, clicksSnap] = await Promise.all([
      db.collection('group_members').get(),
      db.collection('member_events').where('timestamp', '>=', startOfDay).get(),
      db.collection('clicks').where('timestamp', '>=', startOfDay).get()
    ]);

    // Total members
    var totalMembers = 0;
    var groupsData = [];
    groupSnap.forEach(function(doc) {
      var d = doc.data();
      totalMembers += (d.currentMembers || 0);
      groupsData.push({ id: doc.id, ...d });
    });

    // Events today
    var joins = 0, leaves = 0;
    eventsSnap.forEach(function(doc) {
      var d = doc.data();
      if (d.action === 'join') joins++;
      else if (d.action === 'leave') leaves++;
    });

    // Clicks today (rotator)
    var clicksToday = clicksSnap.size;

    // Taxa de fuga: clicks no rotador - entradas no grupo / clicks * 100
    var taxaFuga = clicksToday > 0 ? Math.round(((clicksToday - joins) / clicksToday) * 100) : 0;
    // Taxa de saída: saídas / total membros * 100
    var taxaSaida = totalMembers > 0 ? ((leaves / totalMembers) * 100).toFixed(1) : 0;

    res.json({
      totalMembers: totalMembers,
      joinsToday: joins,
      leavesToday: leaves,
      clicksToday: clicksToday,
      taxaFuga: Math.max(0, taxaFuga),
      taxaSaida: parseFloat(taxaSaida),
      saldoLiquido: joins - leaves,
      groups: groupsData.length
    });
  } catch (err) {
    console.error('Erro stats/dashboard:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== USER MANAGEMENT =====

// Criar novo usuário (apenas superadmin)
app.post('/api/users/create', authMiddleware, async function(req, res) {
  try {
    // Verifica se é superadmin
    var callerDoc = await db.collection('users').doc(req.user.uid).get();
    if (!callerDoc.exists || callerDoc.data().role !== 'superadmin') {
      return res.status(403).json({ error: 'Apenas Super Admin pode criar usuários' });
    }

    var email = req.body.email;
    var password = req.body.password;
    var displayName = req.body.displayName || '';
    var role = req.body.role || 'admin';

    if (!email || !password) {
      return res.status(400).json({ error: 'Email e senha são obrigatórios' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Senha deve ter no mínimo 6 caracteres' });
    }

    // Cria usuário no Firebase Auth
    var userRecord = await admin.auth().createUser({
      email: email,
      password: password,
      displayName: displayName
    });

    // Cria documento do usuário no Firestore
    await db.collection('users').doc(userRecord.uid).set({
      email: email,
      displayName: displayName,
      role: role,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: req.user.uid
    });

    res.json({
      success: true,
      message: 'Usuário criado com sucesso',
      uid: userRecord.uid
    });
  } catch (err) {
    console.error('Erro ao criar usuário:', err.message);
    if (err.code === 'auth/email-already-exists') {
      return res.status(400).json({ error: 'Este email já está cadastrado' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Deletar usuário (apenas superadmin)
app.delete('/api/users/:uid', authMiddleware, async function(req, res) {
  try {
    var callerDoc = await db.collection('users').doc(req.user.uid).get();
    if (!callerDoc.exists || callerDoc.data().role !== 'superadmin') {
      return res.status(403).json({ error: 'Apenas Super Admin pode deletar usuários' });
    }

    if (req.params.uid === req.user.uid) {
      return res.status(400).json({ error: 'Não é possível deletar seu próprio usuário' });
    }

    await admin.auth().deleteUser(req.params.uid);
    await db.collection('users').doc(req.params.uid).delete();

    res.json({ success: true, message: 'Usuário deletado' });
  } catch (err) {
    console.error('Erro ao deletar usuário:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== WHATSAPP RESTART =====

// Reiniciar conexão WhatsApp
app.post('/api/whatsapp/restart', authMiddleware, async function(req, res) {
  try {
    await whatsappMonitor.restart();
    res.json({ success: true, message: 'WhatsApp reiniciado' });
  } catch (err) {
    console.error('Erro ao reiniciar WhatsApp:', err.message);
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
