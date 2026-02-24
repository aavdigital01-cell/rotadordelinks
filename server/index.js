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
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/campaigns/:id', authMiddleware, async function(req, res) {
  try {
    // Also delete associated links
    await pool.query('DELETE FROM links WHERE campaign_id=$1', [req.params.id]);
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
    var hourly = new Array(24).fill(0);
    var devices = { Mobile: 0, Desktop: 0, Tablet: 0 };
    result.rows.forEach(function(r) {
      var h = new Date(r.timestamp).getHours();
      hourly[h]++;
      var dev = r.device || 'Desktop';
      if (devices[dev] !== undefined) devices[dev]++;
      else devices['Desktop']++;
    });
    res.json({ total: result.rows.length, hourly: hourly, devices: devices, clicks: result.rows.map(mapClick) });
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

// Paginated clicks for leads view
app.get('/api/clicks/leads', authMiddleware, async function(req, res) {
  try {
    var limit = parseInt(req.query.limit) || 50;
    var offset = parseInt(req.query.offset) || 0;
    var result = await pool.query(
      'SELECT * FROM clicks ORDER BY timestamp DESC LIMIT $1 OFFSET $2',
      [limit, offset]
    );
    var countResult = await pool.query('SELECT COUNT(*) as total FROM clicks');
    res.json({
      clicks: result.rows.map(mapClick),
      total: parseInt(countResult.rows[0].total),
      hasMore: offset + limit < parseInt(countResult.rows[0].total)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== ROTATE - Public endpoint for redirect page (no auth) =====
app.post('/api/rotate', async function(req, res) {
  try {
    var slug = req.body.slug;
    if (!slug) return res.status(400).json({ error: 'Slug obrigatório' });

    // 1. Find campaign by slug
    var campResult = await pool.query(
      'SELECT * FROM campaigns WHERE slug=$1 AND is_active=true LIMIT 1', [slug]
    );
    if (campResult.rows.length === 0) {
      return res.status(404).json({ error: 'Campanha não encontrada ou inativa' });
    }
    var camp = campResult.rows[0];
    var campData = mapCampaign(camp);

    // 2. Find active, non-full links
    var linksResult = await pool.query(
      'SELECT * FROM links WHERE campaign_id=$1 AND is_active=true AND is_full=false', [camp.id]
    );
    if (linksResult.rows.length === 0) {
      // All groups full - create alert
      await pool.query(
        'INSERT INTO alerts (type, campaign_name, message, read) VALUES ($1,$2,$3,false)',
        ['all_full', camp.name, 'Todos os grupos cheios na campanha ' + camp.name]
      );
      return res.status(404).json({ error: 'Todos os grupos estão cheios' });
    }
    var links = linksResult.rows.map(mapLink);

    // 3. Select link based on rotation mode
    var mode = camp.rotation_mode || 'random';
    var selected = null;
    if (links.length === 1) {
      selected = links[0];
    } else if (mode === 'weighted') {
      var totalWeight = links.reduce(function(s, l) { return s + (l.weight || 1); }, 0);
      var r = Math.random() * totalWeight;
      var cum = 0;
      for (var i = 0; i < links.length; i++) {
        cum += (links[i].weight || 1);
        if (r <= cum) { selected = links[i]; break; }
      }
      if (!selected) selected = links[links.length - 1];
    } else if (mode === 'least-filled') {
      links.sort(function(a, b) {
        return ((a.currentClicks || 0) / (a.maxVacancies || 1)) - ((b.currentClicks || 0) / (b.maxVacancies || 1));
      });
      selected = links[0];
    } else if (mode === 'sequential') {
      var seqIdx = req.body.sequentialIndex || 0;
      links.sort(function(a, b) { return (a.order || 0) - (b.order || 0); });
      selected = links[seqIdx % links.length];
    } else {
      selected = links[Math.floor(Math.random() * links.length)];
    }

    // 4. Record click
    var v = req.body.visitor || {};
    await pool.query(
      'INSERT INTO clicks (link_id, link_name, campaign_id, device, browser, os, city, country, country_code, ip, referrer) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [selected.id, selected.name, camp.id, v.device || '', v.browser || '', v.os || '', v.city || '', v.country || '', v.countryCode || '', v.ip || req.ip, v.referrer || '']
    );

    // 5. Increment clicks and check if full
    var updResult = await pool.query(
      'UPDATE links SET current_clicks = current_clicks + 1, is_full = CASE WHEN current_clicks + 1 >= max_vacancies THEN true ELSE false END, updated_at = NOW() WHERE id=$1 RETURNING current_clicks, max_vacancies, is_full',
      [selected.id]
    );

    // 6. Create alerts if needed
    if (updResult.rows.length > 0) {
      var upd = updResult.rows[0];
      if (upd.is_full) {
        await pool.query(
          'INSERT INTO alerts (type, campaign_name, link_name, message, read) VALUES ($1,$2,$3,$4,false)',
          ['link_full', camp.name, selected.name, 'Grupo cheio: ' + selected.name]
        );
      } else {
        var threshold = camp.alert_threshold || 90;
        var fillPct = (upd.current_clicks / (upd.max_vacancies || 1)) * 100;
        if (fillPct >= threshold) {
          await pool.query(
            'INSERT INTO alerts (type, campaign_name, link_name, percent, message, read) VALUES ($1,$2,$3,$4,$5,false)',
            ['link_near_full', camp.name, selected.name, Math.round(fillPct), 'Grupo quase cheio: ' + selected.name + ' (' + Math.round(fillPct) + '%)']
          );
        }
      }
    }

    // 7. Return data for client-side pixel firing + redirect
    res.json({
      url: selected.url,
      campaign: campData,
      link: { id: selected.id, name: selected.name }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Report broken link (no auth - called from redirect page)
app.post('/api/report-broken-link', async function(req, res) {
  try {
    var b = req.body;
    var linkId = b.linkId;
    if (!linkId) return res.status(400).json({ error: 'linkId obrigatório' });

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
    var b = req.body;
    await pool.query(
      'INSERT INTO clicks (link_id, link_name, campaign_id, device, browser, os, city, country, country_code, ip, referrer) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [b.linkId, b.linkName, b.campaignId, b.device, b.browser, b.os || '', b.city, b.country, b.countryCode, b.ip || req.ip, b.referrer]
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
    res.json(result.rows.map(mapAlert));
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

// Upsert user on login (creates if not exists, updates lastLogin)
app.post('/api/users/login', authMiddleware, async function(req, res) {
  try {
    var b = req.body;
    var uid = req.user.uid;
    var result = await pool.query(
      `INSERT INTO users (uid, email, display_name, last_login)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (uid) DO UPDATE SET email=$2, display_name=$3, last_login=NOW()
       RETURNING *`,
      [uid, b.email || req.user.email || '', b.displayName || '']
    );
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
