/**
 * WhatsApp Group Monitor v3.0 - Evolution API
 * Monitora entradas/saídas de membros nos grupos via Evolution API REST
 * Usa Evolution API + PostgreSQL
 *
 * Migração v3.0 (Baileys → Evolution API):
 * - Substitui Baileys por chamadas HTTP à Evolution API
 * - Eventos em tempo real via webhook (POST /api/whatsapp/webhook)
 * - QR Code e Pairing Code via Evolution API
 * - Scan periódico de grupos mantido (via REST)
 * - Mesma interface pública (initialize, getStatus, getGroups, etc.)
 * - Envio de mensagens via REST (sendMessage, sendMedia)
 * - Gerenciamento de instância automático (cria se não existir)
 */

const crypto = require('crypto');
const fetch = require('node-fetch');

var pool = null; // PostgreSQL pool
var currentQR = null;
var currentQRBase64 = null;
var reconnectAttempts = 0;
var MAX_RECONNECT_ATTEMPTS = 5;
var scanInProgress = false;

// Evolution API config
var EVOLUTION_API_URL = '';
var EVOLUTION_API_KEY = '';
var EVOLUTION_INSTANCE_NAME = '';

var connectionStatus = {
  connected: false,
  ready: false,
  phone: null,
  lastDisconnect: null,
  error: null,
  reconnectAttempts: 0
};

// Cache com TTL para nomes de grupos
var GROUP_NAME_CACHE_TTL = 5 * 60 * 1000; // 5 minutos
var groupNameCache = {};

// Snapshot de membros para detectar eventos perdidos
var lastKnownMembers = {};

// Fila de eventos pendentes para retry em caso de falha no DB
var eventRetryQueue = [];
var RETRY_INTERVAL = 10000; // 10 segundos
var MAX_RETRY_ATTEMPTS = 5;

// Intervalo de scan periódico (2 minutos)
var SCAN_INTERVAL = 2 * 60 * 1000;

// Janela de deduplicação para evitar eventos duplicados
var recentEvents = {};
var DEDUP_WINDOW = 60 * 1000; // 60 segundos

// Flag para saber se a coluna 'source' existe na tabela member_events
var sourceColumnExists = true;

// Poll interval para verificar conexão
var CONNECTION_POLL_INTERVAL = 30 * 1000; // 30 segundos
var connectionPollTimer = null;

// ===== HELPERS =====

/**
 * Hash seguro para telefone usando SHA-256
 */
function hashPhone(phone) {
  return 'ph_' + crypto.createHash('sha256').update(phone).digest('hex').substring(0, 12);
}

/**
 * Faz chamada à Evolution API
 */
async function evoApi(method, path, body) {
  var url = EVOLUTION_API_URL + path;
  var options = {
    method: method,
    headers: {
      'Content-Type': 'application/json',
      'apikey': EVOLUTION_API_KEY
    }
  };
  if (body && (method === 'POST' || method === 'PUT')) {
    options.body = JSON.stringify(body);
  }

  var response = await fetch(url, options);
  var text = await response.text();

  var data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    data = { raw: text };
  }

  if (!response.ok) {
    var errMsg = data.message || data.error || data.raw || ('HTTP ' + response.status);
    // Evolution API v2 wraps detailed errors in response.message array
    if (data.response && data.response.message) {
      errMsg = Array.isArray(data.response.message) ? data.response.message.join('; ') : data.response.message;
    }
    throw new Error(errMsg);
  }

  return data;
}

/**
 * Verifica se um evento é duplicado
 */
function isDuplicateEvent(groupId, phone, action) {
  var key = groupId + ':' + phone + ':' + action;
  var now = Date.now();

  var keys = Object.keys(recentEvents);
  for (var i = 0; i < keys.length; i++) {
    if (now - recentEvents[keys[i]] > DEDUP_WINDOW) {
      delete recentEvents[keys[i]];
    }
  }

  if (recentEvents[key]) {
    return true;
  }
  return false;
}

/**
 * Marca um evento como registrado na janela de dedup
 */
function markEventAsRecorded(groupId, phone, action) {
  var key = groupId + ':' + phone + ':' + action;
  recentEvents[key] = Date.now();
}

/**
 * Executa query com retry automático
 */
async function queryWithRetry(sql, params, maxRetries) {
  maxRetries = maxRetries || 3;
  for (var attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await pool.query(sql, params);
    } catch (err) {
      if (attempt === maxRetries) throw err;
      console.warn('[WHATSAPP] DB query falhou (tentativa ' + attempt + '/' + maxRetries + '): ' + err.message);
      await new Promise(function(resolve) { setTimeout(resolve, 1000 * attempt); });
    }
  }
}

/**
 * Processa fila de eventos que falharam ao salvar
 */
async function processRetryQueue() {
  if (eventRetryQueue.length === 0) return;

  var batch = eventRetryQueue.splice(0, eventRetryQueue.length);
  var failed = [];

  for (var item of batch) {
    try {
      var sql = item.sql;
      var params = item.params;
      if (!sourceColumnExists && sql.indexOf(', source') !== -1) {
        sql = sql.replace(', source', '').replace(', $6', '');
        params = params.slice(0, 5);
      }
      await pool.query(sql, params);
      console.log('[WHATSAPP] Evento pendente salvo com sucesso: ' + item.description);
    } catch (err) {
      if (err.message && err.message.indexOf('"source"') !== -1 && err.message.indexOf('does not exist') !== -1) {
        sourceColumnExists = false;
        item.sql = item.sql.replace(', source', '').replace(', $6', '');
        item.params = item.params.slice(0, 5);
      }
      item.attempts = (item.attempts || 1) + 1;
      if (item.attempts <= MAX_RETRY_ATTEMPTS) {
        failed.push(item);
      } else {
        console.error('[WHATSAPP] Evento descartado após ' + MAX_RETRY_ATTEMPTS + ' tentativas: ' + item.description);
      }
    }
  }

  if (failed.length > 0) {
    eventRetryQueue.push.apply(eventRetryQueue, failed);
  }
}

setInterval(processRetryQueue, RETRY_INTERVAL);

/**
 * Salva evento no DB com fallback para fila de retry
 */
async function saveEventSafe(sql, params, description) {
  try {
    await queryWithRetry(sql, params, 2);
  } catch (err) {
    if (err.message && err.message.indexOf('"source"') !== -1 && err.message.indexOf('does not exist') !== -1) {
      if (sourceColumnExists) {
        sourceColumnExists = false;
        console.warn('[WHATSAPP] Coluna "source" não existe em member_events. Execute a migration.');
      }
      try {
        var sqlNoSource = sql.replace(', source', '').replace(', $6', '');
        var paramsNoSource = params.slice(0, 5);
        await queryWithRetry(sqlNoSource, paramsNoSource, 2);
        return;
      } catch (err2) {
        console.error('[WHATSAPP] Falha ao salvar evento (sem source): ' + description + ' - ' + err2.message);
        eventRetryQueue.push({ sql: sql.replace(', source', '').replace(', $6', ''), params: params.slice(0, 5), description: description, attempts: 1 });
        return;
      }
    }
    console.error('[WHATSAPP] Falha ao salvar evento: ' + description + ' - ' + err.message);
    eventRetryQueue.push({ sql: sql, params: params, description: description, attempts: 1 });
  }
}

/**
 * Registra um evento de membro (join/leave) com deduplicação
 */
async function recordMemberEvent(groupId, groupName, memberPhone, action, source) {
  if (isDuplicateEvent(groupId, memberPhone, action)) {
    return;
  }

  await saveEventSafe(
    'INSERT INTO member_events (whatsapp_group_id, group_name, phone, phone_partial, action, source) VALUES ($1, $2, $3, $4, $5, $6)',
    [groupId, groupName, hashPhone(memberPhone), memberPhone.slice(-4), action, source],
    source + ':' + action + ':' + memberPhone.slice(-4) + '@' + groupName
  );

  markEventAsRecorded(groupId, memberPhone, action);

  if (action === 'join') {
    await saveEventSafe(
      'INSERT INTO alerts (type, whatsapp_group_id, group_name, member_phone, message) VALUES ($1, $2, $3, $4, $5)',
      ['member_joined', groupId, groupName, '***' + memberPhone.slice(-4), 'Novo membro entrou no grupo ' + groupName],
      'alert:join:' + memberPhone.slice(-4)
    );

    if (memberPhone && memberPhone !== 'desconhecido') {
      await saveEventSafe(
        'INSERT INTO lead_contacts (phone, whatsapp_group_id, group_name, joined_at, is_active) VALUES ($1, $2, $3, NOW(), true) ' +
        'ON CONFLICT (phone, whatsapp_group_id) DO UPDATE SET is_active=true, left_at=NULL, joined_at=NOW()',
        [memberPhone, groupId, groupName],
        'lead:join:' + memberPhone.slice(-4)
      );
    }
  } else if (action === 'leave') {
    if (memberPhone && memberPhone !== 'desconhecido') {
      await saveEventSafe(
        'UPDATE lead_contacts SET is_active=false, left_at=NOW() WHERE phone=$1 AND whatsapp_group_id=$2',
        [memberPhone, groupId],
        'lead:leave:' + memberPhone.slice(-4)
      );
    }
  }
}

// ===== EVOLUTION API INSTANCE MANAGEMENT =====

/**
 * Verifica se a instância existe na Evolution API
 */
async function instanceExists() {
  try {
    var data = await evoApi('GET', '/instance/fetchInstances');
    if (Array.isArray(data)) {
      return data.some(function(inst) {
        // Evolution API v2 returns inst.name; v1 returns inst.instance.instanceName
        var name = (inst.instance && inst.instance.instanceName) || inst.name || inst.instanceName;
        return name === EVOLUTION_INSTANCE_NAME;
      });
    }
    return false;
  } catch (err) {
    console.error('[WHATSAPP] Erro ao verificar instâncias:', err.message);
    return false;
  }
}

/**
 * Cria a instância na Evolution API se não existir
 */
async function getWebhookUrl() {
  var webhookUrl = (process.env.EVOLUTION_WEBHOOK_URL || '').trim();
  if (!webhookUrl) {
    var frontUrl = (process.env.FRONTEND_URL || '').trim();
    if (frontUrl && frontUrl !== '*') {
      webhookUrl = frontUrl;
    } else {
      webhookUrl = 'http://localhost:' + (process.env.PORT || 3000);
    }
  }
  return webhookUrl.replace(/\/$/, '') + '/api/whatsapp/webhook';
}

async function createInstance() {
  try {
    var webhookUrl = await getWebhookUrl();

    var body = {
      instanceName: EVOLUTION_INSTANCE_NAME,
      integration: 'WHATSAPP-BAILEYS',
      qrcode: true,
      rejectCall: false,
      groupsIgnore: false,
      alwaysOnline: false,
      readMessages: false,
      readStatus: false,
      syncFullHistory: false,
      webhook: {
        url: webhookUrl,
        byEvents: false,
        base64: true,
        webhookByEvents: false,
        webhookBase64: true,
        events: [
          'QRCODE_UPDATED',
          'CONNECTION_UPDATE',
          'GROUPS_UPSERT',
          'GROUP_UPDATE',
          'GROUP_PARTICIPANTS_UPDATE'
        ]
      }
    };

    console.log('[WHATSAPP] Criando instância "' + EVOLUTION_INSTANCE_NAME + '" na Evolution API...');
    console.log('[WHATSAPP] Webhook URL: ' + webhookUrl);
    var data = await evoApi('POST', '/instance/create', body);
    console.log('[WHATSAPP] Instância criada com sucesso');

    // Se a resposta já contém QR Code, salva
    if (data) {
      if (data.qrcode && data.qrcode.base64) {
        currentQRBase64 = data.qrcode.base64;
        currentQR = data.qrcode.code || data.qrcode.base64;
        console.log('[WHATSAPP] QR Code recebido na criação da instância');
      } else if (data.base64) {
        currentQRBase64 = data.base64;
        currentQR = data.code || data.base64;
      }
    }

    return data;
  } catch (err) {
    // Se já existe, ignora (Evolution API v2 returns "already in use" or "Forbidden")
    var msg = (err.message || '').toLowerCase();
    if (msg.includes('already') || msg.includes('in use') || msg.includes('forbidden') || msg.includes('instance name is not available')) {
      console.log('[WHATSAPP] Instância já existe, usando existente');
      return null;
    }
    throw err;
  }
}

/**
 * Configura o webhook da instância existente
 */
async function configureWebhook() {
  var webhookUrl = await getWebhookUrl();

  // Tenta v2 primeiro, depois v1
  var endpoints = [
    { method: 'PUT', path: '/webhook/set/' + EVOLUTION_INSTANCE_NAME },
    { method: 'POST', path: '/webhook/set/' + EVOLUTION_INSTANCE_NAME }
  ];

  var webhookBody = {
    webhook: {
      enabled: true,
      url: webhookUrl,
      byEvents: false,
      base64: true,
      webhookByEvents: false,
      webhookBase64: true,
      events: [
        'QRCODE_UPDATED',
        'CONNECTION_UPDATE',
        'GROUPS_UPSERT',
        'GROUP_UPDATE',
        'GROUP_PARTICIPANTS_UPDATE'
      ]
    }
  };

  for (var i = 0; i < endpoints.length; i++) {
    try {
      await evoApi(endpoints[i].method, endpoints[i].path, webhookBody);
      console.log('[WHATSAPP] Webhook configurado: ' + webhookUrl);
      return;
    } catch (err) {
      if (i === endpoints.length - 1) {
        console.warn('[WHATSAPP] Aviso ao configurar webhook:', err.message);
      }
    }
  }
}

/**
 * Verifica estado da conexão via Evolution API
 */
async function checkConnectionState() {
  try {
    var data = await evoApi('GET', '/instance/connectionState/' + EVOLUTION_INSTANCE_NAME);
    // Evolution API v2 returns { instance: { state } } or { state } directly
    var state = (data.instance && data.instance.state) || data.state || 'close';

    if (state === 'open') {
      if (!connectionStatus.ready) {
        connectionStatus.connected = true;
        connectionStatus.ready = true;
        connectionStatus.error = null;
        reconnectAttempts = 0;
        connectionStatus.reconnectAttempts = 0;
        currentQR = null;
        currentQRBase64 = null;
        console.log('[WHATSAPP] Conexão ativa (Evolution API)');

        // Busca info do número conectado
        try {
          var info = await evoApi('GET', '/instance/fetchInstances');
          if (Array.isArray(info)) {
            var inst = info.find(function(i) {
              var name = (i.instance && i.instance.instanceName) || i.name || i.instanceName;
              return name === EVOLUTION_INSTANCE_NAME;
            });
            if (inst) {
              // Evolution API v2: inst.ownerJid or inst.number; v1: inst.instance.owner
              var owner = (inst.instance && inst.instance.owner) || inst.ownerJid || inst.number;
              if (owner) {
                connectionStatus.phone = owner.split('@')[0].split(':')[0];
                console.log('[WHATSAPP] Número conectado: ' + connectionStatus.phone);
              }
            }
          }
        } catch (e) {}

        // Carrega snapshots e faz scan inicial
        await loadSnapshotsFromDB();
        await scanGroupsWithDiff();
      }
    } else if (state === 'connecting') {
      connectionStatus.connected = false;
      connectionStatus.ready = false;
      connectionStatus.error = 'Conectando...';
    } else {
      connectionStatus.connected = false;
      connectionStatus.ready = false;
      if (!connectionStatus.error || connectionStatus.error === 'Conectando...') {
        connectionStatus.error = 'Desconectado. Conecte pelo painel.';
      }
    }

    return state;
  } catch (err) {
    console.error('[WHATSAPP] Erro ao verificar conexão:', err.message);
    return 'close';
  }
}

/**
 * Solicita conexão (gera QR Code)
 */
async function connectInstance() {
  try {
    var data = await evoApi('GET', '/instance/connect/' + EVOLUTION_INSTANCE_NAME);

    // Evolution API pode retornar QR em diferentes formatos
    if (data.base64) {
      currentQRBase64 = data.base64;
      currentQR = data.code || data.base64;
      console.log('[WHATSAPP] QR Code gerado pela Evolution API (base64)');
    } else if (data.qrcode) {
      // v2 format: { qrcode: { base64, code } }
      var qr = typeof data.qrcode === 'object' ? data.qrcode : { base64: data.qrcode };
      currentQRBase64 = qr.base64 || null;
      currentQR = qr.code || qr.base64 || null;
      console.log('[WHATSAPP] QR Code gerado pela Evolution API (qrcode object)');
    } else if (data.code) {
      currentQR = data.code;
      console.log('[WHATSAPP] QR Code gerado pela Evolution API (code text)');
    } else if (data.pairingCode) {
      console.log('[WHATSAPP] Pairing code retornado ao invés de QR');
    } else {
      console.log('[WHATSAPP] Resposta do connect:', JSON.stringify(data).substring(0, 200));
    }

    return data;
  } catch (err) {
    // Se já está conectado
    var errMsg = (err.message || '').toLowerCase();
    if (errMsg.includes('already') || errMsg.includes('connected') || errMsg.includes('open') || errMsg.includes('the instance')) {
      console.log('[WHATSAPP] Já está conectado');
      await checkConnectionState();
      return null;
    }
    throw err;
  }
}

// ===== WEBHOOK HANDLER =====

/**
 * Processa eventos recebidos via webhook da Evolution API
 * Chamado pela rota POST /api/whatsapp/webhook no index.js
 */
async function handleWebhook(body) {
  if (!body || !body.event) return;

  var event = body.event;
  var data = body.data || body;
  var instance = body.instance || body.instanceName;

  // Ignora eventos de outras instâncias
  if (instance && instance !== EVOLUTION_INSTANCE_NAME) return;

  try {
    switch (event) {
      case 'qrcode.updated':
      case 'QRCODE_UPDATED':
        // Evolution API v2 pode enviar em diferentes formatos
        if (data) {
          var qrData = data.qrcode || data;
          if (typeof qrData === 'object') {
            currentQRBase64 = qrData.base64 || null;
            currentQR = qrData.code || qrData.base64 || null;
          } else if (typeof qrData === 'string') {
            currentQR = qrData;
            if (qrData.length > 500) currentQRBase64 = qrData;
          }
          console.log('[WHATSAPP] [WEBHOOK] QR Code atualizado');
        }
        break;

      case 'connection.update':
      case 'CONNECTION_UPDATE':
        var state = data.state || data.status;
        console.log('[WHATSAPP] [WEBHOOK] Estado da conexão: ' + state);

        if (state === 'open') {
          connectionStatus.connected = true;
          connectionStatus.ready = true;
          connectionStatus.error = null;
          currentQR = null;
          currentQRBase64 = null;
          reconnectAttempts = 0;
          connectionStatus.reconnectAttempts = 0;

          // Extrai número
          if (data.ownerJid || data.wuid) {
            connectionStatus.phone = (data.ownerJid || data.wuid).split('@')[0].split(':')[0];
          }
          console.log('[WHATSAPP] Conectado! Número: ' + connectionStatus.phone);

          // Scan inicial
          setTimeout(async function() {
            await loadSnapshotsFromDB();
            await scanGroupsWithDiff();
          }, 3000);
        } else if (state === 'close' || state === 'refused') {
          connectionStatus.connected = false;
          connectionStatus.ready = false;
          connectionStatus.lastDisconnect = new Date().toISOString();

          if (data.statusReason === 401 || state === 'refused') {
            connectionStatus.error = 'Desconectado. Conecte novamente pelo painel.';
          } else {
            connectionStatus.error = data.reason || 'Desconectado';
            attemptReconnect();
          }
        }
        break;

      case 'group-participants.update':
      case 'GROUP_PARTICIPANTS_UPDATE':
        await handleGroupParticipantsUpdate(data);
        break;

      case 'groups.update':
      case 'GROUP_UPDATE':
      case 'groups.upsert':
      case 'GROUPS_UPSERT':
        if (data && data.id) {
          groupNameCache[data.id] = { name: data.subject || data.id, timestamp: Date.now() };
        }
        break;

      default:
        // Evento desconhecido, ignora
        break;
    }
  } catch (err) {
    console.error('[WHATSAPP] [WEBHOOK] Erro ao processar evento ' + event + ':', err.message);
  }
}

/**
 * Processa evento de participantes do grupo (join/leave)
 */
async function handleGroupParticipantsUpdate(data) {
  try {
    var groupId = data.id || data.groupJid;
    var participants = data.participants || [];
    var action = data.action; // 'add', 'remove', 'promote', 'demote'

    if (action !== 'add' && action !== 'remove') return;

    var groupName = await getGroupName(groupId);
    var eventAction = action === 'add' ? 'join' : 'leave';

    console.log('[WHATSAPP] [REALTIME] ' + participants.length + ' membro(s) ' + (action === 'add' ? 'entrou(ram)' : 'saiu(ram)') + ' do grupo ' + groupName);

    for (var i = 0; i < participants.length; i++) {
      var memberPhone = participants[i].split('@')[0];
      await recordMemberEvent(groupId, groupName, memberPhone, eventAction, 'realtime');
    }

    // Atualiza contagem de membros
    updateGroupMemberCount(groupId);

  } catch (err) {
    console.error('[WHATSAPP] Erro ao registrar evento de grupo:', err.message);
  }
}

// ===== SNAPSHOTS =====

async function loadSnapshotsFromDB() {
  try {
    var result = await pool.query('SELECT id, member_snapshot FROM whatsapp_groups WHERE member_snapshot IS NOT NULL');
    var loaded = 0;
    for (var row of result.rows) {
      if (row.member_snapshot && Array.isArray(row.member_snapshot)) {
        lastKnownMembers[row.id] = row.member_snapshot;
        loaded++;
      }
    }
    if (loaded > 0) {
      console.log('[WHATSAPP] Carregados ' + loaded + ' snapshots de membros do DB');
    }
  } catch (err) {
    if (err.message && err.message.includes('member_snapshot')) {
      console.log('[WHATSAPP] Coluna member_snapshot não existe ainda');
    } else {
      console.error('[WHATSAPP] Erro ao carregar snapshots:', err.message);
    }
  }
}

async function saveSnapshotToDB(groupId, members) {
  try {
    await pool.query(
      'UPDATE whatsapp_groups SET member_snapshot = $1 WHERE id = $2',
      [JSON.stringify(members), groupId]
    );
  } catch (err) {
    if (err.message && err.message.includes('member_snapshot')) {
      // Coluna não existe ainda
    } else {
      console.warn('[WHATSAPP] Erro ao salvar snapshot do grupo ' + groupId + ': ' + err.message);
    }
  }
}

// ===== SCAN DE GRUPOS =====

/**
 * Busca nome de um grupo (com cache e TTL)
 */
async function getGroupName(groupId, forceRefresh) {
  var cached = groupNameCache[groupId];
  if (cached && !forceRefresh && (Date.now() - cached.timestamp) < GROUP_NAME_CACHE_TTL) {
    return cached.name;
  }

  try {
    if (connectionStatus.ready) {
      var data = await evoApi('GET', '/group/findGroupInfos/' + EVOLUTION_INSTANCE_NAME + '?groupJid=' + groupId);
      if (data && data.subject) {
        groupNameCache[groupId] = { name: data.subject, timestamp: Date.now() };
        return data.subject;
      }
    }
  } catch (err) {
    if (cached) return cached.name;
  }
  return groupId;
}

/**
 * Busca todos os grupos via Evolution API
 */
async function fetchAllGroups() {
  var data = await evoApi('GET', '/group/fetchAllGroups/' + EVOLUTION_INSTANCE_NAME + '?getParticipants=true');
  // A Evolution API pode retornar array diretamente ou objeto
  if (Array.isArray(data)) return data;
  if (data && data.data && Array.isArray(data.data)) return data.data;
  if (data && Array.isArray(data.groups)) return data.groups;
  return [];
}

/**
 * Faz scan de todos os grupos COM detecção de diferenças
 */
async function scanGroupsWithDiff() {
  if (scanInProgress) {
    console.log('[WHATSAPP] Scan já em andamento, ignorando...');
    return;
  }

  scanInProgress = true;

  try {
    if (!connectionStatus.ready) { scanInProgress = false; return; }

    var groups = await fetchAllGroups();

    console.log('[WHATSAPP] Escaneando ' + groups.length + ' grupos...');

    var totalNewJoins = 0;
    var totalNewLeaves = 0;

    for (var i = 0; i < groups.length; i++) {
      var group = groups[i];
      var groupId = group.id || group.jid;

      try {
        var groupName = group.subject || group.groupName || groupId;
        var currentParticipants = [];

        if (group.participants && Array.isArray(group.participants)) {
          currentParticipants = group.participants.map(function(p) {
            var pid = typeof p === 'string' ? p : (p.id || p.jid || '');
            return pid.split('@')[0];
          }).filter(function(p) { return p && p.length > 0; });
        }

        var memberCount = group.size || currentParticipants.length;
        var maxMembers = group.maxParticipants || group.size || memberCount;
        if (maxMembers < memberCount) maxMembers = memberCount;

        // Extrai invite code se disponível
        var inviteCode = group.inviteCode || null;

        // Proteção: se API retornou lista vazia, é provável erro transitório
        if (currentParticipants.length === 0 && lastKnownMembers[groupId] && lastKnownMembers[groupId].length > 0) {
          console.warn('[WHATSAPP] [SCAN] ' + groupName + ': API retornou 0 participantes. Mantendo snapshot anterior.');
        } else {
          // Detecta diferenças com snapshot anterior
          var previousMembers = lastKnownMembers[groupId];
          if (previousMembers && previousMembers.length > 0 && currentParticipants.length > 0) {
            var prevSet = new Set(previousMembers);
            var currSet = new Set(currentParticipants);

            var newMembers = currentParticipants.filter(function(m) { return !prevSet.has(m); });
            var leftMembers = previousMembers.filter(function(m) { return !currSet.has(m); });

            // Proteção contra diffs absurdos (mais de 50% de mudança)
            var totalPrev = previousMembers.length;
            var changeRatio = totalPrev > 0 ? (newMembers.length + leftMembers.length) / totalPrev : 0;
            if (changeRatio > 0.5 && totalPrev > 10) {
              console.warn('[WHATSAPP] [DIFF] ' + groupName + ': Mudança suspeita (' + Math.round(changeRatio * 100) + '%). Verificando...');
              try {
                var freshData = await evoApi('GET', '/group/findGroupInfos/' + EVOLUTION_INSTANCE_NAME + '?groupJid=' + groupId);
                if (freshData && freshData.participants) {
                  currentParticipants = freshData.participants.map(function(p) {
                    var pid = typeof p === 'string' ? p : (p.id || p.jid || '');
                    return pid.split('@')[0];
                  }).filter(function(p) { return p && p.length > 0; });
                  memberCount = currentParticipants.length;
                  var freshCurrSet = new Set(currentParticipants);
                  newMembers = currentParticipants.filter(function(m) { return !prevSet.has(m); });
                  leftMembers = previousMembers.filter(function(m) { return !freshCurrSet.has(m); });
                }
              } catch (verifyErr) {
                console.warn('[WHATSAPP] [DIFF] Falha ao verificar ' + groupName + ': ' + verifyErr.message);
              }
            }

            if (newMembers.length > 0 || leftMembers.length > 0) {
              console.log('[WHATSAPP] [DIFF] ' + groupName + ': +' + newMembers.length + ' -' + leftMembers.length);
              totalNewJoins += newMembers.length;
              totalNewLeaves += leftMembers.length;

              for (var j = 0; j < newMembers.length; j++) {
                await recordMemberEvent(groupId, groupName, newMembers[j], 'join', 'diff');
              }
              for (var l = 0; l < leftMembers.length; l++) {
                await recordMemberEvent(groupId, groupName, leftMembers[l], 'leave', 'diff');
              }
            }
          }

          lastKnownMembers[groupId] = currentParticipants;
        }

        // Upsert no PostgreSQL
        await queryWithRetry(
          'INSERT INTO whatsapp_groups (id, group_name, current_members, max_members, invite_code, last_scanned) VALUES ($1, $2, $3, $4, $5, NOW()) ' +
          'ON CONFLICT (id) DO UPDATE SET group_name=$2, current_members=$3, max_members=GREATEST(whatsapp_groups.max_members, $4), invite_code=COALESCE($5, whatsapp_groups.invite_code), last_scanned=NOW()',
          [groupId, groupName, memberCount, maxMembers, inviteCode]
        );

        await saveSnapshotToDB(groupId, currentParticipants);
        groupNameCache[groupId] = { name: groupName, timestamp: Date.now() };

      } catch (err) {
        console.error('[WHATSAPP] Erro ao escanear grupo ' + groupId + ':', err.message);
      }

      // Throttle entre grupos
      if (i < groups.length - 1) {
        await new Promise(function(resolve) { setTimeout(resolve, 50); });
      }
    }

    var diffMsg = '';
    if (totalNewJoins > 0 || totalNewLeaves > 0) {
      diffMsg = ' | Diff: +' + totalNewJoins + ' -' + totalNewLeaves;
    }
    console.log('[WHATSAPP] Scan concluído (' + groups.length + ' grupos)' + diffMsg);

  } catch (err) {
    console.error('[WHATSAPP] Erro no scan:', err.message);
  }

  scanInProgress = false;
}

/**
 * Atualiza contagem de membros de um grupo específico
 */
async function updateGroupMemberCount(groupId) {
  try {
    if (!connectionStatus.ready) return;

    var data = await evoApi('GET', '/group/findGroupInfos/' + EVOLUTION_INSTANCE_NAME + '?groupJid=' + groupId);
    if (data && data.participants) {
      var memberCount = data.participants.length;
      var maxMembers = data.size || memberCount;
      if (maxMembers < memberCount) maxMembers = memberCount;

      await queryWithRetry(
        'INSERT INTO whatsapp_groups (id, group_name, current_members, max_members, last_scanned) VALUES ($1, $2, $3, $4, NOW()) ' +
        'ON CONFLICT (id) DO UPDATE SET group_name=$2, current_members=$3, max_members=GREATEST(whatsapp_groups.max_members, $4), last_scanned=NOW()',
        [groupId, data.subject || groupId, memberCount, maxMembers]
      );

      var members = data.participants.map(function(p) {
        var pid = typeof p === 'string' ? p : (p.id || p.jid || '');
        return pid.split('@')[0];
      }).filter(function(p) { return p && p.length > 0; });
      lastKnownMembers[groupId] = members;
      saveSnapshotToDB(groupId, members);
    }
  } catch (err) {
    console.warn('[WHATSAPP] Erro ao atualizar contagem de ' + groupId + ':', err.message);
  }
}

// ===== RECONEXÃO =====

function attemptReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error('[WHATSAPP] Máximo de tentativas de reconexão atingido.');
    connectionStatus.error = 'Máximo de tentativas de reconexão atingido. Use o botão Reiniciar.';
    return;
  }

  reconnectAttempts++;
  connectionStatus.reconnectAttempts = reconnectAttempts;

  var delay = Math.min(10000 * Math.pow(2, reconnectAttempts - 1), 300000);
  console.log('[WHATSAPP] Reconexão ' + reconnectAttempts + '/' + MAX_RECONNECT_ATTEMPTS + ' em ' + (delay / 1000) + 's...');

  setTimeout(async function() {
    if (connectionStatus.ready) return;
    try {
      await connectInstance();
    } catch (err) {
      console.error('[WHATSAPP] Falha ao reconectar:', err.message);
      attemptReconnect();
    }
  }, delay);
}

// ===== INICIALIZAÇÃO =====

/**
 * Inicializa o monitor WhatsApp via Evolution API
 */
function initialize(pgPool) {
  pool = pgPool;
  reconnectAttempts = 0;

  EVOLUTION_API_URL = (process.env.EVOLUTION_API_URL || 'http://localhost:8080').replace(/\/$/, '');
  EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';
  EVOLUTION_INSTANCE_NAME = process.env.EVOLUTION_INSTANCE_NAME || 'linkrotator';

  if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) {
    console.error('[WHATSAPP] EVOLUTION_API_URL e EVOLUTION_API_KEY são obrigatórios no .env');
    connectionStatus.error = 'Evolution API não configurada. Verifique o .env';
    return;
  }

  // Garante que as colunas necessárias existem
  Promise.all([
    pool.query('ALTER TABLE whatsapp_groups ADD COLUMN IF NOT EXISTS member_snapshot JSONB'),
    pool.query('ALTER TABLE member_events ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT \'realtime\''),
    pool.query('ALTER TABLE whatsapp_groups ADD COLUMN IF NOT EXISTS invite_code VARCHAR(255)')
  ]).then(async function() {
    console.log('[WHATSAPP] Colunas do banco verificadas');
    console.log('[WHATSAPP] Inicializando Evolution API...');
    console.log('[WHATSAPP] URL: ' + EVOLUTION_API_URL);
    console.log('[WHATSAPP] Instância: ' + EVOLUTION_INSTANCE_NAME);

    try {
      // Verifica se instância já existe
      var exists = await instanceExists();
      if (!exists) {
        await createInstance();
      } else {
        console.log('[WHATSAPP] Instância "' + EVOLUTION_INSTANCE_NAME + '" encontrada');
        // Reconfigura webhook para garantir que aponta para nosso servidor
        await configureWebhook();
      }

      // Verifica estado da conexão
      var state = await checkConnectionState();
      if (state !== 'open') {
        console.log('[WHATSAPP] Instância não conectada. Solicitando QR Code...');
        await connectInstance();
      }

      // Inicia poll periódico de conexão (backup para webhooks)
      startConnectionPoll();

    } catch (err) {
      console.error('[WHATSAPP] Erro ao inicializar Evolution API:', err.message);
      connectionStatus.error = 'Erro ao conectar com Evolution API: ' + err.message;
    }
  }).catch(function(err) {
    console.error('[WHATSAPP] Erro ao preparar colunas:', err.message);
  });
}

/**
 * Inicia polling periódico do estado da conexão
 */
function startConnectionPoll() {
  if (connectionPollTimer) clearInterval(connectionPollTimer);
  connectionPollTimer = setInterval(function() {
    checkConnectionState().catch(function(err) {
      console.warn('[WHATSAPP] Erro no poll de conexão:', err.message);
    });
  }, CONNECTION_POLL_INTERVAL);
}

// ===== API PÚBLICAS =====

function getStatus() {
  return Object.assign({}, connectionStatus, {
    retryQueueSize: eventRetryQueue.length,
    cachedGroups: Object.keys(groupNameCache).length,
    trackedGroups: Object.keys(lastKnownMembers).length,
    scanInterval: SCAN_INTERVAL / 1000 + 's',
    dedupWindowSize: Object.keys(recentEvents).length,
    evolutionApi: EVOLUTION_API_URL ? true : false,
    instanceName: EVOLUTION_INSTANCE_NAME
  });
}

function getQR() {
  return currentQRBase64 || currentQR;
}

/**
 * Solicita novo QR Code se não tem um disponível
 */
async function requestQR() {
  if (connectionStatus.ready) return null;
  if (currentQRBase64 || currentQR) return currentQRBase64 || currentQR;

  try {
    var exists = await instanceExists();
    if (!exists) {
      await createInstance();
    }
    await connectInstance();
    return currentQRBase64 || currentQR;
  } catch (err) {
    console.warn('[WHATSAPP] Erro ao solicitar QR:', err.message);
    return null;
  }
}

var groupsCache = { data: null, timestamp: 0 };
var GROUPS_CACHE_TTL = 60000;

/**
 * Retorna lista de grupos com formato CONSISTENTE
 */
async function getGroups() {
  if (groupsCache.data && (Date.now() - groupsCache.timestamp) < GROUPS_CACHE_TTL) {
    return groupsCache.data;
  }

  function formatGroup(id, name, members, maxMembers, lastScanned, inviteCode, isReadOnly) {
    return {
      id: id,
      name: name,
      groupName: name,
      participants: members,
      currentMembers: members,
      maxMembers: maxMembers || 1024,
      inviteCode: inviteCode || null,
      isReadOnly: isReadOnly || false,
      lastScanned: lastScanned ? { seconds: Math.floor(new Date(lastScanned).getTime() / 1000) } : null
    };
  }

  if (!connectionStatus.ready) {
    var result = await pool.query('SELECT * FROM whatsapp_groups ORDER BY group_name');
    var groups = result.rows.map(function(r) {
      return formatGroup(r.id, r.group_name, r.current_members, r.max_members, r.last_scanned, r.invite_code, false);
    });
    groupsCache = { data: groups, timestamp: Date.now() };
    return groups;
  }

  try {
    var allGroups = await fetchAllGroups();
    var result = [];

    for (var i = 0; i < allGroups.length; i++) {
      var g = allGroups[i];
      var gid = g.id || g.jid;
      var memberCount = 0;
      if (g.participants && Array.isArray(g.participants)) {
        memberCount = g.participants.length;
      } else {
        memberCount = g.size || 0;
      }
      var maxMembers = g.maxParticipants || g.size || memberCount;
      if (maxMembers < memberCount) maxMembers = memberCount;

      result.push(formatGroup(
        gid,
        g.subject || g.groupName || gid,
        memberCount,
        maxMembers,
        new Date(),
        g.inviteCode || null,
        g.announce || false
      ));
    }

    groupsCache = { data: result, timestamp: Date.now() };

    // Update PostgreSQL in background
    result.forEach(function(g) {
      pool.query(
        'INSERT INTO whatsapp_groups (id, group_name, current_members, max_members, invite_code, last_scanned) VALUES ($1, $2, $3, $4, $5, NOW()) ' +
        'ON CONFLICT (id) DO UPDATE SET group_name=$2, current_members=$3, max_members=GREATEST(whatsapp_groups.max_members, $4), invite_code=COALESCE($5, whatsapp_groups.invite_code), last_scanned=NOW()',
        [g.id, g.name, g.participants, g.maxMembers, g.inviteCode]
      ).catch(function() {});
    });

    return result;
  } catch (err) {
    try {
      var result = await pool.query('SELECT * FROM whatsapp_groups ORDER BY group_name');
      var groups = result.rows.map(function(r) {
        return formatGroup(r.id, r.group_name, r.current_members, r.max_members, r.last_scanned, r.invite_code, false);
      });
      return groups;
    } catch (e2) {
      throw new Error('Erro ao listar grupos: ' + err.message);
    }
  }
}

async function getGroupMembers(groupId) {
  if (!connectionStatus.ready) {
    throw new Error('WhatsApp não conectado');
  }

  try {
    var data = await evoApi('GET', '/group/findGroupInfos/' + EVOLUTION_INSTANCE_NAME + '?groupJid=' + groupId);
    if (!data || !data.participants) {
      throw new Error('Grupo não encontrado');
    }

    return {
      groupName: data.subject,
      totalMembers: data.participants.length,
      maxMembers: data.size || data.participants.length,
      participants: data.participants.map(function(p) {
        var pid = typeof p === 'string' ? p : (p.id || p.jid || '');
        var phone = pid.split('@')[0];
        return {
          id: pid,
          phone: '***' + phone.slice(-4),
          isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
          isSuperAdmin: p.admin === 'superadmin'
        };
      })
    };
  } catch (err) {
    throw new Error('Erro ao listar membros: ' + err.message);
  }
}

/**
 * Solicita Pairing Code para conectar pelo número de telefone
 */
async function requestPairingCode(phoneNumber) {
  phoneNumber = phoneNumber.replace(/[^0-9]/g, '');

  if (!phoneNumber || phoneNumber.length < 10) {
    throw new Error('Número inválido. Use formato com DDI: 5511999999999');
  }

  if (connectionStatus.ready) {
    throw new Error('WhatsApp já está conectado com o número ' + connectionStatus.phone);
  }

  console.log('[WHATSAPP] Solicitando pairing code via Evolution API para ' + phoneNumber + '...');

  try {
    // Primeiro garante que a instância existe
    var exists = await instanceExists();
    if (!exists) {
      await createInstance();
      // Aguarda a instância ser criada
      await new Promise(function(resolve) { setTimeout(resolve, 2000); });
    }

    // Verifica se já está conectada - se sim, precisa desconectar primeiro
    var state = await checkConnectionState();
    if (state === 'open') {
      throw new Error('WhatsApp já está conectado. Desconecte primeiro para conectar outro número.');
    }

    // Tenta via Evolution API v2 endpoint (POST com number no body)
    var code = null;
    var attempts = [
      // Tentativa 1: POST /instance/connect com number
      { method: 'POST', path: '/instance/connect/' + EVOLUTION_INSTANCE_NAME, body: { number: phoneNumber } },
      // Tentativa 2: GET /instance/connect com query param (alternativa)
      { method: 'GET', path: '/instance/connect/' + EVOLUTION_INSTANCE_NAME + '?number=' + phoneNumber, body: null }
    ];

    for (var i = 0; i < attempts.length; i++) {
      try {
        var attempt = attempts[i];
        var data = await evoApi(attempt.method, attempt.path, attempt.body);

        code = data.code || data.pairingCode;
        if (!code && data.instance) {
          code = data.instance.pairingCode || data.instance.code;
        }
        if (code) break;

        // Se veio QR em vez de pairing code, guarda o QR e tenta de novo
        if (data.base64 || data.qrcode) {
          var qrData = data.qrcode || data;
          currentQRBase64 = (typeof qrData === 'object' ? qrData.base64 : qrData) || data.base64;
          currentQR = data.code || currentQRBase64;
          console.log('[WHATSAPP] QR Code recebido ao invés de pairing code, tentando próximo método...');
          continue;
        }
      } catch (attemptErr) {
        console.warn('[WHATSAPP] Tentativa ' + (i + 1) + ' de pairing code falhou:', attemptErr.message);
        if (i === attempts.length - 1) throw attemptErr;
      }
    }

    if (code) {
      console.log('[WHATSAPP] Pairing code gerado: ' + code);
      // Limpa QR pois agora estamos esperando pairing
      currentQR = null;
      currentQRBase64 = null;
      return code;
    }

    throw new Error('Evolution API não retornou código de pareamento. Tente conectar via QR Code.');
  } catch (err) {
    console.error('[WHATSAPP] Erro ao gerar pairing code:', err.message);
    throw new Error(err.message || 'Erro ao gerar código de pareamento');
  }
}

// ===== ENVIO DE MENSAGENS =====

/**
 * Envia mensagem de texto via Evolution API
 * Substitui o antigo client.sendMessage()
 */
async function sendMessage(to, text, options) {
  if (!connectionStatus.ready) {
    throw new Error('WhatsApp não está conectado');
  }

  // Normaliza o destinatário
  var number = to;
  if (number.includes('@')) {
    number = number.split('@')[0];
  }

  // Determina se é grupo ou contato
  var isGroup = to.includes('@g.us');

  var body = {
    number: isGroup ? to : number,
    text: text
  };

  // Se tem opção de menção
  if (options && options.mentions && options.mentions.length > 0) {
    body.mentionsEveryOne = true;
  }

  return await evoApi('POST', '/message/sendText/' + EVOLUTION_INSTANCE_NAME, body);
}

/**
 * Busca código de convite de um grupo via Evolution API
 * Substitui o antigo client.getInviteCode()
 */
async function getInviteCode(groupId) {
  if (!connectionStatus.ready) {
    throw new Error('WhatsApp não está conectado');
  }

  var data = await evoApi('GET', '/group/inviteCode/' + EVOLUTION_INSTANCE_NAME + '?groupJid=' + groupId);
  return data.inviteCode || data.code || data;
}

// ===== HEALTH CHECK HELPERS =====

async function checkGroupExists(groupId) {
  if (!connectionStatus.ready) return null;
  try {
    var data = await evoApi('GET', '/group/findGroupInfos/' + EVOLUTION_INSTANCE_NAME + '?groupJid=' + groupId);
    if (data && data.subject) {
      return { exists: true, name: data.subject, participants: data.participants ? data.participants.length : 0 };
    }
    return { exists: false };
  } catch (err) {
    return { exists: false, error: err.message };
  }
}

async function checkInviteCode(inviteCode) {
  if (!connectionStatus.ready) return null;
  try {
    var data = await evoApi('GET', '/group/inviteInfo/' + EVOLUTION_INSTANCE_NAME + '?inviteCode=' + inviteCode);
    return { valid: true, groupName: data.subject, size: data.size };
  } catch (err) {
    var msg = (err.message || '').toLowerCase();
    if (msg.includes('invite') || msg.includes('revoked') || msg.includes('not found') || msg.includes('invalid') || msg.includes('not-authorized')) {
      return { valid: false, definitive: true, error: err.message };
    }
    return { valid: false, definitive: false, error: err.message };
  }
}

async function getLiveGroupIds() {
  if (!connectionStatus.ready) return null;
  try {
    var groups = await fetchAllGroups();
    return groups.map(function(g) { return g.id || g.jid; });
  } catch (err) {
    return null;
  }
}

/**
 * Reinicia a instância (desconecta e reconecta)
 */
async function restart() {
  console.log('[WHATSAPP] Reiniciando instância Evolution API...');
  connectionStatus.connected = false;
  connectionStatus.ready = false;
  connectionStatus.error = null;
  currentQR = null;
  currentQRBase64 = null;
  reconnectAttempts = 0;
  connectionStatus.reconnectAttempts = 0;
  scanInProgress = false;

  try {
    // Faz logout da instância
    await evoApi('DELETE', '/instance/logout/' + EVOLUTION_INSTANCE_NAME);
    console.log('[WHATSAPP] Logout realizado');
  } catch (err) {
    console.warn('[WHATSAPP] Aviso no logout:', err.message);
  }

  // Aguarda e reconecta
  await new Promise(function(resolve) { setTimeout(resolve, 2000); });

  try {
    await connectInstance();
    console.log('[WHATSAPP] Instância reiniciada. Use QR Code ou Pairing Code para conectar.');
  } catch (err) {
    console.error('[WHATSAPP] Erro ao reiniciar:', err.message);
    connectionStatus.error = 'Erro ao reiniciar: ' + err.message;
  }
}

/**
 * Desconecta sem excluir a instância
 */
async function disconnect() {
  console.log('[WHATSAPP] Desconectando...');
  connectionStatus.connected = false;
  connectionStatus.ready = false;
  currentQR = null;
  currentQRBase64 = null;
  scanInProgress = false;

  try {
    await evoApi('DELETE', '/instance/logout/' + EVOLUTION_INSTANCE_NAME);
  } catch (err) {
    console.warn('[WHATSAPP] Aviso no disconnect:', err.message);
  }
}

// Re-scan periódico
setInterval(function() {
  if (connectionStatus.ready) {
    scanGroupsWithDiff();
  }
}, SCAN_INTERVAL);

module.exports = {
  initialize: initialize,
  getStatus: getStatus,
  getQR: getQR,
  requestQR: requestQR,
  getGroups: getGroups,
  getGroupMembers: getGroupMembers,
  restart: restart,
  disconnect: disconnect,
  requestPairingCode: requestPairingCode,
  checkGroupExists: checkGroupExists,
  checkInviteCode: checkInviteCode,
  getLiveGroupIds: getLiveGroupIds,
  handleWebhook: handleWebhook,
  sendMessage: sendMessage,
  getInviteCode: getInviteCode
};
