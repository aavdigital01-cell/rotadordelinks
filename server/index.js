require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { Pool } = require('pg');
const metaApi = require('./meta-api');
const whatsappMonitor = require('./whatsapp-monitor');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== FIREBASE ADMIN (apenas para Auth) =====
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n')
  })
});

// ===== POSTGRESQL =====
const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: process.env.PG_PORT || 5432,
  database: process.env.PG_DATABASE || 'linkrotator_db',
  user: process.env.PG_USER || 'linkrotator',
  password: process.env.PG_PASSWORD || 'LinkRotator2026'
});

// Test connection
pool.query('SELECT NOW()', function(err) {
  if (err) console.error('[DB] Erro ao conectar PostgreSQL:', err.message);
  else console.log('[DB] PostgreSQL conectado com sucesso!');
});

// ===== MIDDLEWARE =====
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json());

// Auth middleware - verifica Firebase token
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

// ===== CAMPAIGNS =====

app.get('/api/campaigns', authMiddleware, async function(req, res) {
  try {
    var result = await pool.query('SELECT * FROM campaigns ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/campaigns', authMiddleware, async function(req, res) {
  try {
    var id = req.body.id || ('camp_' + Date.now());
    var name = req.body.name;
    var isActive = req.body.isActive !== false;
    await pool.query(
      'INSERT INTO campaigns (id, name, is_active) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET name=$2, is_active=$3, updated_at=NOW()',
      [id, name, isActive]
    );
    res.json({ success: true, id: id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/campaigns/:id', authMiddleware, async function(req, res) {
  try {
    var fields = [];
    var values = [];
    var idx = 1;
    if (req.body.name !== undefined) { fields.push('name=$' + idx); values.push(req.body.name); idx++; }
    if (req.body.isActive !== undefined) { fields.push('is_active=$' + idx); values.push(req.body.isActive); idx++; }
    fields.push('updated_at=NOW()');
    values.push(req.params.id);
    await pool.query('UPDATE campaigns SET ' + fields.join(',') + ' WHERE id=$' + idx, values);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/campaigns/:id', authMiddleware, async function(req, res) {
  try {
    await pool.query('DELETE FROM campaigns WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== LINKS =====

app.get('/api/links', authMiddleware, async function(req, res) {
  try {
    var result = await pool.query('SELECT * FROM links ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/links', authMiddleware, async function(req, res) {
  try {
    var id = req.body.id || ('link_' + Date.now());
    var b = req.body;
    await pool.query(
      'INSERT INTO links (id, name, url, campaign_id, whatsapp_group_id, current_clicks, max_vacancies, is_active, redirect_type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id, b.name, b.url || '', b.campaignId || b.campaign_id, b.whatsappGroupId || b.whatsapp_group_id || null, b.currentClicks || b.current_clicks || 0, b.maxVacancies || b.max_vacancies || 1000, b.isActive !== false, b.redirectType || b.redirect_type || 'whatsapp']
    );
    res.json({ success: true, id: id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/links/:id', authMiddleware, async function(req, res) {
  try {
    var b = req.body;
    var fields = [];
    var values = [];
    var idx = 1;
    if (b.name !== undefined) { fields.push('name=$' + idx); values.push(b.name); idx++; }
    if (b.url !== undefined) { fields.push('url=$' + idx); values.push(b.url); idx++; }
    if (b.campaignId !== undefined || b.campaign_id !== undefined) { fields.push('campaign_id=$' + idx); values.push(b.campaignId || b.campaign_id); idx++; }
    if (b.whatsappGroupId !== undefined || b.whatsapp_group_id !== undefined) { fields.push('whatsapp_group_id=$' + idx); values.push(b.whatsappGroupId || b.whatsapp_group_id); idx++; }
    if (b.currentClicks !== undefined || b.current_clicks !== undefined) { fields.push('current_clicks=$' + idx); values.push(b.currentClicks || b.current_clicks); idx++; }
    if (b.maxVacancies !== undefined || b.max_vacancies !== undefined) { fields.push('max_vacancies=$' + idx); values.push(b.maxVacancies || b.max_vacancies); idx++; }
    if (b.isActive !== undefined || b.is_active !== undefined) { fields.push('is_active=$' + idx); values.push(b.isActive !== undefined ? b.isActive : b.is_active); idx++; }
    if (b.redirectType !== undefined) { fields.push('redirect_type=$' + idx); values.push(b.redirectType); idx++; }
    fields.push('updated_at=NOW()');
    values.push(req.params.id);
    if (fields.length > 1) {
      await pool.query('UPDATE links SET ' + fields.join(',') + ' WHERE id=$' + idx, values);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/links/:id', authMiddleware, async function(req, res) {
  try {
    await pool.query('DELETE FROM links WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== CLICKS =====

app.get('/api/clicks/today', authMiddleware, async function(req, res) {
  try {
    var result = await pool.query(
      "SELECT * FROM clicks WHERE timestamp >= CURRENT_DATE ORDER BY timestamp DESC"
    );
    // Hourly breakdown
    var hourly = new Array(24).fill(0);
    var devices = { Mobile: 0, Desktop: 0, Tablet: 0 };
    result.rows.forEach(function(r) {
      var h = new Date(r.timestamp).getHours();
      hourly[h]++;
      var dev = r.device || 'Desktop';
      if (devices[dev] !== undefined) devices[dev]++;
      else devices['Desktop']++;
    });
    res.json({ total: result.rows.length, hourly: hourly, devices: devices, clicks: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/clicks/recent', authMiddleware, async function(req, res) {
  try {
    var result = await pool.query('SELECT * FROM clicks ORDER BY timestamp DESC LIMIT 10');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/clicks/range', authMiddleware, async function(req, res) {
  try {
    var days = parseInt(req.query.days) || 30;
    var result = await pool.query(
      "SELECT * FROM clicks WHERE timestamp >= NOW() - INTERVAL '" + days + " days' ORDER BY timestamp DESC"
    );
    var todayStart = new Date(); todayStart.setHours(0,0,0,0);
    var weekStart = new Date(); weekStart.setDate(weekStart.getDate() - 7);
    var monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);

    var clicksToday = 0, clicksWeek = 0, clicksMonth = 0;
    var dailyData = {};
    var countryData = {};
    var browserData = {};
    var hourlyData = new Array(24).fill(0);

    result.rows.forEach(function(r) {
      var date = new Date(r.timestamp);
      if (date >= todayStart) clicksToday++;
      if (date >= weekStart) { clicksWeek++; hourlyData[date.getHours()]++; }
      if (date >= monthStart) clicksMonth++;
      var dayKey = date.toISOString().split('T')[0];
      dailyData[dayKey] = (dailyData[dayKey] || 0) + 1;
      var country = r.country || r.country_code || 'Desconhecido';
      countryData[country] = (countryData[country] || 0) + 1;
      var browser = r.browser || 'Outro';
      browserData[browser] = (browserData[browser] || 0) + 1;
    });

    res.json({
      clicksToday: clicksToday, clicksWeek: clicksWeek, clicksMonth: clicksMonth,
      dailyData: dailyData, countryData: countryData, browserData: browserData, hourlyData: hourlyData
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Record a click (called from redirect page - no auth needed)
app.post('/api/clicks', async function(req, res) {
  try {
    var b = req.body;
    await pool.query(
      'INSERT INTO clicks (link_id, link_name, campaign_id, device, browser, city, country, country_code, ip, referrer) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [b.linkId, b.linkName, b.campaignId, b.device, b.browser, b.city, b.country, b.countryCode, b.ip || req.ip, b.referrer]
    );
    // Increment link clicks
    if (b.linkId) {
      await pool.query('UPDATE links SET current_clicks = current_clicks + 1 WHERE id=$1', [b.linkId]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== MEMBER EVENTS =====

app.get('/api/member-events/today', authMiddleware, async function(req, res) {
  try {
    var result = await pool.query(
      "SELECT * FROM member_events WHERE timestamp >= CURRENT_DATE ORDER BY timestamp DESC"
    );
    var joins = 0, leaves = 0;
    result.rows.forEach(function(r) {
      if (r.action === 'join') joins++;
      else if (r.action === 'leave') leaves++;
    });
    // Format events for frontend compatibility
    var events = result.rows.map(function(r) {
      return {
        id: r.id,
        whatsappGroupId: r.whatsapp_group_id,
        groupName: r.group_name,
        phone: r.phone,
        phonePartial: r.phone_partial,
        action: r.action,
        timestamp: { _seconds: Math.floor(new Date(r.timestamp).getTime() / 1000) }
      };
    });
    res.json({ joins: joins, leaves: leaves, net: joins - leaves, total: events.length, events: events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/member-events/by-group', authMiddleware, async function(req, res) {
  try {
    var result = await pool.query(
      "SELECT whatsapp_group_id, group_name, action, COUNT(*) as cnt FROM member_events WHERE timestamp >= CURRENT_DATE GROUP BY whatsapp_group_id, group_name, action"
    );
    var groupStats = {};
    result.rows.forEach(function(r) {
      var gid = r.whatsapp_group_id;
      if (!groupStats[gid]) groupStats[gid] = { joins: 0, leaves: 0, groupName: r.group_name || gid };
      if (r.action === 'join') groupStats[gid].joins = parseInt(r.cnt);
      else groupStats[gid].leaves = parseInt(r.cnt);
    });
    res.json(groupStats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/member-events/range', authMiddleware, async function(req, res) {
  try {
    var days = parseInt(req.query.days) || 7;
    var result = await pool.query(
      "SELECT * FROM member_events WHERE timestamp >= NOW() - INTERVAL '" + days + " days' ORDER BY timestamp DESC"
    );
    var dailyStats = {};
    var groupStats = {};
    var totalJoins = 0, totalLeaves = 0;
    result.rows.forEach(function(r) {
      var dayKey = new Date(r.timestamp).toISOString().split('T')[0];
      var gid = r.whatsapp_group_id || 'unknown';
      if (!dailyStats[dayKey]) dailyStats[dayKey] = { joins: 0, leaves: 0 };
      if (!groupStats[gid]) groupStats[gid] = { joins: 0, leaves: 0, groupName: r.group_name || gid };
      if (r.action === 'join') { dailyStats[dayKey].joins++; groupStats[gid].joins++; totalJoins++; }
      else { dailyStats[dayKey].leaves++; groupStats[gid].leaves++; totalLeaves++; }
    });
    res.json({
      totalJoins: totalJoins, totalLeaves: totalLeaves, net: totalJoins - totalLeaves,
      retentionRate: totalJoins > 0 ? Math.round(((totalJoins - totalLeaves) / totalJoins) * 100) : 0,
      evasionRate: totalJoins > 0 ? Math.round((totalLeaves / totalJoins) * 100) : 0,
      dailyStats: dailyStats, groupStats: groupStats
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== DASHBOARD STATS =====

app.get('/api/stats/dashboard', authMiddleware, async function(req, res) {
  try {
    var [groupsR, eventsR, clicksR] = await Promise.all([
      pool.query('SELECT COALESCE(SUM(current_members),0) as total FROM whatsapp_groups'),
      pool.query("SELECT action, COUNT(*) as cnt FROM member_events WHERE timestamp >= CURRENT_DATE GROUP BY action"),
      pool.query("SELECT COUNT(*) as cnt FROM clicks WHERE timestamp >= CURRENT_DATE")
    ]);
    var totalMembers = parseInt(groupsR.rows[0].total);
    var joins = 0, leaves = 0;
    eventsR.rows.forEach(function(r) {
      if (r.action === 'join') joins = parseInt(r.cnt);
      else leaves = parseInt(r.cnt);
    });
    var clicksToday = parseInt(clicksR.rows[0].cnt);
    var taxaFuga = clicksToday > 0 ? Math.round(((clicksToday - joins) / clicksToday) * 100) : 0;
    var taxaSaida = totalMembers > 0 ? ((leaves / totalMembers) * 100).toFixed(1) : 0;

    res.json({
      totalMembers: totalMembers, joinsToday: joins, leavesToday: leaves,
      clicksToday: clicksToday, taxaFuga: Math.max(0, taxaFuga),
      taxaSaida: parseFloat(taxaSaida), saldoLiquido: joins - leaves
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== ALERTS =====

app.get('/api/alerts', authMiddleware, async function(req, res) {
  try {
    var result = await pool.query('SELECT * FROM alerts ORDER BY timestamp DESC LIMIT 50');
    res.json(result.rows.map(function(r) {
      return {
        id: r.id, type: r.type, whatsappGroupId: r.whatsapp_group_id,
        groupName: r.group_name, memberPhone: r.member_phone,
        message: r.message, read: r.read,
        timestamp: { seconds: Math.floor(new Date(r.timestamp).getTime() / 1000) }
      };
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/alerts/unread-count', authMiddleware, async function(req, res) {
  try {
    var result = await pool.query('SELECT COUNT(*) as cnt FROM alerts WHERE read=false');
    res.json({ count: parseInt(result.rows[0].cnt) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/alerts/:id/read', authMiddleware, async function(req, res) {
  try {
    await pool.query('UPDATE alerts SET read=true WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/alerts/read-all', authMiddleware, async function(req, res) {
  try {
    await pool.query('UPDATE alerts SET read=true WHERE read=false');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== META CAMPAIGNS (from DB) =====

app.get('/api/meta-campaigns', authMiddleware, async function(req, res) {
  try {
    var result = await pool.query('SELECT * FROM meta_campaigns ORDER BY last_synced DESC');
    res.json(result.rows.map(function(r) {
      return {
        id: r.id, name: r.name, status: r.status, objective: r.objective,
        dailyBudget: parseFloat(r.daily_budget), spend: parseFloat(r.spend),
        impressions: r.impressions, clicks: r.clicks, cpc: parseFloat(r.cpc),
        cpm: parseFloat(r.cpm), ctr: parseFloat(r.ctr), reach: r.reach,
        conversions: r.conversions, costPerResult: parseFloat(r.cost_per_result)
      };
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== META ADS API ROUTES =====

app.get('/api/meta/campaigns', authMiddleware, async function(req, res) {
  try {
    var campaigns = await metaApi.getCampaigns();
    res.json(campaigns);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/meta/campaigns/:id/insights', authMiddleware, async function(req, res) {
  try {
    var insights = await metaApi.getCampaignInsights(req.params.id, req.query.date_range || 'last_7d');
    res.json(insights);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/meta/account/insights', authMiddleware, async function(req, res) {
  try {
    var insights = await metaApi.getAccountInsights(req.query.date_range || 'today');
    res.json(insights);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/meta/campaigns/:id/status', authMiddleware, async function(req, res) {
  try {
    var result = await metaApi.updateCampaignStatus(req.params.id, req.body.status);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/meta/campaigns/:id/budget', authMiddleware, async function(req, res) {
  try {
    var result = await metaApi.updateCampaignBudget(req.params.id, req.body.budget, req.body.type);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/meta/campaigns/:id/adsets', authMiddleware, async function(req, res) {
  try {
    var adsets = await metaApi.getAdsets(req.params.id);
    res.json(adsets);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/meta/sync', authMiddleware, async function(req, res) {
  try {
    await syncMetaToDB();
    res.json({ success: true, message: 'Dados sincronizados' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== WHATSAPP ROUTES =====

app.get('/api/whatsapp/status', authMiddleware, function(req, res) {
  res.json(whatsappMonitor.getStatus());
});

app.get('/api/whatsapp/qr', authMiddleware, function(req, res) {
  var qr = whatsappMonitor.getQR();
  if (qr) res.json({ qr: qr, status: 'waiting_scan' });
  else if (whatsappMonitor.getStatus().connected) res.json({ qr: null, status: 'connected' });
  else res.json({ qr: null, status: 'initializing' });
});

app.get('/api/whatsapp/groups', authMiddleware, async function(req, res) {
  try {
    var groups = await whatsappMonitor.getGroups();
    res.json(groups);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/whatsapp/groups/:id/members', authMiddleware, async function(req, res) {
  try {
    var members = await whatsappMonitor.getGroupMembers(req.params.id);
    res.json(members);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/whatsapp/groups/:groupId/link', authMiddleware, async function(req, res) {
  try {
    await pool.query('UPDATE links SET whatsapp_group_id=$1, updated_at=NOW() WHERE id=$2', [req.params.groupId, req.body.linkId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/whatsapp/restart', authMiddleware, async function(req, res) {
  try {
    await whatsappMonitor.restart();
    res.json({ success: true, message: 'WhatsApp reiniciado' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== SETTINGS =====

app.get('/api/settings', authMiddleware, async function(req, res) {
  try {
    var result = await pool.query("SELECT value FROM settings WHERE key='general'");
    res.json(result.rows.length > 0 ? result.rows[0].value : {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings', authMiddleware, async function(req, res) {
  try {
    await pool.query(
      "INSERT INTO settings (key, value, updated_at) VALUES ('general', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()",
      [JSON.stringify(req.body)]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings/meta', authMiddleware, async function(req, res) {
  try {
    var meta = req.body;
    // Save to DB
    var current = await pool.query("SELECT value FROM settings WHERE key='general'");
    var settings = current.rows.length > 0 ? current.rows[0].value : {};
    settings.meta = meta;
    await pool.query(
      "INSERT INTO settings (key, value, updated_at) VALUES ('general', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()",
      [JSON.stringify(settings)]
    );
    // Hot-reload env vars
    if (meta.accessToken) process.env.META_ACCESS_TOKEN = meta.accessToken;
    if (meta.adAccountId) process.env.META_AD_ACCOUNT_ID = meta.adAccountId;
    if (meta.appId) process.env.META_APP_ID = meta.appId;
    if (meta.appSecret) process.env.META_APP_SECRET = meta.appSecret;
    console.log('[META] Credenciais atualizadas');
    syncMetaToDB();
    res.json({ success: true, message: 'Credenciais Meta atualizadas' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== USER MANAGEMENT =====

app.get('/api/users', authMiddleware, async function(req, res) {
  try {
    var result = await pool.query('SELECT * FROM users ORDER BY created_at DESC');
    res.json(result.rows.map(function(r) {
      return { uid: r.uid, email: r.email, displayName: r.display_name, role: r.role, createdAt: r.created_at };
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users/:uid', authMiddleware, async function(req, res) {
  try {
    var result = await pool.query('SELECT * FROM users WHERE uid=$1', [req.params.uid]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado' });
    var r = result.rows[0];
    res.json({ uid: r.uid, email: r.email, displayName: r.display_name, role: r.role, createdAt: r.created_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users/create', authMiddleware, async function(req, res) {
  try {
    var callerR = await pool.query('SELECT role FROM users WHERE uid=$1', [req.user.uid]);
    if (callerR.rows.length === 0 || callerR.rows[0].role !== 'superadmin') {
      return res.status(403).json({ error: 'Apenas Super Admin pode criar usuários' });
    }
    var email = req.body.email;
    var password = req.body.password;
    var displayName = req.body.displayName || '';
    var role = req.body.role || 'admin';
    if (!email || !password) return res.status(400).json({ error: 'Email e senha são obrigatórios' });
    if (password.length < 6) return res.status(400).json({ error: 'Senha deve ter no mínimo 6 caracteres' });

    var userRecord = await admin.auth().createUser({ email: email, password: password, displayName: displayName });
    await pool.query('INSERT INTO users (uid, email, display_name, role, created_by) VALUES ($1,$2,$3,$4,$5)',
      [userRecord.uid, email, displayName, role, req.user.uid]);
    res.json({ success: true, uid: userRecord.uid });
  } catch (err) {
    if (err.code === 'auth/email-already-exists') return res.status(400).json({ error: 'Email já cadastrado' });
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/users/:uid', authMiddleware, async function(req, res) {
  try {
    var callerR = await pool.query('SELECT role FROM users WHERE uid=$1', [req.user.uid]);
    if (callerR.rows.length === 0 || callerR.rows[0].role !== 'superadmin') {
      return res.status(403).json({ error: 'Apenas Super Admin' });
    }
    if (req.params.uid === req.user.uid) return res.status(400).json({ error: 'Não pode deletar a si mesmo' });
    await admin.auth().deleteUser(req.params.uid);
    await pool.query('DELETE FROM users WHERE uid=$1', [req.params.uid]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== STATS OVERVIEW =====

app.get('/api/stats/overview', authMiddleware, async function(req, res) {
  try {
    var [metaInsights, groupsR] = await Promise.all([
      metaApi.getAccountInsights('today').catch(function() { return null; }),
      pool.query('SELECT COALESCE(SUM(current_members),0) as total, COUNT(*) as cnt FROM whatsapp_groups')
    ]);
    res.json({
      meta: metaInsights,
      groups: { totalMembers: parseInt(groupsR.rows[0].total), groups: parseInt(groupsR.rows[0].cnt) },
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== SYNC META → DB =====

async function syncMetaToDB() {
  try {
    var campaigns = await metaApi.getCampaigns();
    if (!campaigns || !campaigns.data) return;

    for (var camp of campaigns.data) {
      var insights = await metaApi.getCampaignInsights(camp.id, 'today');
      var d = insights && insights.data && insights.data[0] ? insights.data[0] : {};

      await pool.query(
        `INSERT INTO meta_campaigns (id, name, status, objective, daily_budget, spend, impressions, clicks, cpc, cpm, ctr, reach, conversions, cost_per_result, last_synced)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
         ON CONFLICT (id) DO UPDATE SET name=$2, status=$3, objective=$4, daily_budget=$5, spend=$6, impressions=$7, clicks=$8, cpc=$9, cpm=$10, ctr=$11, reach=$12, conversions=$13, cost_per_result=$14, last_synced=NOW()`,
        [
          camp.id, camp.name, camp.status || camp.effective_status, camp.objective,
          camp.daily_budget ? parseFloat(camp.daily_budget) / 100 : 0,
          d.spend ? parseFloat(d.spend) : 0,
          d.impressions ? parseInt(d.impressions) : 0,
          d.clicks ? parseInt(d.clicks) : 0,
          d.cpc ? parseFloat(d.cpc) : 0,
          d.cpm ? parseFloat(d.cpm) : 0,
          d.ctr ? parseFloat(d.ctr) : 0,
          d.reach ? parseInt(d.reach) : 0,
          d.actions ? extractConversions(d.actions) : 0,
          d.cost_per_action_type ? extractCostPerResult(d.cost_per_action_type) : 0
        ]
      );
    }
    console.log('[META] Sincronizados ' + campaigns.data.length + ' campanhas');
  } catch (err) {
    console.error('[META] Erro na sincronização:', err.message);
  }
}

function extractConversions(actions) {
  if (!actions) return 0;
  var conv = actions.find(function(a) {
    return a.action_type === 'offsite_conversion.fb_pixel_lead' || a.action_type === 'lead' || a.action_type === 'onsite_conversion.messaging_first_reply';
  });
  return conv ? parseInt(conv.value) : 0;
}

function extractCostPerResult(costPerAction) {
  if (!costPerAction) return 0;
  var cost = costPerAction.find(function(a) {
    return a.action_type === 'offsite_conversion.fb_pixel_lead' || a.action_type === 'lead';
  });
  return cost ? parseFloat(cost.value) : 0;
}

// Auto-sync Meta every 5 minutes
setInterval(syncMetaToDB, 5 * 60 * 1000);

// ===== START SERVER =====
app.listen(PORT, function() {
  console.log('');
  console.log('===========================================');
  console.log('  LinkRotator Pro - Servidor Backend');
  console.log('  Rodando na porta ' + PORT);
  console.log('  Banco: PostgreSQL');
  console.log('===========================================');
  console.log('');

  // Initialize WhatsApp Monitor with pg pool
  whatsappMonitor.initialize(pool);

  // First Meta sync
  if (process.env.META_ACCESS_TOKEN && process.env.META_ACCESS_TOKEN !== 'SEU_TOKEN_META_AQUI') {
    console.log('[META] Iniciando primeira sincronização...');
    syncMetaToDB();
  } else {
    console.log('[META] Token não configurado. Configure META_ACCESS_TOKEN no .env');
  }
});
