require('dotenv').config();

// ===== FUSO HORÁRIO DO BRASIL =====
// Garante que new Date(), getHours(), setHours(), CURRENT_DATE, etc.
// usem o horário de Brasília (UTC-3) e não UTC
process.env.TZ = 'America/Sao_Paulo';

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { Pool } = require('pg');
const fetch = require('node-fetch');
const metaApi = require('./meta-api');
const whatsappMonitor = require('./whatsapp-monitor');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== FIREBASE ADMIN (apenas para Auth) =====
var firebaseReady = false;
if (process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
      })
    });
    firebaseReady = true;
    console.log('[FIREBASE] Inicializado com sucesso');
  } catch (err) {
    console.warn('[FIREBASE] Erro ao inicializar:', err.message);
    console.warn('[FIREBASE] Auth endpoints não funcionarão até configurar as credenciais no .env');
  }
} else {
  console.warn('[FIREBASE] Credenciais não configuradas no .env. Auth endpoints desabilitados.');
  console.warn('[FIREBASE] Configure FIREBASE_CLIENT_EMAIL e FIREBASE_PRIVATE_KEY para habilitar autenticação.');
}

// ===== POSTGRESQL =====
const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: process.env.PG_PORT || 5432,
  database: process.env.PG_DATABASE || 'linkrotator_db',
  user: process.env.PG_USER || 'linkrotator',
  password: process.env.PG_PASSWORD
});

// Configura timezone do Brasil no PostgreSQL e testa conexão
pool.query("SET timezone = 'America/Sao_Paulo'", function() {
  pool.query('SELECT NOW()', function(err, result) {
    if (err) console.error('[DB] Erro ao conectar PostgreSQL:', err.message);
    else console.log('[DB] PostgreSQL conectado com sucesso! Horário atual (Brasil):', result.rows[0].now);
  });
});

// Garante que cada nova conexão do pool use timezone do Brasil
pool.on('connect', function(client) {
  client.query("SET timezone = 'America/Sao_Paulo'");
});

// ===== MIDDLEWARE =====
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json());

// Auth middleware - verifica Firebase token
// Rate limit for failed auth attempts (per IP)
var authFailures = {};
setInterval(function() {
  var now = Date.now();
  Object.keys(authFailures).forEach(function(ip) {
    if (now - authFailures[ip].last > 15 * 60 * 1000) delete authFailures[ip];
  });
}, 5 * 60 * 1000);

async function authMiddleware(req, res, next) {
  if (!firebaseReady) {
    // Firebase not configured - allow requests without auth for development
    req.user = { uid: 'dev-user', email: 'dev@localhost' };
    return next();
  }

  var ip = req.headers['x-forwarded-for'] || req.ip;
  var af = authFailures[ip];
  if (af && af.count >= 20) {
    var elapsed = Date.now() - af.last;
    if (elapsed < 15 * 60 * 1000) {
      return res.status(429).json({ error: 'Muitas tentativas. Aguarde 15 minutos.' });
    }
    delete authFailures[ip];
  }

  var token = req.headers.authorization;
  if (!token || !token.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }
  try {
    var decoded = await admin.auth().verifyIdToken(token.split('Bearer ')[1]);
    req.user = decoded;
    if (authFailures[ip]) delete authFailures[ip];
    next();
  } catch (err) {
    if (!authFailures[ip]) authFailures[ip] = { count: 0, last: 0 };
    authFailures[ip].count++;
    authFailures[ip].last = Date.now();
    return res.status(401).json({ error: 'Token inválido' });
  }
}

// ===== HELPER: map campaign row to camelCase =====
function mapCampaign(r) {
  return {
    id: r.id, name: r.name, slug: r.slug,
    rotationMode: r.rotation_mode, alertThreshold: r.alert_threshold,
    isActive: r.is_active,
    fbPixelId: r.fb_pixel_id, fbEventName: r.fb_event_name,
    ttPixelId: r.tt_pixel_id, ttEventName: r.tt_event_name,
    gtmId: r.gtm_id, gtmEventName: r.gtm_event_name,
    gadsId: r.gads_id, gadsConversionLabel: r.gads_conversion_label,
    createdBy: r.created_by,
    createdAt: r.created_at ? { seconds: Math.floor(new Date(r.created_at).getTime() / 1000) } : null,
    updatedAt: r.updated_at ? { seconds: Math.floor(new Date(r.updated_at).getTime() / 1000) } : null
  };
}

// ===== HELPER: map link row to camelCase =====
function mapLink(r) {
  return {
    id: r.id, name: r.name, url: r.url,
    campaignId: r.campaign_id, whatsappGroupId: r.whatsapp_group_id,
    currentClicks: r.current_clicks, maxVacancies: r.max_vacancies,
    groupMembers: r.group_members != null ? r.group_members : null,
    weight: r.weight, isActive: r.is_active, isFull: r.is_full,
    redirectType: r.redirect_type,
    healthCheckFailures: r.health_check_failures,
    deactivatedReason: r.deactivated_reason,
    deactivatedAt: r.deactivated_at,
    createdBy: r.created_by, order: r.order_num,
    createdAt: r.created_at ? { seconds: Math.floor(new Date(r.created_at).getTime() / 1000) } : null,
    updatedAt: r.updated_at ? { seconds: Math.floor(new Date(r.updated_at).getTime() / 1000) } : null
  };
}

// ===== HELPER: map click row to camelCase =====
function mapClick(r) {
  return {
    id: r.id, linkId: r.link_id, linkName: r.link_name,
    campaignId: r.campaign_id, device: r.device, browser: r.browser,
    os: r.os, city: r.city, country: r.country, countryCode: r.country_code,
    ip: r.ip, referrer: r.referrer,
    timestamp: r.timestamp ? { seconds: Math.floor(new Date(r.timestamp).getTime() / 1000) } : null
  };
}

// ===== HELPER: map alert row to camelCase =====
function mapAlert(r) {
  return {
    id: r.id, type: r.type, whatsappGroupId: r.whatsapp_group_id,
    groupName: r.group_name, memberPhone: r.member_phone,
    linkName: r.link_name, campaignName: r.campaign_name,
    percent: r.percent, message: r.message, read: r.read,
    timestamp: r.timestamp ? { seconds: Math.floor(new Date(r.timestamp).getTime() / 1000) } : null
  };
}

// ===== HELPER: map user row to camelCase =====
function mapUser(r) {
  return {
    uid: r.uid, email: r.email, displayName: r.display_name,
    role: r.role, createdBy: r.created_by,
    lastLogin: r.last_login ? { seconds: Math.floor(new Date(r.last_login).getTime() / 1000) } : null,
    createdAt: r.created_at ? { seconds: Math.floor(new Date(r.created_at).getTime() / 1000) } : null
  };
}

// Sanitize days parameter to prevent SQL injection
function validateDays(input, defaultVal) {
  var d = parseInt(input, 10);
  if (isNaN(d) || d < 1) return defaultVal;
  if (d > 365) return 365;
  return d;
}

// Build date filter SQL from query params (supports days or startDate/endDate)
function buildDateFilter(query, defaultDays) {
  defaultDays = defaultDays || 1;
  if (query.startDate) {
    var start = String(query.startDate);
    var end = String(query.endDate || start);
    if (/^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return "timestamp >= '" + start + "'::date AND timestamp < ('" + end + "'::date + INTERVAL '1 day')";
    }
  }
  var days = validateDays(query.days, defaultDays);
  if (days === 1) return "timestamp >= CURRENT_DATE";
  return "timestamp >= NOW() - (" + days + " * INTERVAL '1 day')";
}

// ===== CAMPAIGNS =====

app.get('/api/campaigns', authMiddleware, async function(req, res) {
  try {
    var result = await pool.query('SELECT * FROM campaigns ORDER BY created_at DESC');
    res.json(result.rows.map(mapCampaign));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/campaigns', authMiddleware, async function(req, res) {
  try {
    var b = req.body;
    var id = b.id || ('camp_' + Date.now());
    await pool.query(
      `INSERT INTO campaigns (id, name, slug, rotation_mode, alert_threshold, is_active, fb_pixel_id, fb_event_name, tt_pixel_id, tt_event_name, gtm_id, gtm_event_name, gads_id, gads_conversion_label, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (id) DO UPDATE SET name=$2, slug=$3, rotation_mode=$4, alert_threshold=$5, is_active=$6, fb_pixel_id=$7, fb_event_name=$8, tt_pixel_id=$9, tt_event_name=$10, gtm_id=$11, gtm_event_name=$12, gads_id=$13, gads_conversion_label=$14, updated_at=NOW()`,
      [id, b.name, b.slug || '', b.rotationMode || 'random', b.alertThreshold || 90,
       b.isActive !== false, b.fbPixelId || '', b.fbEventName || 'Lead',
       b.ttPixelId || '', b.ttEventName || 'SubmitForm',
       b.gtmId || '', b.gtmEventName || 'whatsapp_click',
       b.gadsId || '', b.gadsConversionLabel || '',
       b.createdBy || (req.user ? req.user.uid : '')]
    );
    invalidateRotateCache();
    res.json({ success: true, id: id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/campaigns/:id', authMiddleware, async function(req, res) {
  try {
    var b = req.body;
    var fields = [];
    var values = [];
    var idx = 1;
    var fieldMap = {
      name: 'name', slug: 'slug', rotationMode: 'rotation_mode',
      alertThreshold: 'alert_threshold', isActive: 'is_active',
      fbPixelId: 'fb_pixel_id', fbEventName: 'fb_event_name',
      ttPixelId: 'tt_pixel_id', ttEventName: 'tt_event_name',
      gtmId: 'gtm_id', gtmEventName: 'gtm_event_name',
      gadsId: 'gads_id', gadsConversionLabel: 'gads_conversion_label'
    };
    for (var key in fieldMap) {
      if (b[key] !== undefined) {
        fields.push(fieldMap[key] + '=$' + idx);
        values.push(b[key]);
        idx++;
      }
    }
    fields.push('updated_at=NOW()');
    values.push(req.params.id);
    if (fields.length > 1) {
      await pool.query('UPDATE campaigns SET ' + fields.join(',') + ' WHERE id=$' + idx, values);
    }
    invalidateRotateCache();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/campaigns/:id', authMiddleware, async function(req, res) {
  try {
    var campId = req.params.id;

    // Get campaign name for alert cleanup
    var campResult = await pool.query('SELECT name FROM campaigns WHERE id=$1', [campId]);
    var campName = campResult.rows.length > 0 ? campResult.rows[0].name : null;

    // Delete clicks associated with this campaign
    await pool.query('DELETE FROM clicks WHERE campaign_id=$1', [campId]);

    // Delete alerts associated with this campaign
    if (campName) {
      await pool.query('DELETE FROM alerts WHERE campaign_name=$1', [campName]);
    }

    // Delete member_events for whatsapp groups exclusively used by this campaign
    await pool.query(
      "DELETE FROM member_events WHERE whatsapp_group_id IN (" +
        "SELECT DISTINCT l.whatsapp_group_id FROM links l " +
        "WHERE l.campaign_id = $1 AND l.whatsapp_group_id IS NOT NULL " +
        "AND NOT EXISTS (SELECT 1 FROM links l2 WHERE l2.whatsapp_group_id = l.whatsapp_group_id AND l2.campaign_id != $1)" +
      ")",
      [campId]
    );

    // Delete associated links and campaign
    await pool.query('DELETE FROM links WHERE campaign_id=$1', [campId]);
    await pool.query('DELETE FROM campaigns WHERE id=$1', [campId]);
    invalidateRotateCache();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== CAMPAIGN METRICS =====

app.get('/api/campaigns/metrics', authMiddleware, async function(req, res) {
  try {
    var dateFilter = buildDateFilter(req.query, 1);

    // 1. Get clicks per campaign in the period
    var clicksR = await pool.query(
      "SELECT campaign_id, COUNT(*) as clicks FROM clicks WHERE campaign_id IS NOT NULL AND " + dateFilter + " GROUP BY campaign_id"
    );

    // 2. Get links → whatsapp_group mapping
    var linksR = await pool.query(
      'SELECT campaign_id, whatsapp_group_id FROM links WHERE campaign_id IS NOT NULL AND whatsapp_group_id IS NOT NULL'
    );

    // 3. Get member events (joins/leaves) per group in the period
    var eventsR = await pool.query(
      "SELECT whatsapp_group_id, action, COUNT(*) as cnt FROM member_events WHERE " + dateFilter + " GROUP BY whatsapp_group_id, action"
    );

    // 4. Get current members per group
    var membersR = await pool.query(
      'SELECT id, current_members FROM whatsapp_groups'
    );

    // 5. Get meta spend per campaign (if available)
    var metaR = await pool.query('SELECT id, spend FROM meta_campaigns');

    // Build campaign → groups mapping
    var campToGroups = {};
    linksR.rows.forEach(function(l) {
      if (!campToGroups[l.campaign_id]) campToGroups[l.campaign_id] = [];
      if (l.whatsapp_group_id && campToGroups[l.campaign_id].indexOf(l.whatsapp_group_id) === -1) {
        campToGroups[l.campaign_id].push(l.whatsapp_group_id);
      }
    });

    // Build group → events mapping
    var groupEvents = {};
    eventsR.rows.forEach(function(r) {
      if (!groupEvents[r.whatsapp_group_id]) groupEvents[r.whatsapp_group_id] = { joins: 0, leaves: 0 };
      if (r.action === 'join') groupEvents[r.whatsapp_group_id].joins = parseInt(r.cnt);
      else groupEvents[r.whatsapp_group_id].leaves = parseInt(r.cnt);
    });

    // Build group → current members
    var groupMembers = {};
    membersR.rows.forEach(function(r) {
      groupMembers[r.id] = parseInt(r.current_members) || 0;
    });

    // Build clicks lookup
    var clicksLookup = {};
    clicksR.rows.forEach(function(c) {
      clicksLookup[c.campaign_id] = parseInt(c.clicks);
    });

    // Build meta spend lookup
    var metaLookup = {};
    metaR.rows.forEach(function(m) {
      metaLookup[m.id] = parseFloat(m.spend) || 0;
    });

    // Build metrics per campaign
    var metrics = {};
    var allCampIds = Object.keys(campToGroups);
    // Also include campaigns with clicks but no groups
    clicksR.rows.forEach(function(c) {
      if (allCampIds.indexOf(c.campaign_id) === -1) allCampIds.push(c.campaign_id);
    });

    allCampIds.forEach(function(campId) {
      var groups = campToGroups[campId] || [];
      var totalJoins = 0, totalLeaves = 0, totalMembers = 0;
      groups.forEach(function(gid) {
        if (groupEvents[gid]) {
          totalJoins += groupEvents[gid].joins;
          totalLeaves += groupEvents[gid].leaves;
        }
        totalMembers += (groupMembers[gid] || 0);
      });

      var clicks = clicksLookup[campId] || 0;
      var retained = Math.max(0, totalJoins - totalLeaves);
      var spend = metaLookup[campId] || 0;

      // Taxa de Conversão/Entrada = (joins / clicks) * 100
      var taxaEntrada = clicks > 0 ? parseFloat(((totalJoins / clicks) * 100).toFixed(1)) : 0;
      // Taxa de Perda = ((clicks - joins) / clicks) * 100 (clicks que NÃO entraram)
      var taxaPerda = clicks > 0 ? parseFloat((((clicks - totalJoins) / clicks) * 100).toFixed(1)) : 0;
      // Taxa de Retenção = (retained / joins) * 100
      var taxaRetencao = totalJoins > 0 ? parseFloat(((retained / totalJoins) * 100).toFixed(1)) : 0;
      // Taxa de Saída = (leaves / joins) * 100 (saíram do grupo)
      var taxaSaida = totalJoins > 0 ? parseFloat(((totalLeaves / totalJoins) * 100).toFixed(1)) : 0;
      // CPL = spend / retained
      var cplRetained = retained > 0 && spend > 0 ? parseFloat((spend / retained).toFixed(4)) : 0;
      // CPL Entrada = spend / joins
      var cplEntrada = totalJoins > 0 && spend > 0 ? parseFloat((spend / totalJoins).toFixed(4)) : 0;

      metrics[campId] = {
        clicks: clicks,
        joins: totalJoins,
        leaves: totalLeaves,
        retained: retained,
        currentMembers: totalMembers,
        groups: groups.length,
        taxaEntrada: taxaEntrada,
        taxaPerda: taxaPerda,
        taxaFuga: taxaPerda, // compatibilidade com frontend
        taxaRetencao: taxaRetencao,
        taxaSaida: taxaSaida,
        spendUSD: spend,
        cplRetainedUSD: cplRetained,
        cplEntradaUSD: cplEntrada
      };
    });

    res.json({ metrics: metrics });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== LINKS =====

app.get('/api/links', authMiddleware, async function(req, res) {
  try {
    var result = await pool.query(
      'SELECT l.*, wg.current_members AS group_members FROM links l LEFT JOIN whatsapp_groups wg ON l.whatsapp_group_id = wg.id ORDER BY l.created_at DESC'
    );
    res.json(result.rows.map(mapLink));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/links', authMiddleware, async function(req, res) {
  try {
    var b = req.body;
    var id = b.id || ('link_' + Date.now());
    await pool.query(
      `INSERT INTO links (id, name, url, campaign_id, whatsapp_group_id, current_clicks, max_vacancies, weight, is_active, is_full, redirect_type, created_by, order_num)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, b.name, b.url || '',
       b.campaignId || b.campaign_id || null,
       b.whatsappGroupId || b.whatsapp_group_id || null,
       b.currentClicks || b.current_clicks || 0,
       b.maxVacancies || b.max_vacancies || 1000,
       b.weight || 1,
       b.isActive !== false,
       b.isFull || false,
       b.redirectType || b.redirect_type || 'whatsapp',
       b.createdBy || (req.user ? req.user.uid : ''),
       b.order || b.order_num || 0]
    );
    invalidateRotateCache();
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
    var fieldMap = {
      name: 'name', url: 'url',
      campaignId: 'campaign_id', campaign_id: 'campaign_id',
      whatsappGroupId: 'whatsapp_group_id', whatsapp_group_id: 'whatsapp_group_id',
      currentClicks: 'current_clicks', current_clicks: 'current_clicks',
      maxVacancies: 'max_vacancies', max_vacancies: 'max_vacancies',
      weight: 'weight',
      isActive: 'is_active', is_active: 'is_active',
      isFull: 'is_full', is_full: 'is_full',
      redirectType: 'redirect_type',
      healthCheckFailures: 'health_check_failures',
      deactivatedReason: 'deactivated_reason',
      deactivatedAt: 'deactivated_at'
    };
    for (var key in fieldMap) {
      if (b[key] !== undefined) {
        // Skip duplicate snake_case if camelCase was already processed
        var col = fieldMap[key];
        if (!fields.some(function(f) { return f.startsWith(col + '='); })) {
          fields.push(col + '=$' + idx);
          values.push(b[key]);
          idx++;
        }
      }
    }
    // Handle "delete" fields (set to null)
    if (b._deleteFields) {
      b._deleteFields.forEach(function(f) {
        var col = fieldMap[f] || f;
        if (!fields.some(function(ff) { return ff.startsWith(col + '='); })) {
          fields.push(col + '=$' + idx);
          values.push(null);
          idx++;
        }
      });
    }
    fields.push('updated_at=NOW()');
    values.push(req.params.id);
    if (fields.length > 1) {
      await pool.query('UPDATE links SET ' + fields.join(',') + ' WHERE id=$' + idx, values);
    }
    invalidateRotateCache();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/links/:id', authMiddleware, async function(req, res) {
  try {
    await pool.query('DELETE FROM links WHERE id=$1', [req.params.id]);
    invalidateRotateCache();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== CLICKS =====

app.get('/api/clicks/today', authMiddleware, async function(req, res) {
  try {
    var dateFilter = buildDateFilter(req.query, 1);

    // Use SQL aggregation instead of loading all rows into memory
    var [countR, hourlyR, devicesR] = await Promise.all([
      pool.query("SELECT COUNT(*) as total FROM clicks WHERE " + dateFilter),
      pool.query("SELECT EXTRACT(HOUR FROM timestamp)::int as hour, COUNT(*) as cnt FROM clicks WHERE " + dateFilter + " GROUP BY hour ORDER BY hour"),
      pool.query("SELECT COALESCE(device, 'Desktop') as device, COUNT(*) as cnt FROM clicks WHERE " + dateFilter + " GROUP BY device")
    ]);

    var total = parseInt(countR.rows[0].total);
    var hourly = new Array(24).fill(0);
    hourlyR.rows.forEach(function(r) { hourly[r.hour] = parseInt(r.cnt); });
    var devices = { Mobile: 0, Desktop: 0, Tablet: 0 };
    devicesR.rows.forEach(function(r) {
      var dev = r.device || 'Desktop';
      if (devices[dev] !== undefined) devices[dev] = parseInt(r.cnt);
      else devices['Desktop'] += parseInt(r.cnt);
    });

    // Only return last 100 clicks for the table (not all rows)
    var recentR = await pool.query(
      "SELECT * FROM clicks WHERE " + dateFilter + " ORDER BY timestamp DESC LIMIT 100"
    );

    res.json({ total: total, hourly: hourly, devices: devices, clicks: recentR.rows.map(mapClick) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/clicks/recent', authMiddleware, async function(req, res) {
  try {
    var result = await pool.query('SELECT * FROM clicks ORDER BY timestamp DESC LIMIT 10');
    res.json(result.rows.map(mapClick));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/clicks/range', authMiddleware, async function(req, res) {
  try {
    var days = validateDays(req.query.days, 30);
    var rangeFilter = "timestamp >= NOW() - (" + days + " * INTERVAL '1 day')";

    var [todayR, weekR, monthR, dailyR, countryR, browserR, hourlyR] = await Promise.all([
      pool.query("SELECT COUNT(*) as total FROM clicks WHERE timestamp >= CURRENT_DATE"),
      pool.query("SELECT COUNT(*) as total FROM clicks WHERE timestamp >= NOW() - INTERVAL '7 days'"),
      pool.query("SELECT COUNT(*) as total FROM clicks WHERE timestamp >= date_trunc('month', CURRENT_DATE)"),
      pool.query("SELECT timestamp::date as day, COUNT(*) as cnt FROM clicks WHERE " + rangeFilter + " GROUP BY day ORDER BY day"),
      pool.query("SELECT COALESCE(NULLIF(country, ''), COALESCE(NULLIF(country_code, ''), 'Desconhecido')) as country, COUNT(*) as cnt FROM clicks WHERE " + rangeFilter + " GROUP BY country"),
      pool.query("SELECT COALESCE(NULLIF(browser, ''), 'Outro') as browser, COUNT(*) as cnt FROM clicks WHERE " + rangeFilter + " GROUP BY browser"),
      pool.query("SELECT EXTRACT(HOUR FROM timestamp)::int as hour, COUNT(*) as cnt FROM clicks WHERE timestamp >= NOW() - INTERVAL '7 days' GROUP BY hour ORDER BY hour")
    ]);

    var dailyData = {};
    dailyR.rows.forEach(function(r) { dailyData[r.day.toISOString().split('T')[0]] = parseInt(r.cnt); });
    var countryData = {};
    countryR.rows.forEach(function(r) { countryData[r.country] = parseInt(r.cnt); });
    var browserData = {};
    browserR.rows.forEach(function(r) { browserData[r.browser] = parseInt(r.cnt); });
    var hourlyData = new Array(24).fill(0);
    hourlyR.rows.forEach(function(r) { hourlyData[r.hour] = parseInt(r.cnt); });

    res.json({
      clicksToday: parseInt(todayR.rows[0].total),
      clicksWeek: parseInt(weekR.rows[0].total),
      clicksMonth: parseInt(monthR.rows[0].total),
      dailyData: dailyData, countryData: countryData, browserData: browserData, hourlyData: hourlyData
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Paginated clicks for leads view
app.get('/api/clicks/leads', authMiddleware, async function(req, res) {
  try {
    var limit = parseInt(req.query.limit) || 50;
    var offset = parseInt(req.query.offset) || 0;
    var days = validateDays(req.query.days, 0);
    var result, countResult;
    if (days > 0) {
      result = await pool.query(
        "SELECT * FROM clicks WHERE timestamp >= NOW() - ($1 * INTERVAL '1 day') ORDER BY timestamp DESC LIMIT $2 OFFSET $3",
        [days, limit, offset]
      );
      countResult = await pool.query(
        "SELECT COUNT(*) as total FROM clicks WHERE timestamp >= NOW() - ($1 * INTERVAL '1 day')",
        [days]
      );
    } else {
      result = await pool.query(
        'SELECT * FROM clicks ORDER BY timestamp DESC LIMIT $1 OFFSET $2',
        [limit, offset]
      );
      countResult = await pool.query('SELECT COUNT(*) as total FROM clicks');
    }
    res.json({
      clicks: result.rows.map(mapClick),
      total: parseInt(countResult.rows[0].total),
      hasMore: offset + limit < parseInt(countResult.rows[0].total)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== ULTRA-FAST REDIRECT SYSTEM =====

// In-memory cache for campaigns + links (avoids DB query on every redirect)
var rotateCache = {};
var ROTATE_CACHE_TTL = 30000; // 30 seconds

async function getCampaignData(slug) {
  var now = Date.now();
  if (rotateCache[slug] && (now - rotateCache[slug].ts) < ROTATE_CACHE_TTL) {
    return rotateCache[slug].data;
  }

  var result = await pool.query(
    `SELECT c.id as camp_id, c.name as camp_name, c.slug, c.rotation_mode, c.alert_threshold,
            c.fb_pixel_id, c.fb_event_name, c.tt_pixel_id, c.tt_event_name,
            c.gtm_id, c.gtm_event_name, c.gads_id, c.gads_conversion_label,
            l.id as link_id, l.name as link_name, l.url as link_url,
            l.current_clicks, l.max_vacancies, l.weight, l.order_num
     FROM campaigns c
     JOIN links l ON l.campaign_id = c.id
     WHERE c.slug=$1 AND c.is_active=true AND l.is_active=true AND l.is_full=false
     ORDER BY l.order_num`, [slug]
  );

  if (result.rows.length === 0) {
    rotateCache[slug] = { ts: now, data: null };
    return null;
  }

  var r0 = result.rows[0];
  var data = {
    campaign: {
      id: r0.camp_id, name: r0.camp_name, slug: r0.slug,
      rotationMode: r0.rotation_mode || 'random', alertThreshold: r0.alert_threshold || 90,
      fbPixelId: r0.fb_pixel_id || '', fbEventName: r0.fb_event_name || 'Lead',
      ttPixelId: r0.tt_pixel_id || '', ttEventName: r0.tt_event_name || 'SubmitForm',
      gtmId: r0.gtm_id || '', gtmEventName: r0.gtm_event_name || 'whatsapp_click',
      gadsId: r0.gads_id || '', gadsConversionLabel: r0.gads_conversion_label || ''
    },
    links: result.rows.map(function(r) {
      return { id: r.link_id, name: r.link_name, url: r.link_url, currentClicks: r.current_clicks, maxVacancies: r.max_vacancies, weight: r.weight || 1, order: r.order_num || 0 };
    }),
    hasPixels: !!(r0.fb_pixel_id || r0.tt_pixel_id || r0.gtm_id || r0.gads_id)
  };

  rotateCache[slug] = { ts: now, data: data };
  return data;
}

// Invalidate cache when links/campaigns change
function invalidateRotateCache(slug) {
  if (slug) { delete rotateCache[slug]; }
  else { rotateCache = {}; }
}

// Select link based on rotation mode
// Sequential counters: in-memory for speed, persisted to PostgreSQL for durability
var sequentialCounters = {};

// Persist sequential counter to DB in background (fire-and-forget)
function persistSequentialCounter(slug, value) {
  pool.query(
    'UPDATE campaigns SET sequential_counter = $1 WHERE slug = $2',
    [value, slug]
  ).catch(function(err) {
    console.error('[ROTATE] Erro ao persistir contador sequencial:', err.message);
  });
}

// Load all sequential counters from DB into memory
async function loadSequentialCounters() {
  try {
    var result = await pool.query('SELECT slug, sequential_counter FROM campaigns WHERE slug IS NOT NULL');
    result.rows.forEach(function(row) {
      if (row.slug) {
        sequentialCounters[row.slug] = row.sequential_counter || 0;
      }
    });
    console.log('[ROTATE] Contadores sequenciais carregados do banco:', Object.keys(sequentialCounters).length, 'campanhas');
  } catch (err) {
    if (err.message && err.message.includes('sequential_counter')) {
      // Coluna não existe ainda - tenta criar e carrega sem ela
      console.warn('[ROTATE] Coluna sequential_counter não existe. Tentando criar...');
      try {
        await pool.query('ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS sequential_counter INTEGER DEFAULT 0');
        console.log('[ROTATE] Coluna sequential_counter criada com sucesso');
        var result = await pool.query('SELECT slug, sequential_counter FROM campaigns WHERE slug IS NOT NULL');
        result.rows.forEach(function(row) {
          if (row.slug) sequentialCounters[row.slug] = row.sequential_counter || 0;
        });
      } catch (alterErr) {
        console.warn('[ROTATE] Não foi possível criar coluna sequential_counter:', alterErr.message);
        // Carrega slugs sem o contador
        try {
          var slugResult = await pool.query('SELECT slug FROM campaigns WHERE slug IS NOT NULL');
          slugResult.rows.forEach(function(row) {
            if (row.slug) sequentialCounters[row.slug] = 0;
          });
          console.log('[ROTATE] Contadores inicializados em memória (sem persistência):', Object.keys(sequentialCounters).length);
        } catch (e) { /* ignora */ }
      }
    } else {
      console.error('[ROTATE] Erro ao carregar contadores sequenciais:', err.message);
    }
  }
}

function selectLink(links, mode, slug) {
  if (links.length === 1) return links[0];

  if (mode === 'weighted') {
    var totalWeight = links.reduce(function(s, l) { return s + l.weight; }, 0);
    var rand = Math.random() * totalWeight;
    var cum = 0;
    for (var i = 0; i < links.length; i++) {
      cum += links[i].weight;
      if (rand <= cum) return links[i];
    }
    return links[links.length - 1];
  }
  if (mode === 'least-filled') {
    var sorted = links.slice().sort(function(a, b) {
      return (a.currentClicks / (a.maxVacancies || 1)) - (b.currentClicks / (b.maxVacancies || 1));
    });
    return sorted[0];
  }
  if (mode === 'sequential') {
    var idx = sequentialCounters[slug] || 0;
    sequentialCounters[slug] = idx + 1;
    persistSequentialCounter(slug, sequentialCounters[slug]);
    return links[idx % links.length];
  }
  // random
  return links[Math.floor(Math.random() * links.length)];
}

// Parse User-Agent server-side
function parseUA(ua) {
  if (!ua) return { device: 'Desktop', browser: 'Outro', os: 'Outro' };
  var device = /tablet|ipad/i.test(ua) ? 'Tablet' : /mobile|iphone|android/i.test(ua) ? 'Mobile' : 'Desktop';
  var browser = ua.indexOf('Firefox')>-1?'Firefox':ua.indexOf('SamsungBrowser')>-1?'Samsung':ua.indexOf('OPR')>-1?'Opera':ua.indexOf('Edg')>-1?'Edge':ua.indexOf('Chrome')>-1?'Chrome':ua.indexOf('Safari')>-1?'Safari':'Outro';
  var os = ua.indexOf('Windows')>-1?'Windows':ua.indexOf('Android')>-1?'Android':/iPhone|iPad/.test(ua)?'iOS':ua.indexOf('Mac')>-1?'macOS':'Outro';
  return { device: device, browser: browser, os: os };
}

// IP rate limiting (in-memory, simple)
var ipRateLimit = {};
function checkRateLimit(ip) {
  var now = Date.now();
  if (!ipRateLimit[ip]) ipRateLimit[ip] = [];
  ipRateLimit[ip] = ipRateLimit[ip].filter(function(t) { return now - t < 60000; });
  if (ipRateLimit[ip].length >= 15) return false;
  ipRateLimit[ip].push(now);
  return true;
}
// Clean rate limit map every 5 min
setInterval(function() {
  var now = Date.now();
  Object.keys(ipRateLimit).forEach(function(ip) {
    ipRateLimit[ip] = ipRateLimit[ip].filter(function(t) { return now - t < 60000; });
    if (ipRateLimit[ip].length === 0) delete ipRateLimit[ip];
  });
}, 5 * 60 * 1000);

// Background click recording (fire and forget)
function recordClickBackground(linkId, linkName, campId, campName, visitor, threshold) {
  pool.query(
    'INSERT INTO clicks (link_id, link_name, campaign_id, device, browser, os, city, country, country_code, ip, referrer) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [linkId, linkName, campId, visitor.device||'', visitor.browser||'', visitor.os||'', visitor.city||'', visitor.country||'', visitor.countryCode||'', visitor.ip||'', visitor.referrer||'']
  ).catch(function(e) { console.error('[ROTATE] Click error:', e.message); });

  pool.query(
    'UPDATE links SET current_clicks = current_clicks + 1, is_full = CASE WHEN current_clicks + 1 >= max_vacancies THEN true ELSE false END, updated_at = NOW() WHERE id=$1 RETURNING current_clicks, max_vacancies, is_full',
    [linkId]
  ).then(function(updResult) {
    if (!updResult.rows.length) return;
    var upd = updResult.rows[0];
    // Invalidate cache if link became full
    if (upd.is_full) {
      rotateCache = {}; // force refresh
      pool.query('INSERT INTO alerts (type, campaign_name, link_name, message, read) VALUES ($1,$2,$3,$4,false)',
        ['link_full', campName, linkName, 'Grupo cheio: ' + linkName]).catch(function(){});
    } else {
      var fillPct = (upd.current_clicks / (upd.max_vacancies || 1)) * 100;
      if (fillPct >= threshold) {
        pool.query('INSERT INTO alerts (type, campaign_name, link_name, percent, message, read) VALUES ($1,$2,$3,$4,$5,false)',
          ['link_near_full', campName, linkName, Math.round(fillPct), 'Grupo quase cheio: ' + linkName + ' (' + Math.round(fillPct) + '%)']).catch(function(){});
      }
    }
  }).catch(function(e) { console.error('[ROTATE] Update error:', e.message); });
}

// ===== SERVER-SIDE REDIRECT: GET /r/:slug (FASTEST - no HTML/JS needed) =====
app.get('/r/:slug', async function(req, res) {
  try {
    var slug = req.params.slug;
    var ip = req.headers['x-forwarded-for'] || req.ip;

    // Rate limit
    if (!checkRateLimit(ip)) {
      return res.status(429).send('Muitas tentativas. Aguarde.');
    }

    // Get cached campaign data
    var data = await getCampaignData(slug);
    if (!data) {
      return res.status(404).send('<!DOCTYPE html><html><body style="background:#0d1b2a;color:#e0e0e0;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh"><div style="text-align:center"><p style="color:#FF3B30">Campanha não encontrada ou todos os grupos estão cheios.</p></div></body></html>');
    }

    // Select link
    var selected = selectLink(data.links, data.campaign.rotationMode, slug);

    // Parse visitor from headers
    var ua = req.headers['user-agent'] || '';
    var visitor = parseUA(ua);
    visitor.ip = ip;
    visitor.referrer = req.headers.referer || '';

    // Record click in background
    recordClickBackground(selected.id, selected.name, data.campaign.id, data.campaign.name, visitor, data.campaign.alertThreshold);

    // If campaign has pixels configured, serve inline HTML with pixels + redirect
    if (data.hasPixels) {
      var pixelHtml = '<!DOCTYPE html><html><head><meta charset="UTF-8">';
      pixelHtml += '<meta http-equiv="refresh" content="0;url=' + escapeHtml(selected.url) + '">';

      // Facebook Pixel
      if (data.campaign.fbPixelId) {
        pixelHtml += '<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version="2.0";n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,"script","https://connect.facebook.net/en_US/fbevents.js");fbq("init","' + data.campaign.fbPixelId + '");fbq("track","PageView");fbq("track","' + (data.campaign.fbEventName || 'Lead') + '",{content_name:"' + escapeHtml(selected.name) + '"});</script>';
        pixelHtml += '<noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=' + data.campaign.fbPixelId + '&ev=PageView&noscript=1"></noscript>';
      }

      // TikTok Pixel
      if (data.campaign.ttPixelId) {
        pixelHtml += '<script>!function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie"];ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.instance=function(t){for(var e=ttq._i[t]||[],n=0;n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e};ttq.load=function(e,n){var i="https://analytics.tiktok.com/i18n/pixel/events.js";ttq._i=ttq._i||{};ttq._i[e]=[];ttq._i[e]._u=i;ttq._t=ttq._t||{};ttq._t[e]=+new Date;ttq._o=ttq._o||{};ttq._o[e]=n||{};var o=document.createElement("script");o.type="text/javascript";o.async=!0;o.src=i+"?sdkid="+e+"&lib="+t;var a=document.getElementsByTagName("script")[0];a.parentNode.insertBefore(o,a)};ttq.load("' + data.campaign.ttPixelId + '");ttq.page();}(window,document,"ttq");ttq.track("' + (data.campaign.ttEventName || 'SubmitForm') + '");</script>';
      }

      // GTM
      if (data.campaign.gtmId) {
        pixelHtml += '<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({"gtm.start":new Date().getTime(),event:"gtm.js"});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!="dataLayer"?"&l="+l:"";j.async=true;j.src="https://www.googletagmanager.com/gtm.js?id="+i+dl;f.parentNode.insertBefore(j,f);})(window,document,"script","dataLayer","' + data.campaign.gtmId + '");window.dataLayer=window.dataLayer||[];window.dataLayer.push({event:"' + (data.campaign.gtmEventName || 'whatsapp_click') + '"});</script>';
      }

      // Google Ads
      if (data.campaign.gadsId) {
        pixelHtml += '<script async src="https://www.googletagmanager.com/gtag/js?id=' + data.campaign.gadsId + '"></script>';
        pixelHtml += '<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag("js",new Date());gtag("config","' + data.campaign.gadsId + '");';
        if (data.campaign.gadsConversionLabel) {
          pixelHtml += 'gtag("event","conversion",{send_to:"' + data.campaign.gadsId + '/' + data.campaign.gadsConversionLabel + '"});';
        }
        pixelHtml += '</script>';
      }

      pixelHtml += '</head><body><script>window.location.replace("' + escapeHtml(selected.url) + '");</script></body></html>';

      res.set('Content-Type', 'text/html; charset=utf-8');
      res.set('Cache-Control', 'no-cache, no-store');
      return res.send(pixelHtml);
    }

    // NO PIXELS: Pure 302 redirect (fastest possible)
    res.set('Cache-Control', 'no-cache, no-store');
    res.redirect(302, selected.url);

  } catch (err) {
    console.error('[ROTATE] Error:', err.message);
    if (!res.headersSent) res.status(500).send('Erro interno');
  }
});

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ===== ROTATE - POST API endpoint (kept for backward compatibility with r.html) =====
app.post('/api/rotate', async function(req, res) {
  try {
    var slug = req.body.slug;
    if (!slug) return res.status(400).json({ error: 'Slug obrigatório' });

    // Server-side rate limiting (same as /r/:slug)
    var ip = req.headers['x-forwarded-for'] || req.ip;
    if (!checkRateLimit(ip)) {
      return res.status(429).json({ error: 'Muitas tentativas. Aguarde.' });
    }

    var data = await getCampaignData(slug);
    if (!data) {
      return res.status(404).json({ error: 'Campanha não encontrada ou todos os grupos estão cheios' });
    }

    var selected = selectLink(data.links, data.campaign.rotationMode, slug);

    // Respond immediately
    res.json({ url: selected.url, campaign: data.campaign, link: { id: selected.id, name: selected.name } });

    // Background processing
    var v = req.body.visitor || {};
    v.ip = v.ip || req.ip;
    recordClickBackground(selected.id, selected.name, data.campaign.id, data.campaign.name, v, data.campaign.alertThreshold);

  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// Report broken link (no auth - called from redirect page)
var brokenLinkReports = {}; // track IP+linkId to prevent abuse
setInterval(function() { brokenLinkReports = {}; }, 30 * 60 * 1000);

app.post('/api/report-broken-link', async function(req, res) {
  try {
    var ip = req.headers['x-forwarded-for'] || req.ip;
    if (!checkRateLimit(ip)) {
      return res.status(429).json({ error: 'Muitas tentativas. Aguarde.' });
    }
    var b = req.body;
    var linkId = b.linkId;
    if (!linkId) return res.status(400).json({ error: 'linkId obrigatório' });

    // Only count 1 report per IP per link
    var reportKey = ip + ':' + linkId;
    if (brokenLinkReports[reportKey]) {
      return res.json({ success: true, alreadyReported: true });
    }
    brokenLinkReports[reportKey] = true;

    var result = await pool.query(
      'UPDATE links SET health_check_failures = health_check_failures + 1, updated_at = NOW() WHERE id=$1 RETURNING health_check_failures, name, campaign_id',
      [linkId]
    );
    if (result.rows.length > 0 && result.rows[0].health_check_failures >= 3) {
      await pool.query(
        "UPDATE links SET is_active=false, deactivated_reason='Link possivelmente banido/expirado (3 falhas consecutivas)', deactivated_at=NOW() WHERE id=$1",
        [linkId]
      );
      var campName = '';
      if (result.rows[0].campaign_id) {
        var cn = await pool.query('SELECT name FROM campaigns WHERE id=$1', [result.rows[0].campaign_id]);
        if (cn.rows.length > 0) campName = cn.rows[0].name;
      }
      await pool.query(
        'INSERT INTO alerts (type, link_name, campaign_name, message, read) VALUES ($1,$2,$3,$4,false)',
        ['link_broken', result.rows[0].name, campName, 'Link desativado automaticamente - possivelmente banido ou expirado']
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Record a click (called from redirect page - no auth needed)
app.post('/api/clicks', async function(req, res) {
  try {
    var ip = req.headers['x-forwarded-for'] || req.ip;
    if (!checkRateLimit(ip)) {
      return res.status(429).json({ error: 'Muitas tentativas. Aguarde.' });
    }
    var b = req.body;
    await pool.query(
      'INSERT INTO clicks (link_id, link_name, campaign_id, device, browser, os, city, country, country_code, ip, referrer) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [b.linkId, b.linkName, b.campaignId, b.device, b.browser, b.os || '', b.city, b.country, b.countryCode, b.ip || req.ip, b.referrer]
    );
    // Increment link clicks with is_full check and alerts (same logic as recordClickBackground)
    if (b.linkId) {
      var updResult = await pool.query(
        'UPDATE links SET current_clicks = current_clicks + 1, is_full = CASE WHEN current_clicks + 1 >= max_vacancies THEN true ELSE false END, updated_at = NOW() WHERE id=$1 RETURNING current_clicks, max_vacancies, is_full',
        [b.linkId]
      );
      if (updResult.rows.length) {
        var upd = updResult.rows[0];
        // Look up campaign name and alert threshold
        var campResult = await pool.query('SELECT name, alert_threshold FROM campaigns WHERE id=$1', [b.campaignId]);
        var campName = campResult.rows.length ? campResult.rows[0].name : '';
        var threshold = campResult.rows.length ? (campResult.rows[0].alert_threshold || 80) : 80;
        if (upd.is_full) {
          rotateCache = {}; // force refresh
          pool.query('INSERT INTO alerts (type, campaign_name, link_name, message, read) VALUES ($1,$2,$3,$4,false)',
            ['link_full', campName, b.linkName, 'Grupo cheio: ' + b.linkName]).catch(function(){});
        } else {
          var fillPct = (upd.current_clicks / (upd.max_vacancies || 1)) * 100;
          if (fillPct >= threshold) {
            pool.query('INSERT INTO alerts (type, campaign_name, link_name, percent, message, read) VALUES ($1,$2,$3,$4,$5,false)',
              ['link_near_full', campName, b.linkName, Math.round(fillPct), 'Grupo quase cheio: ' + b.linkName + ' (' + Math.round(fillPct) + '%)']).catch(function(){});
          }
        }
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== MEMBER EVENTS =====

app.get('/api/member-events/today', authMiddleware, async function(req, res) {
  try {
    var dateFilter = buildDateFilter(req.query, 1);
    var result = await pool.query(
      "SELECT * FROM member_events WHERE " + dateFilter + " ORDER BY timestamp DESC"
    );
    var joins = 0, leaves = 0;
    result.rows.forEach(function(r) {
      if (r.action === 'join') joins++;
      else if (r.action === 'leave') leaves++;
    });
    var events = result.rows.map(function(r) {
      return {
        id: r.id,
        whatsappGroupId: r.whatsapp_group_id,
        groupName: r.group_name,
        phone: r.phone,
        phonePartial: r.phone_partial,
        action: r.action,
        timestamp: r.timestamp ? { seconds: Math.floor(new Date(r.timestamp).getTime() / 1000) } : null
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
    var days = validateDays(req.query.days, 7);
    var result = await pool.query(
      "SELECT * FROM member_events WHERE timestamp >= NOW() - ($1 * INTERVAL '1 day') ORDER BY timestamp DESC",
      [days]
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
    var dateFilter = buildDateFilter(req.query, 1);

    var [groupsR, eventsR, clicksR, groupCountR] = await Promise.all([
      pool.query('SELECT COALESCE(SUM(current_members),0) as total FROM whatsapp_groups'),
      pool.query("SELECT action, COUNT(*) as cnt FROM member_events WHERE " + dateFilter + " GROUP BY action"),
      pool.query("SELECT COUNT(*) as cnt FROM clicks WHERE " + dateFilter),
      pool.query('SELECT COUNT(*) as cnt FROM whatsapp_groups')
    ]);
    var totalMembers = parseInt(groupsR.rows[0].total);
    var totalGroups = parseInt(groupCountR.rows[0].cnt);
    var joins = 0, leaves = 0;
    eventsR.rows.forEach(function(r) {
      if (r.action === 'join') joins = parseInt(r.cnt);
      else leaves = parseInt(r.cnt);
    });
    var totalClicks = parseInt(clicksR.rows[0].cnt);

    // Taxa de Conversão: % de clicks que resultaram em entradas no grupo
    var taxaConversao = totalClicks > 0 ? parseFloat(((joins / totalClicks) * 100).toFixed(1)) : 0;

    // Taxa de Perda (ex-"fuga"): % de clicks que NÃO resultaram em entradas
    // = inverso da conversão
    var taxaPerda = totalClicks > 0 ? parseFloat((((totalClicks - joins) / totalClicks) * 100).toFixed(1)) : 0;

    // Taxa de Saída: % dos que entraram e depois saíram (saídas / entradas)
    var taxaSaida = joins > 0 ? parseFloat(((leaves / joins) * 100).toFixed(1)) : 0;

    // Taxa de Retenção: % dos que entraram e ficaram
    var retained = Math.max(0, joins - leaves);
    var taxaRetencao = joins > 0 ? parseFloat(((retained / joins) * 100).toFixed(1)) : 100.0;

    res.json({
      totalMembers: totalMembers,
      totalGroups: totalGroups,
      joins: joins,
      leaves: leaves,
      clicks: totalClicks,
      retained: retained,
      taxaConversao: taxaConversao,
      taxaPerda: Math.max(0, taxaPerda),
      taxaSaida: taxaSaida,
      taxaRetencao: taxaRetencao,
      saldoLiquido: joins - leaves,
      // Compatibilidade com frontend antigo
      joinsToday: joins,
      leavesToday: leaves,
      clicksToday: totalClicks,
      taxaFuga: Math.max(0, taxaPerda)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== LEADS SUMMARY (total real de leads) =====
app.get('/api/stats/leads-summary', authMiddleware, async function(req, res) {
  try {
    var dateFilter = buildDateFilter(req.query, 1);

    var [totalAllTimeR, totalPeriodR, activeLeadsR, uniqueIPsR] = await Promise.all([
      pool.query("SELECT COUNT(*) as total FROM clicks"),
      pool.query("SELECT COUNT(*) as total FROM clicks WHERE " + dateFilter),
      pool.query("SELECT COUNT(*) FILTER (WHERE is_active = true) as active, COUNT(*) as total FROM lead_contacts"),
      pool.query("SELECT COUNT(DISTINCT ip) as unique_ips FROM clicks WHERE " + dateFilter + " AND ip IS NOT NULL AND ip != ''")
    ]);

    res.json({
      clicksAllTime: parseInt(totalAllTimeR.rows[0].total),
      clicksPeriod: parseInt(totalPeriodR.rows[0].total),
      activeLeadContacts: parseInt(activeLeadsR.rows[0].active) || 0,
      totalLeadContacts: parseInt(activeLeadsR.rows[0].total) || 0,
      uniqueVisitors: parseInt(uniqueIPsR.rows[0].unique_ips) || 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== ALERTS =====

app.get('/api/alerts', authMiddleware, async function(req, res) {
  try {
    var page = Math.max(1, parseInt(req.query.page) || 1);
    var limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    var offset = (page - 1) * limit;
    var countResult = await pool.query('SELECT COUNT(*) as total FROM alerts');
    var total = parseInt(countResult.rows[0].total);
    var result = await pool.query('SELECT * FROM alerts ORDER BY timestamp DESC LIMIT $1 OFFSET $2', [limit, offset]);
    res.json({
      data: result.rows.map(mapAlert),
      pagination: { page: page, limit: limit, total: total, totalPages: Math.ceil(total / limit) }
    });
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

app.delete('/api/alerts/:id', authMiddleware, async function(req, res) {
  try {
    await pool.query('DELETE FROM alerts WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/alerts/clear-all', authMiddleware, async function(req, res) {
  try {
    await pool.query('DELETE FROM alerts WHERE read=true');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== META CAMPAIGNS (from DB) =====

app.get('/api/meta-campaigns', authMiddleware, async function(req, res) {
  try {
    var result = await pool.query('SELECT * FROM meta_campaigns ORDER BY last_synced DESC');
    // NOTA: Todos os valores monetários estão em USD (moeda da conta Meta)
    res.json(result.rows.map(function(r) {
      var spend = parseFloat(r.spend || 0);
      var clicks = parseInt(r.clicks || 0);
      var impressions = parseInt(r.impressions || 0);
      // Fix: parseFloat primeiro, depois verificar > 0 (PG retorna "0.0000" como string truthy)
      var cpcVal = parseFloat(r.cpc || 0);
      var cpc = cpcVal > 0 ? cpcVal : (clicks > 0 ? spend / clicks : 0);
      var cpmVal = parseFloat(r.cpm || 0);
      var cpm = cpmVal > 0 ? cpmVal : (impressions > 0 ? (spend / impressions) * 1000 : 0);
      var ctrVal = parseFloat(r.ctr || 0);
      var ctr = ctrVal > 0 ? ctrVal : (impressions > 0 ? (clicks / impressions) * 100 : 0);
      return {
        id: r.id, name: r.name, status: r.status, objective: r.objective,
        dailyBudget: parseFloat(r.daily_budget || 0),  // USD
        spend: spend,                                    // USD
        impressions: impressions,
        clicks: clicks,
        cpc: cpc,                                        // USD
        cpm: cpm,                                        // USD
        ctr: ctr,                                        // %
        reach: parseInt(r.reach || 0),
        conversions: parseInt(r.conversions || 0),
        costPerResult: parseFloat(r.cost_per_result || 0) // USD
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

// Token health check - verifica se o token Meta ainda é válido
app.get('/api/meta/token-status', authMiddleware, async function(req, res) {
  try {
    var tokenInfo = await metaApi.debugToken();
    if (tokenInfo && tokenInfo.data) {
      var d = tokenInfo.data;
      var expiresAt = d.expires_at ? new Date(d.expires_at * 1000) : null;
      var daysLeft = expiresAt ? Math.ceil((expiresAt - Date.now()) / (1000 * 60 * 60 * 24)) : null;
      res.json({
        valid: d.is_valid !== false,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
        daysLeft: daysLeft,
        scopes: d.scopes || [],
        appId: d.app_id,
        warning: daysLeft !== null && daysLeft < 7 ? 'Token expira em ' + daysLeft + ' dias!' : null
      });
    } else {
      res.json({ valid: false, error: 'Não foi possível verificar o token' });
    }
  } catch (err) {
    res.json({ valid: false, error: err.message });
  }
});

// Batch insights - fetch all campaigns with insights in parallel (fast)
app.get('/api/meta/insights-batch', authMiddleware, async function(req, res) {
  try {
    var dateRange = req.query.date_range || 'today';

    // For "today", return DB cache (instant)
    // NOTA: Todos os valores monetários (spend, cpc, cpm, costPerResult) estão em USD
    if (dateRange === 'today') {
      var dbResult = await pool.query('SELECT * FROM meta_campaigns ORDER BY name');
      var mapped = dbResult.rows.map(function(r) {
        var spend = parseFloat(r.spend || 0);
        var clicks = parseInt(r.clicks || 0);
        var impressions = parseInt(r.impressions || 0);
        // Fix: parseFloat primeiro, depois verificar > 0 (PG retorna "0.0000" como string truthy)
        var cpcVal = parseFloat(r.cpc || 0);
        var cpc = cpcVal > 0 ? cpcVal : (clicks > 0 ? spend / clicks : 0);
        var cpmVal = parseFloat(r.cpm || 0);
        var cpm = cpmVal > 0 ? cpmVal : (impressions > 0 ? (spend / impressions) * 1000 : 0);
        var ctrVal = parseFloat(r.ctr || 0);
        var ctr = ctrVal > 0 ? ctrVal : (impressions > 0 ? (clicks / impressions) * 100 : 0);
        return {
          id: r.id, name: r.name, status: r.status, objective: r.objective,
          dailyBudget: parseFloat(r.daily_budget || 0),   // USD
          spend: spend,                                     // USD
          impressions: impressions,
          clicks: clicks,
          cpc: cpc,                                         // USD
          cpm: cpm,                                         // USD
          ctr: ctr,                                         // %
          reach: parseInt(r.reach || 0),
          frequency: 0,
          uniqueClicks: 0,
          conversions: parseInt(r.conversions || 0),
          costPerResult: parseFloat(r.cost_per_result || 0), // USD
          roas: 0,
          qualityRanking: '', engagementRanking: '', conversionRanking: ''
        };
      });
      return res.json({ campaigns: mapped, source: 'cache' });
    }

    // For other ranges, fetch from Meta API in parallel
    var campaigns = await metaApi.getCampaigns();
    if (!campaigns || !campaigns.data) return res.json({ campaigns: [], source: 'api' });

    var promises = campaigns.data.map(function(camp) {
      return metaApi.getCampaignInsights(camp.id, dateRange).then(function(insights) {
        var d = insights && insights.data && insights.data[0] ? insights.data[0] : {};
        var normalized = metaApi.normalizeInsight(d);
        return {
          id: camp.id, name: camp.name, status: camp.effective_status || camp.status || 'N/A',
          spend: normalized.spend,          // USD
          impressions: normalized.impressions,
          clicks: normalized.clicks,
          cpc: normalized.cpc,              // USD
          cpm: normalized.cpm,              // USD
          ctr: normalized.ctr,              // %
          reach: normalized.reach,
          frequency: normalized.frequency,
          uniqueClicks: normalized.uniqueClicks,
          conversions: normalized.conversions,
          costPerResult: normalized.costPerResult,  // USD
          roas: normalized.roas,
          qualityRanking: normalized.qualityRanking,
          engagementRanking: normalized.engagementRanking,
          conversionRanking: normalized.conversionRanking
        };
      }).catch(function() {
        return {
          id: camp.id, name: camp.name, status: camp.effective_status || camp.status || 'N/A',
          spend: 0, impressions: 0, clicks: 0, cpc: 0, cpm: 0, ctr: 0,
          reach: 0, frequency: 0, uniqueClicks: 0,
          conversions: 0, costPerResult: 0, roas: 0,
          qualityRanking: '', engagementRanking: '', conversionRanking: ''
        };
      });
    });

    var results = await Promise.all(promises);
    res.json({ campaigns: results, source: 'api' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Funnel data: rotator clicks + member events for a specific date range
app.get('/api/meta/funnel-data', authMiddleware, async function(req, res) {
  try {
    var dateRange = req.query.date_range || 'today';

    // Convert Meta date range presets to SQL conditions
    var dateCondition;
    switch (dateRange) {
      case 'today':
        dateCondition = "timestamp >= CURRENT_DATE";
        break;
      case 'yesterday':
        dateCondition = "timestamp >= CURRENT_DATE - INTERVAL '1 day' AND timestamp < CURRENT_DATE";
        break;
      case 'last_3d':
        dateCondition = "timestamp >= NOW() - INTERVAL '3 days'";
        break;
      case 'last_7d':
        dateCondition = "timestamp >= NOW() - INTERVAL '7 days'";
        break;
      case 'last_14d':
        dateCondition = "timestamp >= NOW() - INTERVAL '14 days'";
        break;
      case 'last_30d':
        dateCondition = "timestamp >= NOW() - INTERVAL '30 days'";
        break;
      case 'this_month':
        dateCondition = "timestamp >= DATE_TRUNC('month', CURRENT_DATE)";
        break;
      case 'last_month':
        dateCondition = "timestamp >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month') AND timestamp < DATE_TRUNC('month', CURRENT_DATE)";
        break;
      default:
        dateCondition = "timestamp >= CURRENT_DATE";
    }

    var [clicksR, eventsR] = await Promise.all([
      pool.query("SELECT COUNT(*) as total FROM clicks WHERE " + dateCondition),
      pool.query("SELECT action, COUNT(*) as cnt FROM member_events WHERE " + dateCondition + " GROUP BY action")
    ]);

    var rotatorClicks = parseInt(clicksR.rows[0].total || 0);
    var joins = 0, leaves = 0;
    eventsR.rows.forEach(function(r) {
      if (r.action === 'join') joins = parseInt(r.cnt);
      else if (r.action === 'leave') leaves = parseInt(r.cnt);
    });

    res.json({
      dateRange: dateRange,
      rotatorClicks: rotatorClicks,
      joins: joins,
      leaves: leaves,
      retained: Math.max(0, joins - leaves)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== EXCHANGE RATE (USD → BRL) =====

var exchangeRateCache = { rate: null, timestamp: 0 };
var EXCHANGE_CACHE_TTL = 60 * 60 * 1000; // 1 hora (reduzido para evitar rate limit)

async function getUsdToBrl() {
  var now = Date.now();
  if (exchangeRateCache.rate && (now - exchangeRateCache.timestamp) < EXCHANGE_CACHE_TTL) {
    return exchangeRateCache.rate;
  }
  try {
    // Try AwesomeAPI first
    var resp = await fetch('https://economia.awesomeapi.com.br/last/USD-BRL');
    var data = await resp.json();
    if (data && data.USDBRL && data.USDBRL.bid) {
      var rate = parseFloat(data.USDBRL.bid);
      exchangeRateCache = { rate: rate, timestamp: now };
      return rate;
    }
    // Fallback: try open.er-api.com (free, no key needed)
    var resp2 = await fetch('https://open.er-api.com/v6/latest/USD');
    var data2 = await resp2.json();
    if (data2 && data2.rates && data2.rates.BRL) {
      var rate2 = parseFloat(data2.rates.BRL);
      exchangeRateCache = { rate: rate2, timestamp: now };
      return rate2;
    }
    throw new Error('Formato inesperado da API');
  } catch (err) {
    if (!exchangeRateCache._logged || (now - exchangeRateCache._logged) > 3600000) {
      console.error('[EXCHANGE] Erro ao buscar cotação:', err.message);
      exchangeRateCache._logged = now;
    }
    return exchangeRateCache.rate || 5.70; // fallback R$5.70
  }
}

app.get('/api/exchange-rate', authMiddleware, async function(req, res) {
  try {
    var rate = await getUsdToBrl();
    res.json({ rate: rate, currency: 'BRL', base: 'USD', cached: (Date.now() - exchangeRateCache.timestamp) < 1000 ? false : true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== WHATSAPP ROUTES =====

// Webhook da Evolution API (aceita eventos com ou sem apikey)
// Suporta formatos v1 e v2
app.post('/api/whatsapp/webhook', async function(req, res) {
  try {
    var body = req.body;
    var event = body && (body.event || body.action);
    if (event) {
      console.log('[WEBHOOK] Evento recebido: ' + event + ' | instance: ' + (body.instance || body.instanceName || 'N/A'));
    } else {
      console.log('[WEBHOOK] Payload recebido (sem event):', JSON.stringify(body).substring(0, 200));
    }
    await whatsappMonitor.handleWebhook(body);
    res.json({ ok: true });
  } catch (err) {
    console.error('[WEBHOOK] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Rota alternativa para webhooks (Evolution API v2 pode enviar para paths diferentes)
app.post('/api/whatsapp/webhook/:event', async function(req, res) {
  try {
    var body = req.body;
    if (!body.event && req.params.event) {
      body.event = req.params.event.replace(/-/g, '.').toUpperCase().replace(/\./g, '_');
    }
    console.log('[WEBHOOK] Evento via path: ' + (body.event || req.params.event));
    await whatsappMonitor.handleWebhook(body);
    res.json({ ok: true });
  } catch (err) {
    console.error('[WEBHOOK] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/whatsapp/status', authMiddleware, function(req, res) {
  var status = whatsappMonitor.getStatus();
  // Adiciona info extra para debug no frontend
  status.serverTime = new Date().toISOString();
  res.json(status);
});

// Rota de debug para testar conexão com Evolution API (apenas em dev)
app.get('/api/whatsapp/debug', authMiddleware, async function(req, res) {
  try {
    var status = whatsappMonitor.getStatus();
    var evoUrl = (process.env.EVOLUTION_API_URL || 'http://localhost:8080').replace(/\/$/, '');
    var evoKey = process.env.EVOLUTION_API_KEY || process.env.AUTHENTICATION_API_KEY || '';
    var evoInstance = process.env.EVOLUTION_INSTANCE_NAME || 'linkrotator';

    var result = {
      config: {
        evolutionApiUrl: evoUrl,
        evolutionApiKey: evoKey ? evoKey.substring(0, 4) + '***' : 'NÃO CONFIGURADA',
        instanceName: evoInstance,
        webhookUrl: (function() {
          var wh = (process.env.EVOLUTION_WEBHOOK_URL || '').trim();
          if (!wh) {
            var fu = (process.env.FRONTEND_URL || '').trim();
            wh = (fu && fu !== '*') ? fu : 'http://localhost:' + (process.env.PORT || 3000);
          }
          return wh.replace(/\/$/, '') + '/api/whatsapp/webhook';
        })()
      },
      status: status,
      timestamp: new Date().toISOString()
    };

    // Testa endpoints diretamente para debug
    var headers = { 'Content-Type': 'application/json', 'apikey': evoKey };
    var tests = {};

    // 1. Busca instâncias
    try {
      var r1 = await fetch(evoUrl + '/instance/fetchInstances', { headers: headers });
      tests.fetchInstances = { status: r1.status, body: JSON.parse(await r1.text()) };
    } catch (e) { tests.fetchInstances = { error: e.message }; }

    // 2. Estado da conexão
    try {
      var r2 = await fetch(evoUrl + '/instance/connectionState/' + evoInstance, { headers: headers });
      tests.connectionState = { status: r2.status, body: JSON.parse(await r2.text()) };
    } catch (e) { tests.connectionState = { error: e.message }; }

    // 3. Connect (QR)
    try {
      var r3 = await fetch(evoUrl + '/instance/connect/' + evoInstance, { headers: headers });
      var r3text = await r3.text();
      var r3body;
      try { r3body = JSON.parse(r3text); } catch(e) { r3body = r3text.substring(0, 1000); }
      tests.connect = { status: r3.status, body: r3body, bodyKeys: r3body && typeof r3body === 'object' ? Object.keys(r3body) : null };
    } catch (e) { tests.connect = { error: e.message }; }

    result.apiTests = tests;
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/whatsapp/qr', authMiddleware, async function(req, res) {
  var qr = whatsappMonitor.getQR();
  if (qr) {
    res.json({ qr: qr, status: 'waiting_scan' });
  } else if (whatsappMonitor.getStatus().connected) {
    res.json({ qr: null, status: 'connected' });
  } else {
    // Tenta solicitar novo QR Code se não tem um e não está conectado
    try {
      await whatsappMonitor.requestQR();
      var newQR = whatsappMonitor.getQR();
      if (newQR) {
        res.json({ qr: newQR, status: 'waiting_scan' });
      } else {
        res.json({ qr: null, status: 'initializing', error: whatsappMonitor.getStatus().error });
      }
    } catch (err) {
      res.json({ qr: null, status: 'initializing', error: err.message });
    }
  }
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
    res.json({ success: true, message: 'WhatsApp reiniciado. Use QR Code ou Pairing Code para conectar.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Conectar WhatsApp pelo número de telefone (Pairing Code)
app.post('/api/whatsapp/pair', authMiddleware, async function(req, res) {
  try {
    var phone = req.body.phone;
    if (!phone) {
      return res.status(400).json({ error: 'Número de telefone é obrigatório' });
    }
    var code = await whatsappMonitor.requestPairingCode(phone);
    res.json({ success: true, code: code, message: 'Código gerado! Abra WhatsApp > Aparelhos Conectados > Conectar com Número de Telefone e digite o código.' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Desconectar WhatsApp (sem limpar sessão)
app.post('/api/whatsapp/disconnect', authMiddleware, async function(req, res) {
  try {
    await whatsappMonitor.disconnect();
    res.json({ success: true, message: 'WhatsApp desconectado' });
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
    // Merge with existing settings
    var current = await pool.query("SELECT value FROM settings WHERE key='general'");
    var existing = current.rows.length > 0 ? current.rows[0].value : {};
    var merged = Object.assign({}, existing, req.body);
    await pool.query(
      "INSERT INTO settings (key, value, updated_at) VALUES ('general', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()",
      [JSON.stringify(merged)]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings/meta', authMiddleware, async function(req, res) {
  try {
    var meta = req.body;
    var current = await pool.query("SELECT value FROM settings WHERE key='general'");
    var settings = current.rows.length > 0 ? current.rows[0].value : {};
    settings.meta = meta;
    await pool.query(
      "INSERT INTO settings (key, value, updated_at) VALUES ('general', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()",
      [JSON.stringify(settings)]
    );
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
    res.json(result.rows.map(mapUser));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users/:uid', authMiddleware, async function(req, res) {
  try {
    var result = await pool.query('SELECT * FROM users WHERE uid=$1', [req.params.uid]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado' });
    res.json(mapUser(result.rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login user (auto-create only if no users exist yet, otherwise must be pre-registered)
app.post('/api/users/login', authMiddleware, async function(req, res) {
  try {
    var b = req.body;
    var uid = req.user.uid;
    var email = b.email || req.user.email || '';

    // Check if user already exists
    var existing = await pool.query('SELECT * FROM users WHERE uid=$1', [uid]);
    if (existing.rows.length > 0) {
      // Existing user - update last login
      var result = await pool.query(
        'UPDATE users SET email=$2, display_name=$3, last_login=NOW() WHERE uid=$1 RETURNING *',
        [uid, email, b.displayName || '']
      );
      return res.json(mapUser(result.rows[0]));
    }

    // New user - only allow if no users exist yet (first user bootstrap)
    var userCount = await pool.query('SELECT COUNT(*) as cnt FROM users');
    if (parseInt(userCount.rows[0].cnt) > 0) {
      return res.status(403).json({ error: 'Registro não autorizado. Peça ao administrador para cadastrar seu acesso.' });
    }

    // First user ever - auto-create as superadmin
    var result = await pool.query(
      `INSERT INTO users (uid, email, display_name, role, last_login)
       VALUES ($1, $2, $3, 'superadmin', NOW()) RETURNING *`,
      [uid, email, b.displayName || '']
    );
    res.json(mapUser(result.rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pre-register a new user (superadmin only)
app.post('/api/users', authMiddleware, async function(req, res) {
  try {
    var callerR = await pool.query('SELECT role FROM users WHERE uid=$1', [req.user.uid]);
    if (callerR.rows.length === 0 || callerR.rows[0].role !== 'superadmin') {
      return res.status(403).json({ error: 'Apenas Super Admin pode cadastrar usuários' });
    }
    var b = req.body;
    if (!b.uid || !b.email) {
      return res.status(400).json({ error: 'uid e email são obrigatórios' });
    }
    var result = await pool.query(
      `INSERT INTO users (uid, email, display_name, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (uid) DO NOTHING
       RETURNING *`,
      [b.uid, b.email, b.displayName || '', b.role || 'admin']
    );
    if (result.rows.length === 0) {
      return res.status(409).json({ error: 'Usuário já existe' });
    }
    res.json(mapUser(result.rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update user role
app.put('/api/users/:uid', authMiddleware, async function(req, res) {
  try {
    var callerR = await pool.query('SELECT role FROM users WHERE uid=$1', [req.user.uid]);
    if (callerR.rows.length === 0 || callerR.rows[0].role !== 'superadmin') {
      return res.status(403).json({ error: 'Apenas Super Admin' });
    }
    var b = req.body;
    var fields = [];
    var values = [];
    var idx = 1;
    if (b.role !== undefined) { fields.push('role=$' + idx); values.push(b.role); idx++; }
    if (b.displayName !== undefined) { fields.push('display_name=$' + idx); values.push(b.displayName); idx++; }
    if (fields.length > 0) {
      values.push(req.params.uid);
      await pool.query('UPDATE users SET ' + fields.join(',') + ' WHERE uid=$' + idx, values);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Self-promote to superadmin (only if no superadmin exists)
app.post('/api/users/promote', authMiddleware, async function(req, res) {
  try {
    var existing = await pool.query("SELECT uid FROM users WHERE role='superadmin' LIMIT 1");
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Já existe um Super Admin' });
    }
    await pool.query('UPDATE users SET role=$1 WHERE uid=$2', ['superadmin', req.user.uid]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check if superadmin exists
app.get('/api/users/check-superadmin', authMiddleware, async function(req, res) {
  try {
    var result = await pool.query("SELECT uid FROM users WHERE role='superadmin' LIMIT 1");
    res.json({ exists: result.rows.length > 0 });
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

// ===== ANALYTICS ENDPOINTS =====

// Executive summary - all key metrics in one call
app.get('/api/analytics/summary', authMiddleware, async function(req, res) {
  try {
    var days = validateDays(req.query.days, 1);
    var dateFilter = buildDateFilter(req.query, 1);

    var [clicksR, eventsR, groupsR, metaR, metaSpendR] = await Promise.all([
      pool.query("SELECT COUNT(*) as total FROM clicks WHERE " + dateFilter),
      pool.query("SELECT action, COUNT(*) as cnt FROM member_events WHERE " + dateFilter + " GROUP BY action"),
      pool.query('SELECT COALESCE(SUM(current_members),0) as total, COUNT(*) as cnt FROM whatsapp_groups'),
      pool.query('SELECT COALESCE(SUM(clicks),0) as clicks, COALESCE(SUM(impressions),0) as impressions, COALESCE(SUM(conversions),0) as conversions FROM meta_campaigns'),
      pool.query('SELECT COALESCE(SUM(spend),0) as spend FROM meta_campaigns')
    ]);

    var clicks = parseInt(clicksR.rows[0].total);
    var joins = 0, leaves = 0;
    eventsR.rows.forEach(function(r) {
      if (r.action === 'join') joins = parseInt(r.cnt);
      else leaves = parseInt(r.cnt);
    });
    var totalMembers = parseInt(groupsR.rows[0].total);
    var totalGroups = parseInt(groupsR.rows[0].cnt);
    var retained = Math.max(0, joins - leaves);
    var metaClicks = parseInt(metaR.rows[0].clicks);
    var metaImpressions = parseInt(metaR.rows[0].impressions);
    var metaConversions = parseInt(metaR.rows[0].conversions);
    var metaSpend = parseFloat(metaSpendR.rows[0].spend); // USD

    // Métricas calculadas corretamente
    var convRate = clicks > 0 ? ((joins / clicks) * 100).toFixed(1) : '0';
    var retentionRate = joins > 0 ? ((retained / joins) * 100).toFixed(1) : '0';
    var exitRate = joins > 0 ? ((leaves / joins) * 100).toFixed(1) : '0';
    var flightRate = clicks > 0 ? (((clicks - joins) / clicks) * 100).toFixed(1) : '0';

    // CPC e CPM calculados a partir dos totais (em USD)
    var metaCPC = metaClicks > 0 ? metaSpend / metaClicks : 0;
    var metaCPM = metaImpressions > 0 ? (metaSpend / metaImpressions) * 1000 : 0;
    var metaCTR = metaImpressions > 0 ? (metaClicks / metaImpressions) * 100 : 0;
    var metaCPL = metaConversions > 0 ? metaSpend / metaConversions : 0;

    res.json({
      period: days === 1 ? 'today' : days + 'd',
      clicks: clicks, joins: joins, leaves: leaves, retained: retained,
      totalMembers: totalMembers, totalGroups: totalGroups,
      metaClicks: metaClicks, metaImpressions: metaImpressions,
      metaConversions: metaConversions,
      metaSpendUSD: metaSpend,       // USD - converter no frontend
      metaCPC_USD: metaCPC,           // USD - converter no frontend
      metaCPM_USD: metaCPM,           // USD - converter no frontend
      metaCTR: metaCTR,               // % - não converter
      metaCPL_USD: metaCPL,           // USD - converter no frontend
      conversionRate: parseFloat(convRate), retentionRate: parseFloat(retentionRate),
      exitRate: parseFloat(exitRate), flightRate: parseFloat(flightRate),
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Heatmap: hourly distribution of clicks and member events
app.get('/api/analytics/heatmap', authMiddleware, async function(req, res) {
  try {
    var days = validateDays(req.query.days, 7);

    var [clicksR, eventsR] = await Promise.all([
      pool.query(
        "SELECT EXTRACT(HOUR FROM timestamp AT TIME ZONE 'America/Sao_Paulo') as hour, EXTRACT(DOW FROM timestamp AT TIME ZONE 'America/Sao_Paulo') as dow, COUNT(*) as cnt FROM clicks WHERE timestamp >= NOW() - ($1 * INTERVAL '1 day') GROUP BY hour, dow ORDER BY dow, hour",
        [days]
      ),
      pool.query(
        "SELECT EXTRACT(HOUR FROM timestamp AT TIME ZONE 'America/Sao_Paulo') as hour, EXTRACT(DOW FROM timestamp AT TIME ZONE 'America/Sao_Paulo') as dow, action, COUNT(*) as cnt FROM member_events WHERE timestamp >= NOW() - ($1 * INTERVAL '1 day') GROUP BY hour, dow, action ORDER BY dow, hour",
        [days]
      )
    ]);

    // Build 7x24 matrices (dow 0=Sun, 6=Sat)
    var clicksMatrix = Array.from({length: 7}, function() { return new Array(24).fill(0); });
    var joinsMatrix = Array.from({length: 7}, function() { return new Array(24).fill(0); });
    var leavesMatrix = Array.from({length: 7}, function() { return new Array(24).fill(0); });

    clicksR.rows.forEach(function(r) {
      clicksMatrix[parseInt(r.dow)][parseInt(r.hour)] = parseInt(r.cnt);
    });
    eventsR.rows.forEach(function(r) {
      var dow = parseInt(r.dow), hour = parseInt(r.hour);
      if (r.action === 'join') joinsMatrix[dow][hour] = parseInt(r.cnt);
      else leavesMatrix[dow][hour] = parseInt(r.cnt);
    });

    // Also build hourly totals
    var clicksHourly = new Array(24).fill(0);
    var joinsHourly = new Array(24).fill(0);
    var leavesHourly = new Array(24).fill(0);
    for (var d = 0; d < 7; d++) {
      for (var h = 0; h < 24; h++) {
        clicksHourly[h] += clicksMatrix[d][h];
        joinsHourly[h] += joinsMatrix[d][h];
        leavesHourly[h] += leavesMatrix[d][h];
      }
    }

    res.json({
      days: days,
      clicksMatrix: clicksMatrix, joinsMatrix: joinsMatrix, leavesMatrix: leavesMatrix,
      clicksHourly: clicksHourly, joinsHourly: joinsHourly, leavesHourly: leavesHourly
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Attribution: which campaigns bring members that stay
app.get('/api/analytics/attribution', authMiddleware, async function(req, res) {
  try {
    var days = validateDays(req.query.days, 30);

    // Get clicks grouped by campaign
    var clicksR = await pool.query(
      "SELECT campaign_id, COUNT(*) as clicks FROM clicks WHERE campaign_id IS NOT NULL AND timestamp >= NOW() - ($1 * INTERVAL '1 day') GROUP BY campaign_id",
      [days]
    );

    // Get member events for correlation
    var eventsR = await pool.query(
      "SELECT whatsapp_group_id, action, COUNT(*) as cnt FROM member_events WHERE timestamp >= NOW() - ($1 * INTERVAL '1 day') GROUP BY whatsapp_group_id, action",
      [days]
    );

    // Get links to map campaign → whatsapp group
    var linksR = await pool.query(
      'SELECT campaign_id, whatsapp_group_id FROM links WHERE campaign_id IS NOT NULL AND whatsapp_group_id IS NOT NULL'
    );

    // Get meta spend per campaign
    var metaR = await pool.query('SELECT id, name, spend, clicks as meta_clicks, conversions FROM meta_campaigns');

    // Build campaign → groups mapping
    var campToGroups = {};
    linksR.rows.forEach(function(l) {
      if (!campToGroups[l.campaign_id]) campToGroups[l.campaign_id] = [];
      if (l.whatsapp_group_id && campToGroups[l.campaign_id].indexOf(l.whatsapp_group_id) === -1) {
        campToGroups[l.campaign_id].push(l.whatsapp_group_id);
      }
    });

    // Build group → events mapping
    var groupEvents = {};
    eventsR.rows.forEach(function(r) {
      if (!groupEvents[r.whatsapp_group_id]) groupEvents[r.whatsapp_group_id] = { joins: 0, leaves: 0 };
      if (r.action === 'join') groupEvents[r.whatsapp_group_id].joins = parseInt(r.cnt);
      else groupEvents[r.whatsapp_group_id].leaves = parseInt(r.cnt);
    });

    // Build meta campaign lookup
    var metaLookup = {};
    metaR.rows.forEach(function(m) {
      metaLookup[m.id] = { name: m.name, spend: parseFloat(m.spend), metaClicks: m.meta_clicks, conversions: m.conversions };
    });

    // Build clicks lookup
    var clicksLookup = {};
    clicksR.rows.forEach(function(c) {
      clicksLookup[c.campaign_id] = parseInt(c.clicks);
    });

    // Get all campaign names
    var campNamesR = await pool.query('SELECT id, name FROM campaigns');
    var campNames = {};
    campNamesR.rows.forEach(function(c) { campNames[c.id] = c.name; });

    // Build attribution data
    var attribution = [];
    var allCampIds = Object.keys(campToGroups);
    allCampIds.forEach(function(campId) {
      var groups = campToGroups[campId];
      var totalJoins = 0, totalLeaves = 0;
      groups.forEach(function(gid) {
        if (groupEvents[gid]) {
          totalJoins += groupEvents[gid].joins;
          totalLeaves += groupEvents[gid].leaves;
        }
      });
      var retained = Math.max(0, totalJoins - totalLeaves);
      var retentionRate = totalJoins > 0 ? Math.round((retained / totalJoins) * 100) : 0;
      var clicks = clicksLookup[campId] || 0;
      var meta = metaLookup[campId] || {};
      var spend = meta.spend || 0;
      var costPerRetained = retained > 0 && spend > 0 ? spend / retained : 0;

      attribution.push({
        campaignId: campId,
        campaignName: campNames[campId] || meta.name || campId,
        clicks: clicks,
        metaClicks: meta.metaClicks || 0,
        spendUSD: spend,
        joins: totalJoins,
        leaves: totalLeaves,
        retained: retained,
        retentionRate: retentionRate,
        costPerRetainedUSD: parseFloat(costPerRetained.toFixed(4)),
        groups: groups.length
      });
    });

    // Sort by retention rate descending
    attribution.sort(function(a, b) { return b.retentionRate - a.retentionRate; });

    res.json({ days: days, attribution: attribution });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Smart alerts check
app.get('/api/analytics/smart-alerts', authMiddleware, async function(req, res) {
  try {
    var alerts = [];

    // 1. Campaigns spending without conversions (last 6h)
    var metaR = await pool.query('SELECT id, name, spend, conversions, status FROM meta_campaigns WHERE status = $1', ['ACTIVE']);
    metaR.rows.forEach(function(c) {
      if (parseFloat(c.spend) > 0 && parseInt(c.conversions) === 0) {
        alerts.push({
          type: 'no_conversion',
          severity: 'warning',
          title: 'Campanha sem conversão',
          message: c.name + ' gastou $' + parseFloat(c.spend).toFixed(2) + ' sem nenhuma conversão',
          campaignId: c.id, campaignName: c.name
        });
      }
    });

    // 2. High exit rate groups (>30% leave rate today)
    var eventsR = await pool.query(
      "SELECT whatsapp_group_id, group_name, action, COUNT(*) as cnt FROM member_events WHERE timestamp >= CURRENT_DATE GROUP BY whatsapp_group_id, group_name, action"
    );
    var groupStats = {};
    eventsR.rows.forEach(function(r) {
      var gid = r.whatsapp_group_id;
      if (!groupStats[gid]) groupStats[gid] = { name: r.group_name || gid, joins: 0, leaves: 0 };
      if (r.action === 'join') groupStats[gid].joins = parseInt(r.cnt);
      else groupStats[gid].leaves = parseInt(r.cnt);
    });
    Object.keys(groupStats).forEach(function(gid) {
      var g = groupStats[gid];
      if (g.joins >= 3 && g.leaves > 0) {
        var exitRate = (g.leaves / g.joins) * 100;
        if (exitRate > 30) {
          alerts.push({
            type: 'high_exit_rate',
            severity: exitRate > 60 ? 'danger' : 'warning',
            title: 'Alta taxa de saída',
            message: g.name + ': ' + Math.round(exitRate) + '% dos membros saíram (' + g.leaves + '/' + g.joins + ')',
            groupId: gid, groupName: g.name
          });
        }
      }
    });

    // 3. High CPC campaigns (CPC > 2x average)
    // CPC está em USD no banco - recalcula a partir de spend/clicks para precisão
    var activeMeta = metaR.rows.filter(function(c) { return parseFloat(c.spend) > 0; });
    if (activeMeta.length > 1) {
      var cpcs = [];
      var metaDetailsR = await pool.query('SELECT id, name, cpc, spend, clicks FROM meta_campaigns WHERE spend > 0 AND clicks > 0');
      metaDetailsR.rows.forEach(function(c) {
        // Recalcula CPC para garantir precisão: spend / clicks (ambos em USD)
        var realCpc = parseFloat(c.spend) / parseInt(c.clicks);
        cpcs.push({ id: c.id, name: c.name, cpc: realCpc });
      });
      if (cpcs.length > 1) {
        var avgCpc = cpcs.reduce(function(s, c) { return s + c.cpc; }, 0) / cpcs.length;
        cpcs.forEach(function(c) {
          if (c.cpc > avgCpc * 2 && c.cpc > 0) {
            alerts.push({
              type: 'high_cpc',
              severity: 'info',
              title: 'CPC elevado',
              message: c.name + ': CPC $' + c.cpc.toFixed(2) + ' USD (média $' + avgCpc.toFixed(2) + ' USD)',
              campaignId: c.id, campaignName: c.name,
              cpcUSD: c.cpc, avgCpcUSD: avgCpc
            });
          }
        });
      }
    }

    // 4. Links near full
    var linksR = await pool.query('SELECT name, current_clicks, max_vacancies FROM links WHERE is_active=true AND is_full=false');
    linksR.rows.forEach(function(l) {
      var pct = (l.current_clicks / (l.max_vacancies || 1)) * 100;
      if (pct >= 85) {
        alerts.push({
          type: 'link_near_full',
          severity: pct >= 95 ? 'danger' : 'warning',
          title: 'Grupo quase cheio',
          message: l.name + ': ' + Math.round(pct) + '% ocupado (' + l.current_clicks + '/' + l.max_vacancies + ')',
          linkName: l.name
        });
      }
    });

    // 5. Links with health issues (only show truly broken or deactivated links)
    var unhealthyLinksR = await pool.query("SELECT name, health_check_failures, deactivated_reason FROM links WHERE health_check_failures >= 3 OR (deactivated_reason IS NOT NULL AND deactivated_reason != '')");
    unhealthyLinksR.rows.forEach(function(l) {
      alerts.push({
        type: 'link_health',
        severity: 'danger',
        title: 'Link com problema',
        message: l.name + (l.deactivated_reason ? ' - ' + l.deactivated_reason : ' - ' + l.health_check_failures + ' falhas consecutivas detectadas'),
        linkName: l.name
      });
    });

    // Sort: danger first, then warning, then info
    var severityOrder = { danger: 0, warning: 1, info: 2 };
    alerts.sort(function(a, b) { return (severityOrder[a.severity] || 3) - (severityOrder[b.severity] || 3); });

    res.json({ alerts: alerts, count: alerts.length, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Analytics extras: referrer, OS, city breakdown
app.get('/api/analytics/breakdown', authMiddleware, async function(req, res) {
  try {
    var days = validateDays(req.query.days, 7);
    var [refR, osR, cityR, browserR] = await Promise.all([
      pool.query("SELECT referrer, COUNT(*) as cnt FROM clicks WHERE timestamp >= NOW() - ($1 * INTERVAL '1 day') AND referrer IS NOT NULL AND referrer != '' GROUP BY referrer ORDER BY cnt DESC LIMIT 20", [days]),
      pool.query("SELECT os, COUNT(*) as cnt FROM clicks WHERE timestamp >= NOW() - ($1 * INTERVAL '1 day') AND os IS NOT NULL AND os != '' GROUP BY os ORDER BY cnt DESC LIMIT 10", [days]),
      pool.query("SELECT city, COUNT(*) as cnt FROM clicks WHERE timestamp >= NOW() - ($1 * INTERVAL '1 day') AND city IS NOT NULL AND city != '' GROUP BY city ORDER BY cnt DESC LIMIT 20", [days]),
      pool.query("SELECT browser, COUNT(*) as cnt FROM clicks WHERE timestamp >= NOW() - ($1 * INTERVAL '1 day') AND browser IS NOT NULL AND browser != '' GROUP BY browser ORDER BY cnt DESC LIMIT 10", [days])
    ]);

    res.json({
      days: days,
      referrers: refR.rows.map(function(r) { return { name: r.referrer, count: parseInt(r.cnt) }; }),
      os: osR.rows.map(function(r) { return { name: r.os, count: parseInt(r.cnt) }; }),
      cities: cityR.rows.map(function(r) { return { name: r.city, count: parseInt(r.cnt) }; }),
      browsers: browserR.rows.map(function(r) { return { name: r.browser, count: parseInt(r.cnt) }; })
    });
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

/**
 * Sincroniza dados do Meta Ads para o banco de dados local.
 * NOTA: Todos os valores monetários (spend, cpc, cpm, cost_per_result) são
 * armazenados em USD (moeda da conta Meta). A conversão para BRL é feita
 * apenas no frontend usando a cotação atual do dólar.
 */
async function syncMetaToDB() {
  try {
    var campaigns = await metaApi.getCampaigns();
    if (!campaigns || !campaigns.data) return;

    for (var camp of campaigns.data) {
      try {
        var insights = await metaApi.getCampaignInsights(camp.id, 'today');
        var d = insights && insights.data && insights.data[0] ? insights.data[0] : {};
        var normalized = metaApi.normalizeInsight(d);

        await pool.query(
          `INSERT INTO meta_campaigns (id, name, status, objective, daily_budget, spend, impressions, clicks, cpc, cpm, ctr, reach, conversions, cost_per_result, last_synced)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
           ON CONFLICT (id) DO UPDATE SET name=$2, status=$3, objective=$4, daily_budget=$5, spend=$6, impressions=$7, clicks=$8, cpc=$9, cpm=$10, ctr=$11, reach=$12, conversions=$13, cost_per_result=$14, last_synced=NOW()`,
          [
            camp.id, camp.name, camp.effective_status || camp.status, camp.objective,
            camp.daily_budget ? parseFloat(camp.daily_budget) / 100 : 0, // centavos → USD
            normalized.spend,        // USD
            normalized.impressions,
            normalized.clicks,
            normalized.cpc,          // USD (spend / clicks)
            normalized.cpm,          // USD (spend / impressions * 1000)
            normalized.ctr,          // % (clicks / impressions * 100)
            normalized.reach,
            normalized.conversions,
            normalized.costPerResult  // USD
          ]
        );
      } catch (campErr) {
        // Não falha toda a sync por causa de uma campanha
        console.error('[META] Erro sincronizando campanha ' + camp.name + ':', campErr.message);
      }
    }
    console.log('[META] Sincronizados ' + campaigns.data.length + ' campanhas');
  } catch (err) {
    console.error('[META] Erro na sincronização:', err.message);
  }
}

// Auto-sync Meta every 5 minutes
setInterval(syncMetaToDB, 5 * 60 * 1000);

// ===== HEALTH CHECK SYSTEM =====

var lastHealthCheck = { timestamp: null, results: [], summary: {}, running: false };

function extractInviteCode(url) {
  if (!url) return null;
  var match = url.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

async function runHealthCheck() {
  if (lastHealthCheck.running) {
    console.log('[HEALTH] Varredura já em andamento, ignorando...');
    return lastHealthCheck;
  }

  lastHealthCheck.running = true;
  console.log('[HEALTH] Iniciando varredura de saúde dos links e grupos...');

  var results = [];
  var summary = { total: 0, healthy: 0, warning: 0, broken: 0 };

  try {
    // 1. Check all active links
    var linksR = await pool.query('SELECT * FROM links WHERE is_active=true');
    summary.total = linksR.rows.length;

    var whatsappReady = whatsappMonitor.getStatus().ready;

    for (var link of linksR.rows) {
      var result = { type: 'link', linkId: link.id, linkName: link.name, url: link.url, status: 'healthy', issues: [] };

      // a) Check linked WhatsApp group exists (do this FIRST for cross-check)
      var groupConfirmedActive = false;
      if (link.whatsapp_group_id && whatsappReady) {
        var groupCheck = await whatsappMonitor.checkGroupExists(link.whatsapp_group_id);
        if (groupCheck !== null) {
          if (groupCheck.exists) {
            groupConfirmedActive = true;
          } else {
            result.status = 'broken';
            result.issues.push('Grupo vinculado não encontrado no WhatsApp');
          }
        }
      }

      // b) Check WhatsApp invite link via client
      var inviteCode = extractInviteCode(link.url);
      if (inviteCode && whatsappReady) {
        var inviteCheck = await whatsappMonitor.checkInviteCode(inviteCode);
        if (inviteCheck !== null && !inviteCheck.valid) {
          if (inviteCheck.definitive) {
            // Definitively invalid invite code
            result.status = 'broken';
            result.issues.push('Link de convite inválido ou expirado');
          } else if (!groupConfirmedActive) {
            // Inconclusive invite check AND group not confirmed active = warning only
            result.status = 'warning';
            result.issues.push('Não foi possível verificar link de convite (erro temporário)');
          }
          // If group is confirmed active, ignore inconclusive invite check (false positive)
        }
      } else if (inviteCode && !whatsappReady) {
        // Fallback: HTTP check (only for definitive failures)
        try {
          var resp = await fetch('https://chat.whatsapp.com/' + inviteCode, {
            method: 'GET',
            redirect: 'follow',
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LinkRotatorBot/1.0)' }
          });
          var body = await resp.text();
          if (resp.status === 404 || body.includes('invite_link_revoke') || body.includes('"invite_link_is_revoked":true')) {
            result.status = 'broken';
            result.issues.push('Link de convite revogado ou grupo banido');
          }
          // Removed the overly broad og:title check that caused false positives
        } catch (err) {
          // Network errors are inconclusive, don't mark as warning
          console.log('[HEALTH] Erro HTTP ao verificar ' + link.name + ': ' + err.message);
        }
      }

      // c) Check accumulated health_check_failures (only if already broken from checks above)
      if (link.health_check_failures >= 3) {
        result.status = 'broken';
        result.issues.push(link.health_check_failures + ' falhas consecutivas detectadas');
      }

      // Update counters
      summary[result.status]++;

      // Create alert and update DB for broken links
      if (result.status === 'broken') {
        var recentAlert = await pool.query(
          "SELECT id FROM alerts WHERE type='link_health' AND link_name=$1 AND timestamp >= NOW() - INTERVAL '6 hours' LIMIT 1",
          [link.name]
        );
        if (recentAlert.rows.length === 0) {
          var campName = '';
          if (link.campaign_id) {
            var cn = await pool.query('SELECT name FROM campaigns WHERE id=$1', [link.campaign_id]);
            if (cn.rows.length > 0) campName = cn.rows[0].name;
          }
          await pool.query(
            'INSERT INTO alerts (type, link_name, campaign_name, message, read) VALUES ($1,$2,$3,$4,false)',
            ['link_health', link.name, campName, 'Link com problema detectado: ' + result.issues.join('; ')]
          );

          // Increment health check failures
          await pool.query(
            'UPDATE links SET health_check_failures = health_check_failures + 1, updated_at = NOW() WHERE id=$1',
            [link.id]
          );

          // Auto-deactivate if 3+ failures
          if ((link.health_check_failures || 0) + 1 >= 3) {
            await pool.query(
              "UPDATE links SET is_active=false, deactivated_reason='Desativado automaticamente - link quebrado ou grupo banido (health check)', deactivated_at=NOW() WHERE id=$1",
              [link.id]
            );
            result.autoDeactivated = true;
          }
        }
      } else if ((result.status === 'healthy' || result.status === 'warning') && link.health_check_failures > 0) {
        // Link recovered or only warning - reset failures
        await pool.query('UPDATE links SET health_check_failures=0, updated_at=NOW() WHERE id=$1', [link.id]);
      }

      results.push(result);

      // Small delay to avoid rate limiting
      await new Promise(function(resolve) { setTimeout(resolve, 500); });
    }

    // 2. Check for disappeared groups (banned)
    if (whatsappReady) {
      var liveGroupIds = await whatsappMonitor.getLiveGroupIds();
      if (liveGroupIds) {
        var dbGroupsR = await pool.query('SELECT id, group_name, current_members FROM whatsapp_groups');

        for (var dbGroup of dbGroupsR.rows) {
          if (liveGroupIds.indexOf(dbGroup.id) === -1) {
            // Group disappeared from WhatsApp
            results.push({
              type: 'group', groupId: dbGroup.id, groupName: dbGroup.group_name,
              status: 'broken', issues: ['Grupo não encontrado no WhatsApp - possível banimento']
            });
            summary.broken++;

            // Create alert if not recent
            var recentGrpAlert = await pool.query(
              "SELECT id FROM alerts WHERE type='group_banned' AND whatsapp_group_id=$1 AND timestamp >= NOW() - INTERVAL '24 hours' LIMIT 1",
              [dbGroup.id]
            );
            if (recentGrpAlert.rows.length === 0) {
              await pool.query(
                'INSERT INTO alerts (type, whatsapp_group_id, group_name, message, read) VALUES ($1,$2,$3,$4,false)',
                ['group_banned', dbGroup.id, dbGroup.group_name, 'Grupo possivelmente banido: ' + dbGroup.group_name + ' - não encontrado no WhatsApp']
              );

              // Deactivate all links linked to this group
              await pool.query(
                "UPDATE links SET is_active=false, deactivated_reason='Grupo banido/removido do WhatsApp', deactivated_at=NOW() WHERE whatsapp_group_id=$1 AND is_active=true",
                [dbGroup.id]
              );
            }
          } else {
            // 3. Check for sudden member drops (>50% drop)
            var liveGroups = await whatsappMonitor.getGroups();
            var liveGroup = liveGroups.find(function(g) { return g.id === dbGroup.id; });
            var liveMembers = liveGroup ? (liveGroup.participants || liveGroup.currentMembers || 0) : 0;
            var dbMembers = dbGroup.current_members || 0;

            if (dbMembers > 10 && liveMembers > 0 && liveMembers < dbMembers * 0.5) {
              results.push({
                type: 'group', groupId: dbGroup.id, groupName: dbGroup.group_name,
                status: 'warning', issues: ['Queda brusca de membros: ' + dbMembers + ' → ' + liveMembers + ' (-' + Math.round((1 - liveMembers / dbMembers) * 100) + '%)']
              });
              summary.warning++;

              var recentDropAlert = await pool.query(
                "SELECT id FROM alerts WHERE type='member_drop' AND whatsapp_group_id=$1 AND timestamp >= NOW() - INTERVAL '6 hours' LIMIT 1",
                [dbGroup.id]
              );
              if (recentDropAlert.rows.length === 0) {
                await pool.query(
                  'INSERT INTO alerts (type, whatsapp_group_id, group_name, message, read) VALUES ($1,$2,$3,$4,false)',
                  ['member_drop', dbGroup.id, dbGroup.group_name, 'Queda brusca de membros em ' + dbGroup.group_name + ': ' + dbMembers + ' → ' + liveMembers]
                );
              }
            }
          }
        }
      }
    }

    // 3. Also check inactive links that were auto-deactivated
    var deactivatedR = await pool.query("SELECT COUNT(*) as cnt FROM links WHERE is_active=false AND deactivated_reason IS NOT NULL");
    summary.deactivated = parseInt(deactivatedR.rows[0].cnt);

    lastHealthCheck = { timestamp: new Date().toISOString(), results: results, summary: summary, running: false };
    console.log('[HEALTH] Varredura concluída: ' + summary.healthy + ' OK, ' + summary.warning + ' avisos, ' + summary.broken + ' problemas');

  } catch (err) {
    console.error('[HEALTH] Erro na varredura:', err.message);
    lastHealthCheck = { timestamp: new Date().toISOString(), results: results, summary: summary, error: err.message, running: false };
  }

  return lastHealthCheck;
}

// Health check endpoints
app.post('/api/health-check/run', authMiddleware, async function(req, res) {
  try {
    var result = await runHealthCheck();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health-check/status', authMiddleware, async function(req, res) {
  res.json(lastHealthCheck);
});

// Reactivate a link that was auto-deactivated
app.post('/api/links/:id/reactivate', authMiddleware, async function(req, res) {
  try {
    await pool.query(
      'UPDATE links SET is_active=true, health_check_failures=0, deactivated_reason=NULL, deactivated_at=NULL, updated_at=NOW() WHERE id=$1',
      [req.params.id]
    );
    invalidateRotateCache();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== AUTO-PAUSE: Monitor group capacity =====

var autoPauseInterval = null;

async function checkAutoCapacity() {
  try {
    // Get all active links with auto_pause enabled
    var linksR = await pool.query(
      "SELECT l.id, l.name, l.whatsapp_group_id, l.is_active, l.auto_pause_enabled, l.auto_pause_threshold, l.auto_reactivate_below, l.max_vacancies, " +
      "g.current_members, g.max_members, g.group_name " +
      "FROM links l LEFT JOIN whatsapp_groups g ON l.whatsapp_group_id = g.id " +
      "WHERE l.auto_pause_enabled = true AND l.whatsapp_group_id IS NOT NULL"
    );

    for (var link of linksR.rows) {
      var members = link.current_members || 0;
      var maxMembers = link.max_members || 1024;
      var threshold = link.auto_pause_threshold || 90;
      var reactivateBelow = link.auto_reactivate_below || 500;
      var capacityPercent = Math.round((members / maxMembers) * 100);

      if (link.is_active && capacityPercent >= threshold) {
        // Pause: group at or above capacity threshold
        await pool.query(
          "UPDATE links SET is_active=false, is_full=true, deactivated_reason=$1, deactivated_at=NOW(), updated_at=NOW() WHERE id=$2",
          ['Auto-pause: grupo ' + (link.group_name || '') + ' atingiu ' + capacityPercent + '% da capacidade (' + members + '/' + maxMembers + ')', link.id]
        );
        invalidateRotateCache();
        console.log('[AUTO-PAUSE] Link ' + link.name + ' pausado - grupo com ' + capacityPercent + '% capacidade');

        // Create alert
        await pool.query(
          "INSERT INTO alerts (type, link_name, group_name, message, read) VALUES ($1,$2,$3,$4,false)",
          ['link_health', link.name, link.group_name || '', 'Link pausado automaticamente: grupo atingiu ' + capacityPercent + '% da capacidade']
        );
      } else if (!link.is_active && link.deactivated_reason && link.deactivated_reason.startsWith('Auto-pause:') && members <= reactivateBelow) {
        // Reactivate: group dropped below reactivation threshold
        await pool.query(
          "UPDATE links SET is_active=true, is_full=false, deactivated_reason=NULL, deactivated_at=NULL, updated_at=NOW() WHERE id=$1",
          [link.id]
        );
        invalidateRotateCache();
        console.log('[AUTO-PAUSE] Link ' + link.name + ' reativado - grupo caiu para ' + members + ' membros');
      }
    }
  } catch (err) {
    console.error('[AUTO-PAUSE] Erro:', err.message);
  }
}

// Check capacity every 5 minutes
autoPauseInterval = setInterval(checkAutoCapacity, 5 * 60 * 1000);

// API: Toggle auto-pause per link
app.put('/api/links/:id/auto-pause', authMiddleware, async function(req, res) {
  try {
    var enabled = req.body.enabled !== undefined ? req.body.enabled : true;
    var threshold = req.body.threshold || 90;
    var reactivateBelow = req.body.reactivateBelow || 500;
    await pool.query(
      'UPDATE links SET auto_pause_enabled=$1, auto_pause_threshold=$2, auto_reactivate_below=$3, updated_at=NOW() WHERE id=$4',
      [enabled, threshold, reactivateBelow, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Global auto-pause toggle
app.post('/api/settings/auto-pause', authMiddleware, async function(req, res) {
  try {
    var enabled = req.body.enabled;
    if (enabled) {
      if (!autoPauseInterval) {
        autoPauseInterval = setInterval(checkAutoCapacity, 5 * 60 * 1000);
      }
    } else {
      if (autoPauseInterval) {
        clearInterval(autoPauseInterval);
        autoPauseInterval = null;
      }
    }
    // Save to settings
    var current = {};
    var r = await pool.query("SELECT value FROM settings WHERE key='general'");
    if (r.rows.length > 0) current = r.rows[0].value || {};
    current.autoPauseEnabled = enabled;
    await pool.query(
      "INSERT INTO settings (key, value, updated_at) VALUES ('general', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()",
      [JSON.stringify(current)]
    );
    res.json({ success: true, enabled: enabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== LEAD BACKUP SYSTEM =====

// Get leads by group with real phone numbers
app.get('/api/leads/backup', authMiddleware, async function(req, res) {
  try {
    var groupId = req.query.group_id;
    var query = 'SELECT lc.*, wg.group_name FROM lead_contacts lc LEFT JOIN whatsapp_groups wg ON lc.whatsapp_group_id = wg.id';
    var params = [];

    if (groupId) {
      query += ' WHERE lc.whatsapp_group_id = $1';
      params.push(groupId);
    }
    query += ' ORDER BY lc.joined_at DESC';

    var result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get lead summary by group
app.get('/api/leads/backup/summary', authMiddleware, async function(req, res) {
  try {
    var result = await pool.query(
      "SELECT lc.whatsapp_group_id, wg.group_name, " +
      "COUNT(*) FILTER (WHERE lc.is_active = true) as active_leads, " +
      "COUNT(*) as total_leads, " +
      "MAX(lc.joined_at) as last_join " +
      "FROM lead_contacts lc LEFT JOIN whatsapp_groups wg ON lc.whatsapp_group_id = wg.id " +
      "GROUP BY lc.whatsapp_group_id, wg.group_name ORDER BY active_leads DESC"
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download leads as CSV
app.get('/api/leads/backup/download', authMiddleware, async function(req, res) {
  try {
    var groupId = req.query.group_id;
    var query = 'SELECT lc.phone, lc.whatsapp_group_id, wg.group_name, lc.joined_at, lc.left_at, lc.is_active FROM lead_contacts lc LEFT JOIN whatsapp_groups wg ON lc.whatsapp_group_id = wg.id';
    var params = [];

    if (groupId) {
      query += ' WHERE lc.whatsapp_group_id = $1';
      params.push(groupId);
    }
    query += ' ORDER BY lc.whatsapp_group_id, lc.joined_at DESC';

    var result = await pool.query(query, params);

    var csv = 'Telefone,Grupo ID,Grupo Nome,Entrou em,Saiu em,Ativo\n';
    result.rows.forEach(function(r) {
      csv += r.phone + ',' + r.whatsapp_group_id + ',"' + (r.group_name || '') + '",' +
        (r.joined_at || '') + ',' + (r.left_at || '') + ',' + (r.is_active ? 'Sim' : 'Não') + '\n';
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="leads_backup_' + new Date().toISOString().split('T')[0] + '.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== BROADCAST SYSTEM =====

// Rate limiter for broadcasts
var broadcastRateLimiter = {
  perMinute: { count: 0, reset: Date.now() + 60000 },
  perHour: { count: 0, reset: Date.now() + 3600000 },
  perDay: { count: 0, reset: Date.now() + 86400000 },
  limits: { perMinute: 8, perHour: 80, perDay: 400 }
};

function checkBroadcastLimit() {
  var now = Date.now();
  if (now > broadcastRateLimiter.perMinute.reset) { broadcastRateLimiter.perMinute = { count: 0, reset: now + 60000 }; }
  if (now > broadcastRateLimiter.perHour.reset) { broadcastRateLimiter.perHour = { count: 0, reset: now + 3600000 }; }
  if (now > broadcastRateLimiter.perDay.reset) { broadcastRateLimiter.perDay = { count: 0, reset: now + 86400000 }; }

  if (broadcastRateLimiter.perMinute.count >= broadcastRateLimiter.limits.perMinute) return false;
  if (broadcastRateLimiter.perHour.count >= broadcastRateLimiter.limits.perHour) return false;
  if (broadcastRateLimiter.perDay.count >= broadcastRateLimiter.limits.perDay) return false;
  return true;
}

function recordBroadcastSend() {
  broadcastRateLimiter.perMinute.count++;
  broadcastRateLimiter.perHour.count++;
  broadcastRateLimiter.perDay.count++;
}

// Get broadcast rate limits status
app.get('/api/broadcast/limits', authMiddleware, function(req, res) {
  res.json({
    perMinute: { used: broadcastRateLimiter.perMinute.count, limit: broadcastRateLimiter.limits.perMinute },
    perHour: { used: broadcastRateLimiter.perHour.count, limit: broadcastRateLimiter.limits.perHour },
    perDay: { used: broadcastRateLimiter.perDay.count, limit: broadcastRateLimiter.limits.perDay }
  });
});

// Create and send broadcast
app.post('/api/broadcast/send', authMiddleware, async function(req, res) {
  try {
    var message = req.body.message;
    var targetIds = req.body.targetIds || [];
    var mentionAll = req.body.mentionAll || false;
    var targetType = req.body.targetType || 'groups';

    if (!message || message.trim() === '') {
      return res.status(400).json({ error: 'Mensagem é obrigatória' });
    }
    if (targetIds.length === 0) {
      return res.status(400).json({ error: 'Selecione pelo menos um destino' });
    }

    // Check if WhatsApp is connected
    var status = whatsappMonitor.getStatus();
    if (!status.ready) {
      return res.status(400).json({ error: 'WhatsApp não está conectado' });
    }

    // Create broadcast record
    var broadcastR = await pool.query(
      "INSERT INTO broadcast_messages (message_text, target_type, target_ids, mention_all, sent_by, status, total_targets) " +
      "VALUES ($1, $2, $3, $4, $5, 'sending', $6) RETURNING id",
      [message, targetType, targetIds, mentionAll, req.uid || 'admin', targetIds.length]
    );
    var broadcastId = broadcastR.rows[0].id;

    // Send in background
    res.json({ success: true, broadcastId: broadcastId, message: 'Disparo iniciado para ' + targetIds.length + ' destino(s)' });

    // Background send process with anti-ban delays
    (async function() {
      var sent = 0;
      var failed = 0;
      for (var i = 0; i < targetIds.length; i++) {
        var targetId = targetIds[i];

        try {
          // Check rate limit
          if (!checkBroadcastLimit()) {
            console.log('[BROADCAST] Rate limit atingido, aguardando...');
            await new Promise(function(resolve) { setTimeout(resolve, 60000); }); // Wait 1 minute
          }

          // Anti-ban: check active hours in Brazil timezone (8am - 11pm BRT)
          var brasilHour = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false }));
          if (brasilHour < 7 || brasilHour >= 23) {
            console.log('[BROADCAST] Fora do horário ativo (Brasil: ' + brasilHour + 'h), pulando...');
            await pool.query(
              "INSERT INTO broadcast_logs (broadcast_id, target_id, target_name, status, error_message) VALUES ($1,$2,$3,'skipped','Fora do horário ativo (7h-23h BRT)')",
              [broadcastId, targetId, '']
            );
            failed++;
            continue;
          }

          var sendOptions = {};

          // If mentionAll, get participants and mention them
          if (mentionAll && targetType === 'groups') {
            sendOptions.mentions = [true]; // Evolution API suporta mentionAll nativamente
          }

          await whatsappMonitor.sendMessage(targetId, message, sendOptions);
          recordBroadcastSend();
          sent++;

          await pool.query(
            "INSERT INTO broadcast_logs (broadcast_id, target_id, target_name, status, sent_at) VALUES ($1,$2,$3,'sent',NOW())",
            [broadcastId, targetId, '']
          );

          console.log('[BROADCAST] Enviado para ' + targetId + ' (' + (i + 1) + '/' + targetIds.length + ')');

          // Anti-ban: random delay between sends (3-8 seconds)
          var delay = 3000 + Math.random() * 5000;
          await new Promise(function(resolve) { setTimeout(resolve, delay); });

        } catch (err) {
          failed++;
          console.error('[BROADCAST] Erro ao enviar para ' + targetId + ':', err.message);
          await pool.query(
            "INSERT INTO broadcast_logs (broadcast_id, target_id, target_name, status, error_message) VALUES ($1,$2,$3,'failed',$4)",
            [broadcastId, targetId, '', err.message]
          );

          // If rate limited by WhatsApp, stop sending
          if (err.message && (err.message.includes('rate') || err.message.includes('too many'))) {
            console.error('[BROADCAST] Rate limited pelo WhatsApp, parando envios');
            break;
          }
        }
      }

      // Update broadcast status
      await pool.query(
        "UPDATE broadcast_messages SET status='completed', total_sent=$1, total_failed=$2, completed_at=NOW() WHERE id=$3",
        [sent, failed, broadcastId]
      );
      console.log('[BROADCAST] Concluído: ' + sent + ' enviados, ' + failed + ' falharam');
    })();

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get broadcast history
app.get('/api/broadcast/history', authMiddleware, async function(req, res) {
  try {
    var result = await pool.query('SELECT * FROM broadcast_messages ORDER BY created_at DESC LIMIT 50');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get broadcast details
app.get('/api/broadcast/:id', authMiddleware, async function(req, res) {
  try {
    var broadcast = await pool.query('SELECT * FROM broadcast_messages WHERE id=$1', [req.params.id]);
    var logs = await pool.query('SELECT * FROM broadcast_logs WHERE broadcast_id=$1 ORDER BY sent_at', [req.params.id]);
    res.json({ broadcast: broadcast.rows[0], logs: logs.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send invite to leads (re-invite to new group)
app.post('/api/broadcast/invite-leads', authMiddleware, async function(req, res) {
  try {
    var sourceGroupId = req.body.sourceGroupId;
    var targetGroupId = req.body.targetGroupId;
    var message = req.body.message || '';

    if (!sourceGroupId || !targetGroupId) {
      return res.status(400).json({ error: 'Grupo de origem e destino são obrigatórios' });
    }

    var status = whatsappMonitor.getStatus();
    if (!status.ready) {
      return res.status(400).json({ error: 'WhatsApp não está conectado' });
    }

    // Get leads from source group
    var leadsR = await pool.query(
      'SELECT phone FROM lead_contacts WHERE whatsapp_group_id=$1 AND is_active=true AND invite_sent=false',
      [sourceGroupId]
    );

    if (leadsR.rows.length === 0) {
      return res.json({ success: true, message: 'Nenhum lead disponível para convidar' });
    }

    // Get invite link for target group
    var inviteCode;
    try {
      inviteCode = await whatsappMonitor.getInviteCode(targetGroupId);
    } catch(e) {
      return res.status(400).json({ error: 'Erro ao obter link do grupo: ' + e.message });
    }
    var inviteLink = 'https://chat.whatsapp.com/' + inviteCode;

    var totalLeads = leadsR.rows.length;
    res.json({ success: true, message: 'Enviando convites para ' + totalLeads + ' leads...', totalLeads: totalLeads });

    // Background send
    (async function() {
      var sent = 0;
      for (var lead of leadsR.rows) {
        try {
          if (!checkBroadcastLimit()) {
            await new Promise(function(resolve) { setTimeout(resolve, 60000); });
          }

          var fullMessage = message ? message + '\n\n' + inviteLink : inviteLink;
          await whatsappMonitor.sendMessage(lead.phone, fullMessage);
          sent++;

          // Mark as invited
          await pool.query(
            'UPDATE lead_contacts SET invite_sent=true, invite_sent_at=NOW() WHERE phone=$1 AND whatsapp_group_id=$2',
            [lead.phone, sourceGroupId]
          );

          recordBroadcastSend();

          // Anti-ban: 5-10 second delay between DMs
          var delay = 5000 + Math.random() * 5000;
          await new Promise(function(resolve) { setTimeout(resolve, delay); });

        } catch(e) {
          console.error('[INVITE] Erro para ' + lead.phone + ':', e.message);
          if (e.message && (e.message.includes('rate') || e.message.includes('too many'))) break;
        }
      }
      console.log('[INVITE] Convites enviados: ' + sent + '/' + totalLeads);
    })();

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== SHOPEE API ENDPOINTS =====
var shopeeApi = require('./shopee-api');

// Search products
app.get('/api/shopee/products', authMiddleware, async function(req, res) {
  try {
    var result = await shopeeApi.searchProducts({
      keyword: req.query.keyword || '',
      page: parseInt(req.query.page) || 1,
      limit: parseInt(req.query.limit) || 20,
      sortType: parseInt(req.query.sort) || 1
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Top offers / best commissions
app.get('/api/shopee/top-offers', authMiddleware, async function(req, res) {
  try {
    var result = await shopeeApi.getTopOffers({
      page: parseInt(req.query.page) || 1,
      limit: parseInt(req.query.limit) || 20,
      sortType: parseInt(req.query.sort) || 5
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generate affiliate link
app.post('/api/shopee/generate-link', authMiddleware, async function(req, res) {
  try {
    var originalUrl = req.body.url;
    var subId = req.body.subId || 'whatsapp';

    if (!originalUrl) return res.status(400).json({ error: 'URL é obrigatória' });

    var result = await shopeeApi.generateAffiliateLink(originalUrl, subId);

    // Save to DB
    await pool.query(
      'INSERT INTO shopee_links (original_url, affiliate_url, sub_id, product_name, price, commission_rate) VALUES ($1,$2,$3,$4,$5,$6)',
      [originalUrl, result.shortLink, subId, req.body.productName || '', req.body.price || 0, req.body.commissionRate || 0]
    );

    res.json({ affiliateUrl: result.shortLink, subId: subId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get saved affiliate links
app.get('/api/shopee/links', authMiddleware, async function(req, res) {
  try {
    var result = await pool.query('SELECT * FROM shopee_links ORDER BY created_at DESC LIMIT 100');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get commission report
app.get('/api/shopee/commissions', authMiddleware, async function(req, res) {
  try {
    var days = validateDays(req.query.days, 30);
    var orderStatus = req.query.status || '';

    var now = Math.floor(Date.now() / 1000);
    var startTs = now - (days * 24 * 3600);

    // Try API first
    try {
      var apiOpts = { purchaseTimeStart: startTs, purchaseTimeEnd: now, limit: 100 };
      if (orderStatus) apiOpts.orderStatus = orderStatus;

      var report = await shopeeApi.getConversionReport(apiOpts);

      // Flatten nested structure for frontend and DB cache
      var flatNodes = [];
      var totalCommission = 0;
      var totalAmount = 0;
      var totalOrders = 0;

      if (report && report.nodes) {
        report.nodes.forEach(function(conv) {
          if (conv.orders) {
            conv.orders.forEach(function(order) {
              if (order.items) {
                order.items.forEach(function(item) {
                  var itemPrice = parseFloat(item.itemPrice || 0);
                  var itemCommission = parseFloat(item.itemTotalCommission || 0);
                  totalAmount += itemPrice * (parseInt(item.qty) || 1);
                  totalCommission += itemCommission;
                  totalOrders++;

                  flatNodes.push({
                    conversionId: conv.conversionId,
                    orderId: order.orderId,
                    orderStatus: order.orderStatus,
                    itemId: item.itemId,
                    itemName: item.itemName,
                    shopName: item.shopName,
                    itemPrice: itemPrice,
                    qty: item.qty,
                    commission: itemCommission,
                    totalCommission: parseFloat(conv.totalCommission || 0),
                    buyerType: conv.buyerType,
                    device: conv.device,
                    subId: conv.utmContent || '',
                    purchaseTime: conv.purchaseTime,
                    clickTime: conv.clickTime
                  });

                  // Save to DB cache
                  pool.query(
                    "INSERT INTO shopee_commissions (order_id, item_id, item_name, shop_name, order_amount, commission, commission_rate, status, sub_id, order_created_at) " +
                    "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10)) ON CONFLICT DO NOTHING",
                    [order.orderId, item.itemId, item.itemName, item.shopName, itemPrice, itemCommission, 0, order.orderStatus || 'PENDING', conv.utmContent || '', conv.purchaseTime || now]
                  ).catch(function() {});
                });
              }
            });
          }
        });
      }

      res.json({
        nodes: flatNodes,
        summary: { totalOrders: totalOrders, totalCommission: totalCommission, totalOrderAmount: totalAmount }
      });
    } catch(apiErr) {
      // Fallback to DB cache
      var query = 'SELECT * FROM shopee_commissions';
      var params = [];
      var conditions = [];
      var paramNum = 1;

      conditions.push('order_created_at >= NOW() - ($' + paramNum + " * INTERVAL '1 day')"); params.push(days); paramNum++;
      if (orderStatus) { conditions.push('status = $' + paramNum); params.push(orderStatus); paramNum++; }

      if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
      query += ' ORDER BY order_created_at DESC LIMIT 200';

      var dbResult = await pool.query(query, params);
      var totalCommission = 0;
      var totalAmount = 0;
      dbResult.rows.forEach(function(r) { totalCommission += parseFloat(r.commission || 0); totalAmount += parseFloat(r.order_amount || 0); });

      res.json({
        nodes: dbResult.rows,
        summary: { totalOrders: dbResult.rows.length, totalCommission: totalCommission, totalOrderAmount: totalAmount },
        source: 'cache'
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Shopee campaigns/offers
app.get('/api/shopee/offers', authMiddleware, async function(req, res) {
  try {
    var result = await shopeeApi.getShopeeOffers({
      page: parseInt(req.query.page) || 1,
      limit: parseInt(req.query.limit) || 20
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Shopee commission summary for WhatsApp subId
app.get('/api/shopee/whatsapp-revenue', authMiddleware, async function(req, res) {
  try {
    var result = await pool.query(
      "SELECT DATE(order_created_at) as date, COUNT(*) as orders, SUM(commission) as total_commission, SUM(order_amount) as total_sales " +
      "FROM shopee_commissions WHERE sub_id = 'whatsapp' AND order_created_at >= NOW() - INTERVAL '30 days' " +
      "GROUP BY DATE(order_created_at) ORDER BY date DESC"
    );
    var totals = await pool.query(
      "SELECT COUNT(*) as total_orders, COALESCE(SUM(commission),0) as total_commission, COALESCE(SUM(order_amount),0) as total_sales " +
      "FROM shopee_commissions WHERE sub_id = 'whatsapp'"
    );
    res.json({ daily: result.rows, totals: totals.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save Shopee config
app.post('/api/settings/shopee', authMiddleware, async function(req, res) {
  try {
    var current = {};
    var r = await pool.query("SELECT value FROM settings WHERE key='general'");
    if (r.rows.length > 0) current = r.rows[0].value || {};

    current.shopee = {
      appId: req.body.appId || '',
      secret: req.body.secret || ''
    };

    await pool.query(
      "INSERT INTO settings (key, value, updated_at) VALUES ('general', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()",
      [JSON.stringify(current)]
    );

    // Configure the Shopee API module
    shopeeApi.configure(current.shopee);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== SHOPEE ENHANCED ANALYTICS =====

// Revenue per lead - correlates whatsapp clicks with shopee commissions
app.get('/api/shopee/revenue-per-lead', authMiddleware, async function(req, res) {
  try {
    var days = validateDays(req.query.days, 30);

    // Total unique clicks with whatsapp context (leads)
    var clicksResult = await pool.query(
      "SELECT COUNT(*) as total_clicks, COUNT(DISTINCT ip) as unique_leads " +
      "FROM clicks WHERE timestamp >= NOW() - ($1 * INTERVAL '1 day')",
      [days]
    );

    // Total commissions from whatsapp subId
    var commissionsResult = await pool.query(
      "SELECT COUNT(*) as total_orders, " +
      "COALESCE(SUM(commission), 0) as total_commission, " +
      "COALESCE(SUM(order_amount), 0) as total_sales " +
      "FROM shopee_commissions WHERE sub_id = 'whatsapp' AND order_created_at >= NOW() - ($1 * INTERVAL '1 day')",
      [days]
    );

    var totalClicks = parseInt(clicksResult.rows[0].total_clicks) || 0;
    var uniqueLeads = parseInt(clicksResult.rows[0].unique_leads) || 0;
    var totalOrders = parseInt(commissionsResult.rows[0].total_orders) || 0;
    var totalCommission = parseFloat(commissionsResult.rows[0].total_commission) || 0;
    var totalSales = parseFloat(commissionsResult.rows[0].total_sales) || 0;

    var commissionPerLead = uniqueLeads > 0 ? totalCommission / uniqueLeads : 0;
    var conversionRate = uniqueLeads > 0 ? (totalOrders / uniqueLeads) * 100 : 0;
    var avgOrderValue = totalOrders > 0 ? totalSales / totalOrders : 0;
    var revenuePerClick = totalClicks > 0 ? totalCommission / totalClicks : 0;

    // Daily breakdown
    var dailyResult = await pool.query(
      "SELECT d.date, COALESCE(c.clicks, 0) as clicks, COALESCE(c.unique_ips, 0) as unique_leads, " +
      "COALESCE(s.orders, 0) as orders, COALESCE(s.commission, 0) as commission, COALESCE(s.sales, 0) as sales " +
      "FROM generate_series(NOW() - ($1 * INTERVAL '1 day'), NOW(), '1 day'::interval) d(date) " +
      "LEFT JOIN ( " +
      "  SELECT DATE(timestamp) as dt, COUNT(*) as clicks, COUNT(DISTINCT ip) as unique_ips " +
      "  FROM clicks WHERE timestamp >= NOW() - ($1 * INTERVAL '1 day') GROUP BY DATE(timestamp) " +
      ") c ON DATE(d.date) = c.dt " +
      "LEFT JOIN ( " +
      "  SELECT DATE(order_created_at) as dt, COUNT(*) as orders, SUM(commission) as commission, SUM(order_amount) as sales " +
      "  FROM shopee_commissions WHERE sub_id = 'whatsapp' AND order_created_at >= NOW() - ($1 * INTERVAL '1 day') GROUP BY DATE(order_created_at) " +
      ") s ON DATE(d.date) = s.dt " +
      "ORDER BY d.date",
      [days]
    );

    res.json({
      summary: {
        totalClicks: totalClicks,
        uniqueLeads: uniqueLeads,
        totalOrders: totalOrders,
        totalCommission: totalCommission,
        totalSales: totalSales,
        commissionPerLead: commissionPerLead,
        conversionRate: conversionRate,
        avgOrderValue: avgOrderValue,
        revenuePerClick: revenuePerClick
      },
      daily: dailyResult.rows,
      period: days
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Conversion funnel data
app.get('/api/shopee/conversion-funnel', authMiddleware, async function(req, res) {
  try {
    var days = validateDays(req.query.days, 30);

    var clicks = await pool.query(
      "SELECT COUNT(*) as total, COUNT(DISTINCT ip) as unique_total " +
      "FROM clicks WHERE timestamp >= NOW() - ($1 * INTERVAL '1 day')",
      [days]
    );

    var orders = await pool.query(
      "SELECT COUNT(*) as total, COALESCE(SUM(order_amount), 0) as total_amount " +
      "FROM shopee_commissions WHERE sub_id = 'whatsapp' AND order_created_at >= NOW() - ($1 * INTERVAL '1 day')",
      [days]
    );

    var completedOrders = await pool.query(
      "SELECT COUNT(*) as total, COALESCE(SUM(commission), 0) as total_commission " +
      "FROM shopee_commissions WHERE sub_id = 'whatsapp' AND status = 'COMPLETED' AND order_created_at >= NOW() - ($1 * INTERVAL '1 day')",
      [days]
    );

    var pendingOrders = await pool.query(
      "SELECT COUNT(*) as total, COALESCE(SUM(commission), 0) as total_commission " +
      "FROM shopee_commissions WHERE sub_id = 'whatsapp' AND status = 'PENDING' AND order_created_at >= NOW() - ($1 * INTERVAL '1 day')",
      [days]
    );

    var cancelledOrders = await pool.query(
      "SELECT COUNT(*) as total " +
      "FROM shopee_commissions WHERE sub_id = 'whatsapp' AND status = 'CANCELLED' AND order_created_at >= NOW() - ($1 * INTERVAL '1 day')",
      [days]
    );

    // Top earning products
    var topProducts = await pool.query(
      "SELECT item_name, shop_name, COUNT(*) as order_count, SUM(commission) as total_commission, SUM(order_amount) as total_sales " +
      "FROM shopee_commissions WHERE sub_id = 'whatsapp' AND order_created_at >= NOW() - ($1 * INTERVAL '1 day') " +
      "GROUP BY item_name, shop_name ORDER BY total_commission DESC LIMIT 10",
      [days]
    );

    res.json({
      funnel: {
        clicks: parseInt(clicks.rows[0].total) || 0,
        uniqueVisitors: parseInt(clicks.rows[0].unique_total) || 0,
        totalOrders: parseInt(orders.rows[0].total) || 0,
        totalOrderAmount: parseFloat(orders.rows[0].total_amount) || 0,
        completedOrders: parseInt(completedOrders.rows[0].total) || 0,
        completedCommission: parseFloat(completedOrders.rows[0].total_commission) || 0,
        pendingOrders: parseInt(pendingOrders.rows[0].total) || 0,
        pendingCommission: parseFloat(pendingOrders.rows[0].total_commission) || 0,
        cancelledOrders: parseInt(cancelledOrders.rows[0].total) || 0
      },
      topProducts: topProducts.rows,
      period: days
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// WhatsApp message templates CRUD
app.get('/api/shopee/message-templates', authMiddleware, async function(req, res) {
  try {
    var r = await pool.query("SELECT value FROM settings WHERE key = 'shopee_msg_templates'");
    var templates = [];
    if (r.rows.length > 0 && r.rows[0].value && r.rows[0].value.templates) {
      templates = r.rows[0].value.templates;
    } else {
      // Default templates
      templates = [
        {
          id: 'promo',
          name: 'Promoção Padrão',
          template: '🔥 *{{productName}}*\n\n💰 De ~R$ {{originalPrice}}~ por *R$ {{price}}*\n🏷️ {{discount}}% OFF\n\n👉 {{link}}\n\n⏰ Corre que é por tempo limitado!'
        },
        {
          id: 'simple',
          name: 'Simples',
          template: '🛒 *{{productName}}*\n💰 *R$ {{price}}*\n\n👉 {{link}}'
        },
        {
          id: 'detailed',
          name: 'Detalhado',
          template: '🔥 *OFERTA IMPERDÍVEL!*\n\n📦 {{productName}}\n🏪 Loja: {{shopName}}\n\n💰 Por apenas *R$ {{price}}*\n⭐ Avaliação: {{rating}}/5\n📊 Já vendeu {{sales}}x\n💎 Comissão: {{commissionRate}}%\n\n👉 {{link}}\n\n✅ Compre agora na Shopee!'
        }
      ];
    }
    res.json(templates);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/shopee/message-templates', authMiddleware, async function(req, res) {
  try {
    var templates = req.body.templates;
    if (!templates || !Array.isArray(templates)) {
      return res.status(400).json({ error: 'Templates inválidos' });
    }

    // Sanitize templates
    templates = templates.map(function(t) {
      return {
        id: (t.id || '').substring(0, 50),
        name: (t.name || '').substring(0, 100),
        template: (t.template || '').substring(0, 2000)
      };
    }).slice(0, 20);

    await pool.query(
      "INSERT INTO settings (key, value, updated_at) VALUES ('shopee_msg_templates', $1, NOW()) " +
      "ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()",
      [JSON.stringify({ templates: templates })]
    );

    res.json({ success: true, templates: templates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search shops endpoint
app.get('/api/shopee/shops', authMiddleware, async function(req, res) {
  try {
    var result = await shopeeApi.searchShops({
      keyword: req.query.keyword || '',
      page: parseInt(req.query.page) || 1,
      limit: parseInt(req.query.limit) || 20,
      sortType: parseInt(req.query.sort) || 2
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== MULTI-WHATSAPP NUMBER MANAGEMENT =====

// List connected numbers
app.get('/api/whatsapp/numbers', authMiddleware, async function(req, res) {
  try {
    var result = await pool.query('SELECT * FROM whatsapp_numbers ORDER BY is_primary DESC, created_at');

    // Update primary number status from monitor
    var status = whatsappMonitor.getStatus();
    var numbers = result.rows.map(function(n) {
      if (n.is_primary) {
        n.status = status.ready ? 'connected' : 'disconnected';
        n.phone_number = status.phone || n.phone_number;
      }
      return n;
    });

    // If no primary exists, add the current monitor as primary
    if (numbers.length === 0 && status.ready) {
      await pool.query(
        "INSERT INTO whatsapp_numbers (id, phone_number, label, status, is_primary, session_data_path) VALUES ($1,$2,$3,$4,true,$5) ON CONFLICT(id) DO UPDATE SET status=$4, phone_number=$2",
        ['primary', status.phone || '', 'Principal', 'connected', './whatsapp-session']
      );
      numbers.push({ id: 'primary', phone_number: status.phone || '', label: 'Principal', status: 'connected', is_primary: true, use_for_broadcast: true });
    }

    res.json(numbers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add new WhatsApp number
app.post('/api/whatsapp/numbers', authMiddleware, async function(req, res) {
  try {
    var label = req.body.label || 'Número ' + Date.now();
    var id = 'wn_' + Date.now();
    var sessionPath = './whatsapp-session-' + id;

    await pool.query(
      "INSERT INTO whatsapp_numbers (id, label, status, is_primary, use_for_broadcast, session_data_path) VALUES ($1,$2,'pending',$3,$4,$5)",
      [id, label, false, true, sessionPath]
    );

    res.json({ id: id, label: label, status: 'pending', message: 'Número adicionado. Escaneie o QR code para conectar.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove WhatsApp number
app.delete('/api/whatsapp/numbers/:id', authMiddleware, async function(req, res) {
  try {
    if (req.params.id === 'primary') {
      return res.status(400).json({ error: 'Não é possível remover o número principal' });
    }
    await pool.query('DELETE FROM whatsapp_numbers WHERE id=$1 AND is_primary=false', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Auto health check every 30 minutes
setInterval(function() {
  runHealthCheck().catch(function(err) {
    console.error('[HEALTH] Erro no auto-check:', err.message);
  });
}, 30 * 60 * 1000);

// ===== START SERVER =====
app.listen(PORT, async function() {
  console.log('');
  console.log('===========================================');
  console.log('  LinkRotator Pro - Servidor Backend');
  console.log('  Rodando na porta ' + PORT);
  console.log('  Banco: PostgreSQL');
  console.log('===========================================');
  console.log('');

  // Initialize WhatsApp Monitor with pg pool
  whatsappMonitor.initialize(pool);

  // Load sequential counters from database so rotation resumes after restart
  await loadSequentialCounters();

  // Load Meta credentials from database (saved via frontend settings)
  try {
    var settingsR = await pool.query("SELECT value FROM settings WHERE key='general'");
    if (settingsR.rows.length > 0 && settingsR.rows[0].value && settingsR.rows[0].value.meta) {
      var meta = settingsR.rows[0].value.meta;
      if (meta.accessToken && meta.accessToken !== 'SEU_TOKEN_META_AQUI') {
        process.env.META_ACCESS_TOKEN = meta.accessToken;
        console.log('[META] Token carregado do banco de dados');
      }
      if (meta.adAccountId) process.env.META_AD_ACCOUNT_ID = meta.adAccountId;
      if (meta.appId) process.env.META_APP_ID = meta.appId;
      if (meta.appSecret) process.env.META_APP_SECRET = meta.appSecret;
    }
  } catch(e) {
    console.error('[META] Erro ao carregar credenciais do banco:', e.message);
  }

  // Load Shopee credentials from database
  try {
    var settingsR2 = await pool.query("SELECT value FROM settings WHERE key='general'");
    if (settingsR2.rows.length > 0 && settingsR2.rows[0].value && settingsR2.rows[0].value.shopee) {
      shopeeApi.configure(settingsR2.rows[0].value.shopee);
      console.log('[SHOPEE] Credenciais carregadas do banco de dados');
    }
  } catch(e) {
    console.error('[SHOPEE] Erro ao carregar credenciais:', e.message);
  }

  // Register primary WhatsApp number
  try {
    await pool.query(
      "INSERT INTO whatsapp_numbers (id, label, status, is_primary, session_data_path) VALUES ('primary', 'Principal', 'connecting', true, './whatsapp-session') ON CONFLICT (id) DO NOTHING"
    );
  } catch(e) { /* table might not exist yet */ }

  // First auto-capacity check after 3 minutes
  setTimeout(checkAutoCapacity, 3 * 60 * 1000);

  // First Meta sync
  if (process.env.META_ACCESS_TOKEN && process.env.META_ACCESS_TOKEN !== 'SEU_TOKEN_META_AQUI') {
    console.log('[META] Iniciando primeira sincronização...');
    console.log('[META] Ad Account: ' + process.env.META_AD_ACCOUNT_ID);
    syncMetaToDB();
  } else {
    console.log('[META] Token não configurado. Configure via Configurações no painel ou META_ACCESS_TOKEN no .env');
  }

  // First health check after 2 minutes (give WhatsApp time to connect)
  setTimeout(function() {
    console.log('[HEALTH] Iniciando primeira varredura de saúde...');
    runHealthCheck().catch(function(err) {
      console.error('[HEALTH] Erro na primeira varredura:', err.message);
    });
  }, 2 * 60 * 1000);
});
