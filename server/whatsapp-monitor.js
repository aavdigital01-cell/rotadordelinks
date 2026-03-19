/**
 * WhatsApp Group Monitor v4.0 - WAHA (WhatsApp HTTP API)
 * Monitora entradas/saídas de membros nos grupos via WAHA REST API
 * Usa WAHA + PostgreSQL
 *
 * Migração v4.0 (Evolution API → WAHA):
 * - Substitui Evolution API por WAHA (devlikeapro/waha)
 * - Eventos em tempo real via webhook (POST /api/whatsapp/webhook)
 * - QR Code via GET /api/{session}/auth/qr
 * - Scan periódico de grupos mantido (via REST)
 * - Mesma interface pública (initialize, getStatus, getGroups, etc.)
 * - Envio de mensagens via POST /api/sendText
 * - Gerenciamento de sessão automático (cria se não existir)
 */

const crypto = require('crypto');
const fetch = require('node-fetch');
var qrcodeTerminal = null;
try { qrcodeTerminal = require('qrcode-terminal'); } catch (e) { /* opcional */ }

var pool = null; // PostgreSQL pool
var currentQR = null;
var currentQRBase64 = null;
var reconnectAttempts = 0;
var MAX_RECONNECT_ATTEMPTS = 5;
var scanInProgress = false;

// WAHA API config (variáveis mantêm nomes do .env para compatibilidade)
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

/**
 * Exibe QR Code no terminal (PM2 logs)
 */
function displayQRInTerminal(qrText) {
  if (!qrText) return;
  // Se é base64 de imagem, não dá pra exibir no terminal
  if (qrText.startsWith('data:image')) {
    console.log('[WHATSAPP] QR Code recebido (base64 image) - visualize no painel admin');
    return;
  }
  if (qrcodeTerminal) {
    console.log('[WHATSAPP] ═══════════ QR CODE ═══════════');
    qrcodeTerminal.generate(qrText, { small: true }, function(qr) {
      console.log(qr);
    });
    console.log('[WHATSAPP] ═══════════════════════════════');
    console.log('[WHATSAPP] Escaneie o QR acima com seu WhatsApp');
  } else {
    console.log('[WHATSAPP] QR Code texto (instale qrcode-terminal para ver no terminal):');
    console.log('[WHATSAPP] ' + qrText.substring(0, 200));
  }
}

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
 * Faz chamada à WAHA API
 */
async function evoApi(method, path, body) {
  var url = EVOLUTION_API_URL + path;
  var options = {
    method: method,
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': EVOLUTION_API_KEY
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

// ===== WAHA SESSION MANAGEMENT =====

/**
 * Verifica se a sessão existe no WAHA
 */
async function instanceExists() {
  try {
    var data = await evoApi('GET', '/api/sessions');
    if (Array.isArray(data)) {
      return data.some(function(s) {
        return s.name === EVOLUTION_INSTANCE_NAME;
      });
    }
    return false;
  } catch (err) {
    console.error('[WHATSAPP] Erro ao verificar sessões:', err.message);
    return false;
  }
}

/**
 * Constrói URL do webhook para o WAHA
 */
async function getWebhookUrl() {
  var webhookUrl = (process.env.EVOLUTION_WEBHOOK_URL || '').trim();
  if (!webhookUrl) {
    // Se WAHA roda no mesmo host (Docker), usa IP bridge local
    var port = process.env.PORT || 3000;
    webhookUrl = 'http://172.17.0.1:' + port;
    console.log('[WHATSAPP] Usando IP Docker bridge para webhook: ' + webhookUrl);
  }
  return webhookUrl.replace(/\/$/, '') + '/api/whatsapp/webhook';
}

/**
 * Cria sessão no WAHA
 */
async function createInstance() {
  try {
    var webhookUrl = await getWebhookUrl();

    var body = {
      name: EVOLUTION_INSTANCE_NAME,
      start: true,
      config: {
        webhooks: [{
          url: webhookUrl,
          events: [
            'session.status',
            'group.v2.participants'
          ]
        }]
      }
    };

    console.log('[WHATSAPP] Criando sessão "' + EVOLUTION_INSTANCE_NAME + '" no WAHA...');
    console.log('[WHATSAPP] Webhook URL: ' + webhookUrl);
    var data = await evoApi('POST', '/api/sessions', body);
    console.log('[WHATSAPP] Sessão criada com sucesso');
    return data;
  } catch (err) {
    var msg = (err.message || '').toLowerCase();
    if (msg.includes('already') || msg.includes('exists') || msg.includes('conflict')) {
      console.log('[WHATSAPP] Sessão já existe. Tentando iniciar...');
      try {
        await evoApi('POST', '/api/sessions/' + EVOLUTION_INSTANCE_NAME + '/start', {});
        return null;
      } catch (startErr) {
        console.warn('[WHATSAPP] Aviso ao iniciar sessão:', startErr.message);
        return null;
      }
    }
    throw err;
  }
}

/**
 * Remove sessão do WAHA
 */
async function deleteInstance() {
  try {
    await evoApi('DELETE', '/api/sessions/' + EVOLUTION_INSTANCE_NAME);
    console.log('[WHATSAPP] Sessão "' + EVOLUTION_INSTANCE_NAME + '" removida');
  } catch (err) {
    try {
      await evoApi('POST', '/api/sessions/' + EVOLUTION_INSTANCE_NAME + '/logout', {});
    } catch (e) {}
    console.warn('[WHATSAPP] Aviso ao remover sessão:', err.message);
  }
}

/**
 * Configura webhook da sessão existente via PUT
 */
async function configureWebhook() {
  var webhookUrl = await getWebhookUrl();
  try {
    await evoApi('PUT', '/api/sessions/' + EVOLUTION_INSTANCE_NAME, {
      config: {
        webhooks: [{
          url: webhookUrl,
          events: ['session.status', 'group.v2.participants']
        }]
      }
    });
    console.log('[WHATSAPP] Webhook configurado: ' + webhookUrl);
  } catch (err) {
    console.warn('[WHATSAPP] Aviso ao configurar webhook:', err.message);
  }
}

/**
 * Verifica estado da conexão via WAHA
 * WAHA status: STOPPED, STARTING, SCAN_QR_CODE, WORKING, FAILED
 */
async function checkConnectionState() {
  try {
    var data = await evoApi('GET', '/api/sessions/' + EVOLUTION_INSTANCE_NAME);
    var wahaStatus = data.status || 'STOPPED';

    // Mapeia status WAHA para estados internos
    if (wahaStatus === 'WORKING') {
      if (!connectionStatus.ready) {
        connectionStatus.connected = true;
        connectionStatus.ready = true;
        connectionStatus.error = null;
        reconnectAttempts = 0;
        connectionStatus.reconnectAttempts = 0;
        currentQR = null;
        currentQRBase64 = null;
        console.log('[WHATSAPP] Conexão ativa (WAHA)');

        // Busca info do número conectado
        try {
          var me = await evoApi('GET', '/api/sessions/' + EVOLUTION_INSTANCE_NAME + '/me');
          if (me && me.id) {
            connectionStatus.phone = me.id.split('@')[0].split(':')[0];
            console.log('[WHATSAPP] Número conectado: ' + connectionStatus.phone);
          }
        } catch (e) {}

        // Carrega snapshots e faz scan inicial
        await loadSnapshotsFromDB();
        await scanGroupsWithDiff();
      }
      return 'open';
    } else if (wahaStatus === 'SCAN_QR_CODE' || wahaStatus === 'STARTING') {
      connectionStatus.connected = false;
      connectionStatus.ready = false;
      connectionStatus.error = wahaStatus === 'SCAN_QR_CODE' ? 'Aguardando QR Code...' : 'Iniciando...';
      return 'connecting';
    } else {
      connectionStatus.connected = false;
      connectionStatus.ready = false;
      if (!connectionStatus.error || connectionStatus.error === 'Conectando...' || connectionStatus.error === 'Iniciando...') {
        connectionStatus.error = 'Desconectado. Conecte pelo painel.';
      }
      return 'close';
    }
  } catch (err) {
    console.error('[WHATSAPP] Erro ao verificar conexão:', err.message);
    return 'close';
  }
}

/**
 * Solicita QR Code via WAHA (GET /api/{session}/auth/qr)
 */
async function connectInstance() {
  try {
    var data = await evoApi('GET', '/api/' + EVOLUTION_INSTANCE_NAME + '/auth/qr');
    console.log('[WHATSAPP] QR response: ' + JSON.stringify(data).substring(0, 500));

    // WAHA retorna: { value: "qr-text", mimetype: "image/png", data: "base64..." }
    if (data && data.value) {
      currentQR = data.value;
      if (data.data) {
        currentQRBase64 = 'data:' + (data.mimetype || 'image/png') + ';base64,' + data.data;
      }
      console.log('[WHATSAPP] QR Code obtido via WAHA');
      displayQRInTerminal(data.value);
      return data;
    }

    // Fallback: tenta extrair de outros formatos
    var found = extractQRFromResponse(data, 'connect');
    if (!found && !(currentQRBase64 || currentQR)) {
      // Polling: tenta a cada 2s por até 10 segundos (QR pode demorar)
      console.log('[WHATSAPP] QR não disponível ainda. Polling...');
      for (var attempt = 0; attempt < 5; attempt++) {
        await new Promise(function(r) { setTimeout(r, 2000); });
        if (currentQRBase64 || currentQR) {
          console.log('[WHATSAPP] QR recebido (tentativa ' + (attempt + 1) + ')');
          return data;
        }
        try {
          var retryData = await evoApi('GET', '/api/' + EVOLUTION_INSTANCE_NAME + '/auth/qr');
          if (retryData && retryData.value) {
            currentQR = retryData.value;
            if (retryData.data) {
              currentQRBase64 = 'data:' + (retryData.mimetype || 'image/png') + ';base64,' + retryData.data;
            }
            console.log('[WHATSAPP] QR Code obtido no poll ' + (attempt + 1));
            displayQRInTerminal(retryData.value);
            return retryData;
          }
        } catch (retryErr) {
          // Ignora erros no polling
        }
      }
      console.log('[WHATSAPP] QR não recebido após polling.');
    }

    return data;
  } catch (err) {
    var errMsg = (err.message || '').toLowerCase();
    if (errMsg.includes('not exist') || errMsg.includes('not found') || errMsg.includes('404')) {
      console.log('[WHATSAPP] Sessão não encontrada no auth/qr:', err.message);
      throw err;
    }
    if (errMsg.includes('already') || errMsg.includes('working')) {
      console.log('[WHATSAPP] Já está conectado');
      await checkConnectionState();
      return null;
    }
    throw err;
  }
}

/**
 * Extrai QR Code de qualquer formato de resposta da Evolution API (v1/v2)
 */
function extractQRFromResponse(data, source) {
  if (!data) return false;

  // Formato 1: { base64: "...", code: "..." } (direto no root)
  if (data.base64) {
    currentQRBase64 = data.base64;
    currentQR = data.code || data.base64;
    console.log('[WHATSAPP] QR Code extraído (' + source + '): base64 direto');
    displayQRInTerminal(data.code || data.base64);
    return true;
  }

  // Formato 2: { qrcode: { base64: "...", code: "..." } } (Evolution API v2)
  if (data.qrcode) {
    var qr = typeof data.qrcode === 'object' ? data.qrcode : { base64: data.qrcode };
    currentQRBase64 = qr.base64 || null;
    currentQR = qr.code || qr.base64 || null;
    if (currentQRBase64 || currentQR) {
      console.log('[WHATSAPP] QR Code extraído (' + source + '): qrcode object');
      displayQRInTerminal(qr.code || qr.base64);
      return true;
    }
  }

  // Formato 3: { code: "..." } (texto do QR)
  if (data.code && typeof data.code === 'string' && data.code.length > 20) {
    currentQR = data.code;
    console.log('[WHATSAPP] QR Code extraído (' + source + '): code text');
    displayQRInTerminal(data.code);
    return true;
  }

  // Formato 4: { instance: { qrcode: {...} } } (wrapper da Evolution API)
  if (data.instance && data.instance.qrcode) {
    var iqr = typeof data.instance.qrcode === 'object' ? data.instance.qrcode : { base64: data.instance.qrcode };
    currentQRBase64 = iqr.base64 || null;
    currentQR = iqr.code || iqr.base64 || null;
    if (currentQRBase64 || currentQR) {
      console.log('[WHATSAPP] QR Code extraído (' + source + '): instance.qrcode');
      displayQRInTerminal(iqr.code || iqr.base64);
      return true;
    }
  }

  if (data.pairingCode) {
    console.log('[WHATSAPP] Pairing code retornado ao invés de QR (' + source + ')');
    return false;
  }

  console.log('[WHATSAPP] Nenhum QR encontrado na resposta (' + source + '):', JSON.stringify(data).substring(0, 300));
  return false;
}

// ===== WEBHOOK HANDLER =====

/**
 * Processa eventos recebidos via webhook da Evolution API
 * Chamado pela rota POST /api/whatsapp/webhook no index.js
 */
async function handleWebhook(body) {
  if (!body || !body.event) return;

  var event = body.event;
  var data = body.payload || body.data || body;
  var session = body.session || body.instanceName || null;

  // Log completo do payload para diagnóstico
  console.log('[WHATSAPP] [WEBHOOK] PAYLOAD event=' + event + ' session=' + session + ' data=' + JSON.stringify(data).substring(0, 500));

  // Ignora eventos de outras sessões
  if (session && session !== EVOLUTION_INSTANCE_NAME) return;

  try {
    switch (event) {
      case 'session.status':
        // WAHA: payload.status = STOPPED, STARTING, SCAN_QR_CODE, WORKING, FAILED
        var wahaStatus = data.status || (data.payload && data.payload.status);
        console.log('[WHATSAPP] [WEBHOOK] Status da sessão: ' + wahaStatus);

        if (wahaStatus === 'WORKING') {
          connectionStatus.connected = true;
          connectionStatus.ready = true;
          connectionStatus.error = null;
          currentQR = null;
          currentQRBase64 = null;
          reconnectAttempts = 0;
          connectionStatus.reconnectAttempts = 0;

          // Extrai número do campo me
          if (body.me && body.me.id) {
            connectionStatus.phone = body.me.id.split('@')[0].split(':')[0];
          }
          console.log('[WHATSAPP] Conectado! Número: ' + connectionStatus.phone);

          // Scan inicial
          setTimeout(async function() {
            await loadSnapshotsFromDB();
            await scanGroupsWithDiff();
          }, 3000);

        } else if (wahaStatus === 'SCAN_QR_CODE') {
          connectionStatus.connected = false;
          connectionStatus.ready = false;
          connectionStatus.error = 'Aguardando QR Code...';

          // Busca QR automaticamente quando WAHA sinaliza que precisa
          try {
            var qrData = await evoApi('GET', '/api/' + EVOLUTION_INSTANCE_NAME + '/auth/qr');
            if (qrData && qrData.value) {
              currentQR = qrData.value;
              if (qrData.data) {
                currentQRBase64 = 'data:' + (qrData.mimetype || 'image/png') + ';base64,' + qrData.data;
              }
              console.log('[WHATSAPP] [WEBHOOK] QR Code obtido');
              displayQRInTerminal(qrData.value);
            }
          } catch (qrErr) {
            console.warn('[WHATSAPP] Erro ao buscar QR:', qrErr.message);
          }

        } else if (wahaStatus === 'STOPPED' || wahaStatus === 'FAILED') {
          connectionStatus.connected = false;
          connectionStatus.ready = false;
          connectionStatus.lastDisconnect = new Date().toISOString();
          connectionStatus.error = wahaStatus === 'FAILED'
            ? 'Erro na sessão. Reconecte pelo painel.'
            : 'Desconectado. Conecte pelo painel.';
          if (wahaStatus === 'FAILED') {
            attemptReconnect();
          }
        }
        break;

      case 'group.v2.participants':
        // WAHA: participantes de grupo (join/leave)
        await handleGroupParticipantsUpdate(data);
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
 * Atualiza contagem de membros de um grupo no banco de dados
 */
async function updateGroupMemberCount(groupId) {
  try {
    if (!connectionStatus.ready) return;
    var data = await evoApi('GET', '/api/' + EVOLUTION_INSTANCE_NAME + '/groups/' + groupId);
    // WAHA: participantes podem vir no grupo ou precisar de chamada separada
    var participants = data && data.participants;
    if (!participants) {
      try {
        var pData = await evoApi('GET', '/api/' + EVOLUTION_INSTANCE_NAME + '/groups/' + groupId + '/participants/v2');
        participants = pData;
      } catch (e) {}
    }
    if (participants && Array.isArray(participants)) {
      var count = participants.length;
      await pool.query(
        'UPDATE whatsapp_groups SET current_members=$1, last_scanned=NOW() WHERE id=$2',
        [count, groupId]
      );
    }
  } catch (err) {
    console.warn('[WHATSAPP] Erro ao atualizar contagem de membros do grupo ' + groupId + ':', err.message);
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
      var data = await evoApi('GET', '/api/' + EVOLUTION_INSTANCE_NAME + '/groups/' + groupId);
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
  var data = await evoApi('GET', '/api/' + EVOLUTION_INSTANCE_NAME + '/groups');
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
                var freshData = await evoApi('GET', '/api/' + EVOLUTION_INSTANCE_NAME + '/groups/' + groupId);
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

    var data = await evoApi('GET', '/api/' + EVOLUTION_INSTANCE_NAME + '/groups/' + groupId);
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

  EVOLUTION_API_URL = (process.env.EVOLUTION_API_URL || 'http://localhost:8085').replace(/\/$/, '');
  EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';
  EVOLUTION_INSTANCE_NAME = process.env.EVOLUTION_INSTANCE_NAME || 'default';

  if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) {
    console.error('[WHATSAPP] EVOLUTION_API_URL e EVOLUTION_API_KEY são obrigatórios no .env');
    connectionStatus.error = 'WAHA API não configurada. Verifique o .env';
    return;
  }

  // Garante que as colunas necessárias existem
  Promise.all([
    pool.query('ALTER TABLE whatsapp_groups ADD COLUMN IF NOT EXISTS member_snapshot JSONB'),
    pool.query('ALTER TABLE member_events ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT \'realtime\''),
    pool.query('ALTER TABLE whatsapp_groups ADD COLUMN IF NOT EXISTS invite_code VARCHAR(255)')
  ]).then(async function() {
    console.log('[WHATSAPP] Colunas do banco verificadas');
    console.log('[WHATSAPP] Inicializando WAHA...');
    console.log('[WHATSAPP] URL: ' + EVOLUTION_API_URL);
    console.log('[WHATSAPP] Sessão: ' + EVOLUTION_INSTANCE_NAME);

    try {
      // Verifica se instância já existe
      var exists = await instanceExists();
      if (!exists) {
        await createInstance();
      } else {
        console.log('[WHATSAPP] Sessão "' + EVOLUTION_INSTANCE_NAME + '" encontrada');
        // Reconfigura webhook para garantir que aponta para nosso servidor
        await configureWebhook();
      }

      // Verifica estado da conexão
      var state = await checkConnectionState();
      if (state !== 'open') {
        // Se a instância não responde (404), pode ser fantasma - tenta recriar
        try {
          console.log('[WHATSAPP] Instância não conectada. Solicitando QR Code...');
          await connectInstance();
        } catch (connectErr) {
          var connectMsg = (connectErr.message || '').toLowerCase();
          if (connectMsg.includes('not exist') || connectMsg.includes('not found') || connectMsg.includes('404')) {
            console.log('[WHATSAPP] Instância não existe no runtime. Recriando...');
            await deleteInstance();
            await new Promise(function(r) { setTimeout(r, 2000); });
            await createInstance();
            state = await checkConnectionState();
            if (state !== 'open') {
              await connectInstance();
            }
          } else {
            throw connectErr;
          }
        }
      }

      // Inicia poll periódico de conexão (backup para webhooks)
      startConnectionPoll();

    } catch (err) {
      console.error('[WHATSAPP] Erro ao inicializar WAHA:', err.message);
      connectionStatus.error = 'Erro ao conectar com WAHA: ' + err.message;
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
    wahaApi: EVOLUTION_API_URL ? true : false,
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
      console.log('[WHATSAPP] requestQR: instância não existe, criando...');
      await createInstance();
    }

    // Se createInstance já trouxe QR, retorna
    if (currentQRBase64 || currentQR) return currentQRBase64 || currentQR;

    try {
      await connectInstance();
    } catch (connectErr) {
      var msg = (connectErr.message || '').toLowerCase();
      if (msg.includes('not exist') || msg.includes('not found') || msg.includes('404')) {
        // Instância fantasma — deletar e recriar
        console.log('[WHATSAPP] requestQR: instância fantasma detectada, recriando...');
        await deleteInstance();
        await new Promise(function(r) { setTimeout(r, 2000); });
        await createInstance();
        if (currentQRBase64 || currentQR) return currentQRBase64 || currentQR;
        await connectInstance();
      } else {
        throw connectErr;
      }
    }

    return currentQRBase64 || currentQR;
  } catch (err) {
    console.warn('[WHATSAPP] Erro ao solicitar QR:', err.message);
    connectionStatus.error = 'Erro ao gerar QR: ' + err.message;
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
    var data = await evoApi('GET', '/api/' + EVOLUTION_INSTANCE_NAME + '/groups/' + groupId);
    if (!data) {
      throw new Error('Grupo não encontrado');
    }

    // WAHA: busca participantes separadamente se não vieram no grupo
    var participants = data.participants;
    if (!participants) {
      try {
        participants = await evoApi('GET', '/api/' + EVOLUTION_INSTANCE_NAME + '/groups/' + groupId + '/participants/v2');
      } catch (e) {
        participants = [];
      }
    }

    return {
      groupName: data.subject,
      totalMembers: Array.isArray(participants) ? participants.length : 0,
      maxMembers: data.size || (Array.isArray(participants) ? participants.length : 0),
      participants: (Array.isArray(participants) ? participants : []).map(function(p) {
        var pid = typeof p === 'string' ? p : (p.id || p.jid || '');
        var phone = pid.split('@')[0];
        return {
          id: pid,
          phone: '***' + phone.slice(-4),
          isAdmin: p.admin === 'admin' || p.admin === 'superadmin' || p.role === 'admin',
          isSuperAdmin: p.admin === 'superadmin' || p.role === 'superadmin'
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

  console.log('[WHATSAPP] Solicitando pairing code via WAHA para ' + phoneNumber + '...');

  try {
    var exists = await instanceExists();
    if (!exists) {
      await createInstance();
      await new Promise(function(resolve) { setTimeout(resolve, 2000); });
    }

    var state = await checkConnectionState();
    if (state === 'open') {
      throw new Error('WhatsApp já está conectado. Desconecte primeiro para conectar outro número.');
    }

    // WAHA: POST /api/{session}/auth/request-code
    var data = await evoApi('POST', '/api/' + EVOLUTION_INSTANCE_NAME + '/auth/request-code', {
      phoneNumber: phoneNumber
    });

    var code = data.code || data.pairingCode;
    if (code) {
      console.log('[WHATSAPP] Pairing code gerado: ' + code);
      currentQR = null;
      currentQRBase64 = null;
      return code;
    }

    throw new Error('WAHA não retornou código de pareamento. Tente conectar via QR Code.');
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
    session: EVOLUTION_INSTANCE_NAME,
    chatId: isGroup ? to : number,
    text: text
  };

  // Se tem opção de menção
  if (options && options.mentions && options.mentions.length > 0) {
    body.mentions = options.mentions;
  }

  return await evoApi('POST', '/api/sendText', body);
}

/**
 * Busca código de convite de um grupo via Evolution API
 * Substitui o antigo client.getInviteCode()
 */
async function getInviteCode(groupId) {
  if (!connectionStatus.ready) {
    throw new Error('WhatsApp não está conectado');
  }

  var data = await evoApi('GET', '/api/' + EVOLUTION_INSTANCE_NAME + '/groups/' + groupId + '/invite-code');
  return data.inviteCode || data.code || data;
}

// ===== HEALTH CHECK HELPERS =====

async function checkGroupExists(groupId) {
  if (!connectionStatus.ready) return null;
  try {
    var data = await evoApi('GET', '/api/' + EVOLUTION_INSTANCE_NAME + '/groups/' + groupId);
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
    var data = await evoApi('GET', '/api/' + EVOLUTION_INSTANCE_NAME + '/groups/join-info?code=' + inviteCode);
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
    await evoApi('POST', '/api/sessions/' + EVOLUTION_INSTANCE_NAME + '/logout', {});
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
    await evoApi('POST', '/api/sessions/' + EVOLUTION_INSTANCE_NAME + '/logout', {});
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
