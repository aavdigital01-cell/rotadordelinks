require('dotenv').config();
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
    var days = parseInt(req.query.days) || 0;
    var whereClause = days > 0 ? "WHERE timestamp >= NOW() - INTERVAL '" + days + " days'" : '';
    var result = await pool.query(
      'SELECT * FROM clicks ' + whereClause + ' ORDER BY timestamp DESC LIMIT $1 OFFSET $2',
      [limit, offset]
    );
    var countResult = await pool.query('SELECT COUNT(*) as total FROM clicks ' + whereClause);
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

// Batch insights - fetch all campaigns with insights in parallel (fast)
app.get('/api/meta/insights-batch', authMiddleware, async function(req, res) {
  try {
    var dateRange = req.query.date_range || 'today';

    // For "today", return DB cache (instant)
    if (dateRange === 'today') {
      var dbResult = await pool.query('SELECT * FROM meta_campaigns ORDER BY name');
      var mapped = dbResult.rows.map(function(r) {
        return {
          id: r.id, name: r.name, status: r.status, objective: r.objective,
          dailyBudget: parseFloat(r.daily_budget || 0),
          spend: parseFloat(r.spend || 0), impressions: parseInt(r.impressions || 0),
          clicks: parseInt(r.clicks || 0), cpc: parseFloat(r.cpc || 0),
          cpm: parseFloat(r.cpm || 0), ctr: parseFloat(r.ctr || 0),
          reach: parseInt(r.reach || 0), conversions: parseInt(r.conversions || 0),
          costPerResult: parseFloat(r.cost_per_result || 0)
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
        var conversions = 0, costPerResult = 0;
        if (d.actions) {
          conversions = extractConversions(d.actions);
        }
        if (d.cost_per_action_type) {
          costPerResult = extractCostPerResult(d.cost_per_action_type);
        }
        return {
          id: camp.id, name: camp.name, status: camp.effective_status || camp.status || 'N/A',
          spend: parseFloat(d.spend || 0), impressions: parseInt(d.impressions || 0),
          clicks: parseInt(d.clicks || 0), cpc: parseFloat(d.cpc || 0),
          cpm: parseFloat(d.cpm || 0), ctr: parseFloat(d.ctr || 0),
          conversions: conversions, costPerResult: costPerResult
        };
      }).catch(function() {
        return {
          id: camp.id, name: camp.name, status: camp.effective_status || camp.status || 'N/A',
          spend: 0, impressions: 0, clicks: 0, cpc: 0, cpm: 0, ctr: 0, conversions: 0, costPerResult: 0
        };
      });
    });

    var results = await Promise.all(promises);
    res.json({ campaigns: results, source: 'api' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== EXCHANGE RATE (USD → BRL) =====

var exchangeRateCache = { rate: null, timestamp: 0 };
var EXCHANGE_CACHE_TTL = 30 * 60 * 1000; // 30 minutos

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
    // Fallback: try alternative endpoint
    var resp2 = await fetch('https://economia.awesomeapi.com.br/json/last/USD-BRL');
    var data2 = await resp2.json();
    if (data2 && data2.USDBRL && data2.USDBRL.bid) {
      var rate2 = parseFloat(data2.USDBRL.bid);
      exchangeRateCache = { rate: rate2, timestamp: now };
      return rate2;
    }
    throw new Error('Formato inesperado da API');
  } catch (err) {
    if (!exchangeRateCache._logged || (now - exchangeRateCache._logged) > 300000) {
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

// ===== ANALYTICS ENDPOINTS =====

// Executive summary - all key metrics in one call
app.get('/api/analytics/summary', authMiddleware, async function(req, res) {
  try {
    var days = parseInt(req.query.days) || 1;
    var interval = days === 1 ? 'CURRENT_DATE' : "NOW() - INTERVAL '" + days + " days'";

    var [clicksR, eventsR, groupsR, metaR, metaSpendR] = await Promise.all([
      pool.query("SELECT COUNT(*) as total FROM clicks WHERE timestamp >= " + interval),
      pool.query("SELECT action, COUNT(*) as cnt FROM member_events WHERE timestamp >= " + interval + " GROUP BY action"),
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
    var metaSpend = parseFloat(metaSpendR.rows[0].spend);

    var convRate = clicks > 0 ? ((joins / clicks) * 100).toFixed(1) : '0';
    var retentionRate = joins > 0 ? ((retained / joins) * 100).toFixed(1) : '0';
    var exitRate = joins > 0 ? ((leaves / joins) * 100).toFixed(1) : '0';
    var flightRate = clicks > 0 ? (((clicks - joins) / clicks) * 100).toFixed(1) : '0';

    res.json({
      period: days === 1 ? 'today' : days + 'd',
      clicks: clicks, joins: joins, leaves: leaves, retained: retained,
      totalMembers: totalMembers, totalGroups: totalGroups,
      metaClicks: metaClicks, metaImpressions: metaImpressions,
      metaConversions: metaConversions, metaSpendUSD: metaSpend,
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
    var days = parseInt(req.query.days) || 7;

    var [clicksR, eventsR] = await Promise.all([
      pool.query(
        "SELECT EXTRACT(HOUR FROM timestamp) as hour, EXTRACT(DOW FROM timestamp) as dow, COUNT(*) as cnt FROM clicks WHERE timestamp >= NOW() - INTERVAL '" + days + " days' GROUP BY hour, dow ORDER BY dow, hour"
      ),
      pool.query(
        "SELECT EXTRACT(HOUR FROM timestamp) as hour, EXTRACT(DOW FROM timestamp) as dow, action, COUNT(*) as cnt FROM member_events WHERE timestamp >= NOW() - INTERVAL '" + days + " days' GROUP BY hour, dow, action ORDER BY dow, hour"
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
    var days = parseInt(req.query.days) || 30;

    // Get clicks grouped by campaign
    var clicksR = await pool.query(
      "SELECT campaign_id, COUNT(*) as clicks FROM clicks WHERE campaign_id IS NOT NULL AND timestamp >= NOW() - INTERVAL '" + days + " days' GROUP BY campaign_id"
    );

    // Get member events for correlation
    var eventsR = await pool.query(
      "SELECT whatsapp_group_id, action, COUNT(*) as cnt FROM member_events WHERE timestamp >= NOW() - INTERVAL '" + days + " days' GROUP BY whatsapp_group_id, action"
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
    var activeMeta = metaR.rows.filter(function(c) { return parseInt(c.spend) > 0; });
    if (activeMeta.length > 1) {
      var cpcs = [];
      var metaDetailsR = await pool.query('SELECT id, name, cpc, spend FROM meta_campaigns WHERE spend > 0');
      metaDetailsR.rows.forEach(function(c) { cpcs.push({ id: c.id, name: c.name, cpc: parseFloat(c.cpc) }); });
      var avgCpc = cpcs.reduce(function(s, c) { return s + c.cpc; }, 0) / cpcs.length;
      cpcs.forEach(function(c) {
        if (c.cpc > avgCpc * 2 && c.cpc > 0) {
          alerts.push({
            type: 'high_cpc',
            severity: 'info',
            title: 'CPC elevado',
            message: c.name + ': CPC $' + c.cpc.toFixed(2) + ' (média $' + avgCpc.toFixed(2) + ')',
            campaignId: c.id, campaignName: c.name
          });
        }
      });
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

    // 5. Links with health issues (broken/banned)
    var unhealthyLinksR = await pool.query("SELECT name, health_check_failures, deactivated_reason FROM links WHERE health_check_failures > 0 OR (deactivated_reason IS NOT NULL AND deactivated_reason LIKE '%banido%')");
    unhealthyLinksR.rows.forEach(function(l) {
      var sev = l.health_check_failures >= 3 || l.deactivated_reason ? 'danger' : 'warning';
      alerts.push({
        type: 'link_health',
        severity: sev,
        title: 'Link com problema',
        message: l.name + (l.deactivated_reason ? ' - ' + l.deactivated_reason : ' - ' + l.health_check_failures + ' falha(s) detectada(s)'),
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
    var days = parseInt(req.query.days) || 7;
    var [refR, osR, cityR, browserR] = await Promise.all([
      pool.query("SELECT referrer, COUNT(*) as cnt FROM clicks WHERE timestamp >= NOW() - INTERVAL '" + days + " days' AND referrer IS NOT NULL AND referrer != '' GROUP BY referrer ORDER BY cnt DESC LIMIT 20"),
      pool.query("SELECT os, COUNT(*) as cnt FROM clicks WHERE timestamp >= NOW() - INTERVAL '" + days + " days' AND os IS NOT NULL AND os != '' GROUP BY os ORDER BY cnt DESC LIMIT 10"),
      pool.query("SELECT city, COUNT(*) as cnt FROM clicks WHERE timestamp >= NOW() - INTERVAL '" + days + " days' AND city IS NOT NULL AND city != '' GROUP BY city ORDER BY cnt DESC LIMIT 20"),
      pool.query("SELECT browser, COUNT(*) as cnt FROM clicks WHERE timestamp >= NOW() - INTERVAL '" + days + " days' AND browser IS NOT NULL AND browser != '' GROUP BY browser ORDER BY cnt DESC LIMIT 10")
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

      // a) Check WhatsApp invite link via client
      var inviteCode = extractInviteCode(link.url);
      if (inviteCode && whatsappReady) {
        var inviteCheck = await whatsappMonitor.checkInviteCode(inviteCode);
        if (inviteCheck !== null) {
          if (!inviteCheck.valid) {
            result.status = 'broken';
            result.issues.push('Link de convite inválido ou expirado');
          }
        }
      } else if (inviteCode && !whatsappReady) {
        // Fallback: HTTP check
        try {
          var resp = await fetch('https://chat.whatsapp.com/' + inviteCode, {
            method: 'GET',
            redirect: 'follow',
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LinkRotatorBot/1.0)' }
          });
          var body = await resp.text();
          // Check for invalid group indicators in meta tags
          if (resp.status === 404 || body.includes('invite_link_revoke') || body.includes('"invite_link_is_revoked":true')) {
            result.status = 'broken';
            result.issues.push('Link de convite revogado ou grupo banido');
          } else if (!body.includes('og:title') || body.includes('<title>WhatsApp</title>')) {
            // Generic WhatsApp page without group info = possibly invalid
            result.status = 'warning';
            result.issues.push('Link pode estar inválido (sem informações do grupo)');
          }
        } catch (err) {
          result.status = 'warning';
          result.issues.push('Erro ao verificar URL: ' + err.message);
        }
      }

      // b) Check linked WhatsApp group exists
      if (link.whatsapp_group_id && whatsappReady) {
        var groupCheck = await whatsappMonitor.checkGroupExists(link.whatsapp_group_id);
        if (groupCheck !== null && !groupCheck.exists) {
          result.status = 'broken';
          result.issues.push('Grupo vinculado não encontrado no WhatsApp');
        }
      }

      // c) Check accumulated health_check_failures
      if (link.health_check_failures >= 3) {
        result.status = 'broken';
        result.issues.push(link.health_check_failures + ' falhas consecutivas reportadas por usuários');
      } else if (link.health_check_failures >= 1) {
        if (result.status === 'healthy') result.status = 'warning';
        result.issues.push(link.health_check_failures + ' falha(s) reportada(s) por usuários');
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
      } else if (result.status === 'healthy' && link.health_check_failures > 0) {
        // Link recovered - reset failures
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
