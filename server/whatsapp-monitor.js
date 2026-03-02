/**
 * WhatsApp Group Monitor
 * Monitora entradas/saídas de membros nos grupos
 * Usa @whiskeysockets/baileys (mesma lib da Evolution API) + PostgreSQL
 * Suporta conexão por Pairing Code (número de telefone) e QR Code
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

var sock = null;
var pool = null; // PostgreSQL pool
var currentQR = null;
var reconnectAttempts = 0;
var MAX_RECONNECT_ATTEMPTS = 5;
var authState = null;
var saveCreds = null;
var pairingCodeRequested = false;
var pendingPairingPhone = null;

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

// Logger silencioso para Baileys (evita spam no console)
var logger = pino({ level: 'silent' });

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
      await pool.query(item.sql, item.params);
      console.log('[WHATSAPP] Evento pendente salvo com sucesso: ' + item.description);
    } catch (err) {
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

// Processa fila de retry periodicamente
setInterval(processRetryQueue, RETRY_INTERVAL);

/**
 * Salva evento no DB com fallback para fila de retry
 */
async function saveEventSafe(sql, params, description) {
  try {
    await queryWithRetry(sql, params, 2);
  } catch (err) {
    console.error('[WHATSAPP] Falha ao salvar evento, adicionando à fila: ' + description + ' - ' + err.message);
    eventRetryQueue.push({ sql: sql, params: params, description: description, attempts: 1 });
  }
}

/**
 * Cria o socket Baileys e configura todos os eventos
 */
async function createSocket() {
  var { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version: version,
    auth: {
      creds: authState.creds,
      keys: makeCacheableSignalKeyStore(authState.keys, logger)
    },
    logger: logger,
    printQRInTerminal: false,
    browser: ['LinkRotator Pro', 'Chrome', '120.0.0'],
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    markOnlineOnConnect: false
  });

  // Salva credenciais sempre que atualizarem
  sock.ev.on('creds.update', saveCreds);

  // Evento de conexão
  sock.ev.on('connection.update', function(update) {
    var connection = update.connection;
    var lastDisconnect = update.lastDisconnect;
    var qr = update.qr;

    // QR Code recebido
    if (qr && !pairingCodeRequested) {
      currentQR = qr;
      console.log('');
      console.log('[WHATSAPP] Escaneie o QR Code abaixo com seu WhatsApp:');
      console.log('');
      qrcode.generate(qr, { small: true });
      console.log('');
      console.log('[WHATSAPP] Ou use o painel para conectar pelo número de telefone');
    }

    // Conexão aberta
    if (connection === 'open') {
      connectionStatus.connected = true;
      connectionStatus.ready = true;
      connectionStatus.error = null;
      currentQR = null;
      reconnectAttempts = 0;
      connectionStatus.reconnectAttempts = 0;
      pairingCodeRequested = false;
      pendingPairingPhone = null;

      // Extrai número do telefone
      var me = sock.user;
      if (me) {
        connectionStatus.phone = me.id.split(':')[0].split('@')[0];
      }
      console.log('[WHATSAPP] Conectado! Número: ' + connectionStatus.phone);

      // Scan inicial dos grupos
      setTimeout(function() {
        scanGroupsWithDiff();
      }, 3000);
    }

    // Conexão fechou
    if (connection === 'close') {
      connectionStatus.connected = false;
      connectionStatus.ready = false;
      connectionStatus.lastDisconnect = new Date().toISOString();
      sock = null;

      var statusCode = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
        ? lastDisconnect.error.output.statusCode
        : null;

      // 401 = logout, precisa escanear novamente
      if (statusCode === DisconnectReason.loggedOut) {
        console.log('[WHATSAPP] Deslogado. Necessário reconectar.');
        connectionStatus.error = 'Desconectado. Conecte novamente pelo painel.';
        // Limpa sessão para forçar novo QR/pairing
        var fs = require('fs');
        try { fs.rmSync('./whatsapp-session', { recursive: true, force: true }); } catch(e) {}
        // Re-inicializa para gerar novo QR
        setTimeout(function() { initializeSocket(); }, 2000);
      }
      // 408 = timeout, 428 = rate limit, 500+ = erro servidor
      else if (statusCode !== DisconnectReason.loggedOut) {
        var reason = lastDisconnect && lastDisconnect.error ? lastDisconnect.error.message : 'desconhecido';
        console.log('[WHATSAPP] Desconectado. Motivo: ' + reason + ' (código: ' + statusCode + ')');
        connectionStatus.error = reason;
        attemptReconnect();
      }
    }
  });

  // Evento de participantes no grupo (join, leave, promote, demote)
  sock.ev.on('group-participants.update', async function(update) {
    try {
      var groupId = update.id;
      var participants = update.participants; // Array de JIDs
      var action = update.action; // 'add', 'remove', 'promote', 'demote'

      if (action !== 'add' && action !== 'remove') return;

      var groupName = await getGroupName(groupId);
      var eventAction = action === 'add' ? 'join' : 'leave';

      console.log('[WHATSAPP] ' + participants.length + ' membro(s) ' + (action === 'add' ? 'entrou(ram)' : 'saiu(ram)') + ' do grupo ' + groupName);

      for (var i = 0; i < participants.length; i++) {
        var memberPhone = participants[i].split('@')[0];

        await saveEventSafe(
          'INSERT INTO member_events (whatsapp_group_id, group_name, phone, phone_partial, action) VALUES ($1, $2, $3, $4, $5)',
          [groupId, groupName, hashPhone(memberPhone), memberPhone.slice(-4), eventAction],
          eventAction + ':' + memberPhone.slice(-4) + '@' + groupName
        );

        if (action === 'add') {
          // Alerta
          await saveEventSafe(
            'INSERT INTO alerts (type, whatsapp_group_id, group_name, member_phone, message) VALUES ($1, $2, $3, $4, $5)',
            ['member_joined', groupId, groupName, '***' + memberPhone.slice(-4), 'Novo membro entrou no grupo ' + groupName],
            'alert:join:' + memberPhone.slice(-4)
          );

          // Backup lead contact
          if (memberPhone && memberPhone !== 'desconhecido') {
            await saveEventSafe(
              'INSERT INTO lead_contacts (phone, whatsapp_group_id, group_name, joined_at, is_active) VALUES ($1, $2, $3, NOW(), true) ' +
              'ON CONFLICT (phone, whatsapp_group_id) DO UPDATE SET is_active=true, left_at=NULL, joined_at=NOW()',
              [memberPhone, groupId, groupName],
              'lead:join:' + memberPhone.slice(-4)
            );
          }
        } else {
          // Mark lead as inactive
          if (memberPhone && memberPhone !== 'desconhecido') {
            await saveEventSafe(
              'UPDATE lead_contacts SET is_active=false, left_at=NOW() WHERE phone=$1 AND whatsapp_group_id=$2',
              [memberPhone, groupId],
              'lead:leave:' + memberPhone.slice(-4)
            );
          }
        }
      }

      // Atualiza contagem de membros
      await updateGroupMemberCount(groupId);

    } catch (err) {
      console.error('[WHATSAPP] Erro ao registrar evento de grupo:', err.message);
    }
  });

  // Evento de atualização de grupo (nome, descrição, etc.)
  sock.ev.on('groups.update', async function(updates) {
    for (var update of updates) {
      try {
        var groupId = update.id;
        console.log('[WHATSAPP] Atualização no grupo ' + groupId);

        // Force refresh do nome
        await getGroupName(groupId, true);
        await updateGroupMemberCount(groupId);
      } catch (err) {
        console.error('[WHATSAPP] Erro ao processar atualização do grupo:', err.message);
      }
    }
  });

  return sock;
}

/**
 * Inicializa o auth state e cria o socket
 */
async function initializeSocket() {
  try {
    var auth = await useMultiFileAuthState('./whatsapp-session');
    authState = auth.state;
    saveCreds = auth.saveCreds;
    await createSocket();
  } catch (err) {
    console.error('[WHATSAPP] Erro ao inicializar socket:', err.message);
    connectionStatus.error = err.message;
  }
}

/**
 * Inicializa o monitor WhatsApp
 */
function initialize(pgPool) {
  pool = pgPool;
  reconnectAttempts = 0;
  pairingCodeRequested = false;

  console.log('[WHATSAPP] Inicializando cliente Baileys...');
  initializeSocket();
}

/**
 * Solicita Pairing Code para conectar pelo número de telefone
 * O usuário recebe um código no WhatsApp que deve digitar no app
 * @param {string} phoneNumber - Número com DDI, ex: 5511999999999
 * @returns {string} Código de pareamento (8 dígitos)
 */
async function requestPairingCode(phoneNumber) {
  // Limpa formatação - só números
  phoneNumber = phoneNumber.replace(/[^0-9]/g, '');

  if (!phoneNumber || phoneNumber.length < 10) {
    throw new Error('Número inválido. Use formato com DDI: 5511999999999');
  }

  // Se já está conectado, não precisa parear
  if (connectionStatus.ready) {
    throw new Error('WhatsApp já está conectado com o número ' + connectionStatus.phone);
  }

  console.log('[WHATSAPP] Solicitando pairing code para ' + phoneNumber + '...');

  // Se o socket não existe ainda, cria
  if (!sock) {
    pairingCodeRequested = true;
    pendingPairingPhone = phoneNumber;
    await initializeSocket();

    // Aguarda socket ficar pronto para solicitar o código
    await new Promise(function(resolve) { setTimeout(resolve, 3000); });
  }

  if (!sock) {
    throw new Error('Erro ao inicializar conexão. Tente novamente.');
  }

  // Marca que estamos usando pairing code (não mostra QR)
  pairingCodeRequested = true;
  currentQR = null;

  try {
    var code = await sock.requestPairingCode(phoneNumber);
    console.log('[WHATSAPP] Pairing code gerado: ' + code);
    console.log('[WHATSAPP] Instrução: Abra WhatsApp > Aparelhos Conectados > Conectar Dispositivo > Conectar com Número de Telefone');
    return code;
  } catch (err) {
    pairingCodeRequested = false;
    console.error('[WHATSAPP] Erro ao gerar pairing code:', err.message);

    if (err.message.includes('already')) {
      throw new Error('Já existe uma sessão ativa. Clique em "Desconectar" primeiro.');
    }
    throw new Error('Erro ao gerar código: ' + err.message);
  }
}

/**
 * Reconexão com backoff exponencial
 */
function attemptReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error('[WHATSAPP] Máximo de tentativas de reconexão atingido (' + MAX_RECONNECT_ATTEMPTS + '). Reinicie manualmente.');
    connectionStatus.error = 'Máximo de tentativas de reconexão atingido. Use o botão Reiniciar.';
    return;
  }

  reconnectAttempts++;
  connectionStatus.reconnectAttempts = reconnectAttempts;

  var delay = Math.min(10000 * Math.pow(2, reconnectAttempts - 1), 300000);
  console.log('[WHATSAPP] Tentativa de reconexão ' + reconnectAttempts + '/' + MAX_RECONNECT_ATTEMPTS + ' em ' + (delay / 1000) + 's...');

  setTimeout(async function() {
    if (connectionStatus.ready) return;

    console.log('[WHATSAPP] Tentando reconectar (tentativa ' + reconnectAttempts + ')...');
    try {
      await initializeSocket();
    } catch (err) {
      console.error('[WHATSAPP] Falha ao reconectar:', err.message);
      attemptReconnect();
    }
  }, delay);
}

/**
 * Busca nome de um grupo (com cache e TTL)
 */
async function getGroupName(groupId, forceRefresh) {
  var cached = groupNameCache[groupId];
  if (cached && !forceRefresh && (Date.now() - cached.timestamp) < GROUP_NAME_CACHE_TTL) {
    return cached.name;
  }

  try {
    if (sock) {
      var metadata = await sock.groupMetadata(groupId);
      if (metadata && metadata.subject) {
        groupNameCache[groupId] = { name: metadata.subject, timestamp: Date.now() };
        return metadata.subject;
      }
    }
  } catch (err) {
    if (cached) return cached.name;
  }
  return groupId;
}

/**
 * Faz scan de todos os grupos COM detecção de diferenças
 */
async function scanGroupsWithDiff() {
  try {
    if (!sock) return;

    var groups = await sock.groupFetchAllParticipating();
    var groupIds = Object.keys(groups);

    console.log('[WHATSAPP] Encontrados ' + groupIds.length + ' grupos');

    for (var i = 0; i < groupIds.length; i++) {
      var groupId = groupIds[i];
      var group = groups[groupId];

      try {
        var groupName = group.subject || groupId;
        var currentParticipants = (group.participants || []).map(function(p) {
          return p.id.split('@')[0];
        });
        var memberCount = currentParticipants.length;

        // Detecta diferenças com snapshot anterior
        var previousMembers = lastKnownMembers[groupId];
        if (previousMembers && previousMembers.length > 0 && currentParticipants.length > 0) {
          var newMembers = currentParticipants.filter(function(m) {
            return previousMembers.indexOf(m) === -1;
          });
          var leftMembers = previousMembers.filter(function(m) {
            return currentParticipants.indexOf(m) === -1;
          });

          if (newMembers.length > 0 || leftMembers.length > 0) {
            console.log('[WHATSAPP] Diff detectado em ' + groupName + ': +' + newMembers.length + ' -' + leftMembers.length + ' (eventos possivelmente perdidos)');

            for (var j = 0; j < newMembers.length; j++) {
              await saveEventSafe(
                'INSERT INTO member_events (whatsapp_group_id, group_name, phone, phone_partial, action) VALUES ($1, $2, $3, $4, $5)',
                [groupId, groupName, hashPhone(newMembers[j]), newMembers[j].slice(-4), 'join'],
                'diff:join:' + newMembers[j].slice(-4) + '@' + groupName
              );
              await saveEventSafe(
                'INSERT INTO lead_contacts (phone, whatsapp_group_id, group_name, joined_at, is_active) VALUES ($1, $2, $3, NOW(), true) ' +
                'ON CONFLICT (phone, whatsapp_group_id) DO UPDATE SET is_active=true, left_at=NULL, joined_at=NOW()',
                [newMembers[j], groupId, groupName],
                'diff:lead:join:' + newMembers[j].slice(-4)
              );
            }

            for (var l = 0; l < leftMembers.length; l++) {
              await saveEventSafe(
                'INSERT INTO member_events (whatsapp_group_id, group_name, phone, phone_partial, action) VALUES ($1, $2, $3, $4, $5)',
                [groupId, groupName, hashPhone(leftMembers[l]), leftMembers[l].slice(-4), 'leave'],
                'diff:leave:' + leftMembers[l].slice(-4) + '@' + groupName
              );
              await saveEventSafe(
                'UPDATE lead_contacts SET is_active=false, left_at=NOW() WHERE phone=$1 AND whatsapp_group_id=$2',
                [leftMembers[l], groupId],
                'diff:lead:leave:' + leftMembers[l].slice(-4)
              );
            }
          }
        }

        // Atualiza snapshot
        lastKnownMembers[groupId] = currentParticipants;

        // Upsert no PostgreSQL
        await queryWithRetry(
          'INSERT INTO whatsapp_groups (id, group_name, current_members, last_scanned) VALUES ($1, $2, $3, NOW()) ON CONFLICT (id) DO UPDATE SET group_name=$2, current_members=$3, last_scanned=NOW()',
          [groupId, groupName, memberCount]
        );

        // Cache do nome com TTL
        groupNameCache[groupId] = { name: groupName, timestamp: Date.now() };

      } catch (err) {
        console.error('[WHATSAPP] Erro ao escanear grupo ' + (group.subject || groupId) + ':', err.message);
      }
    }

    console.log('[WHATSAPP] Scan de grupos concluído (' + groupIds.length + ' grupos, ' + Object.keys(lastKnownMembers).length + ' com snapshot)');
  } catch (err) {
    console.error('[WHATSAPP] Erro no scan:', err.message);
  }
}

var scanGroups = scanGroupsWithDiff;

/**
 * Atualiza contagem de membros de um grupo
 */
async function updateGroupMemberCount(groupId) {
  try {
    if (!sock) return;
    var metadata = await sock.groupMetadata(groupId);
    if (metadata && metadata.participants) {
      await queryWithRetry(
        'INSERT INTO whatsapp_groups (id, group_name, current_members, last_scanned) VALUES ($1, $2, $3, NOW()) ON CONFLICT (id) DO UPDATE SET group_name=$2, current_members=$3, last_scanned=NOW()',
        [groupId, metadata.subject, metadata.participants.length]
      );
      groupNameCache[groupId] = { name: metadata.subject, timestamp: Date.now() };

      lastKnownMembers[groupId] = metadata.participants.map(function(p) {
        return p.id.split('@')[0];
      });
    }
  } catch (err) {
    console.error('[WHATSAPP] Erro ao atualizar contagem:', err.message);
  }
}

// ===== API PÚBLICAS =====

function getStatus() {
  return Object.assign({}, connectionStatus, {
    retryQueueSize: eventRetryQueue.length,
    cachedGroups: Object.keys(groupNameCache).length,
    trackedGroups: Object.keys(lastKnownMembers).length,
    pairingCodeRequested: pairingCodeRequested
  });
}

function getQR() {
  return currentQR;
}

var groupsCache = { data: null, timestamp: 0 };
var GROUPS_CACHE_TTL = 60000;

async function getGroups() {
  // Return cache if fresh
  if (groupsCache.data && (Date.now() - groupsCache.timestamp) < GROUPS_CACHE_TTL) {
    return groupsCache.data;
  }

  if (!sock || !connectionStatus.ready) {
    var result = await pool.query('SELECT * FROM whatsapp_groups ORDER BY group_name');
    var groups = result.rows.map(function(r) {
      return { id: r.id, name: r.group_name, participants: r.current_members, currentMembers: r.current_members, groupName: r.group_name, lastScanned: { seconds: Math.floor(new Date(r.last_scanned).getTime() / 1000) } };
    });
    groupsCache = { data: groups, timestamp: Date.now() };
    return groups;
  }

  try {
    var allGroups = await sock.groupFetchAllParticipating();
    var groupIds = Object.keys(allGroups);

    var result = [];
    for (var i = 0; i < groupIds.length; i++) {
      var g = allGroups[groupIds[i]];
      var memberCount = g.participants ? g.participants.length : 0;

      result.push({
        id: groupIds[i],
        name: g.subject || groupIds[i],
        participants: memberCount,
        isReadOnly: g.announce || false
      });
    }

    groupsCache = { data: result, timestamp: Date.now() };

    // Update PostgreSQL in background
    result.forEach(function(g) {
      pool.query(
        'INSERT INTO whatsapp_groups (id, group_name, current_members, last_scanned) VALUES ($1, $2, $3, NOW()) ON CONFLICT (id) DO UPDATE SET group_name=$2, current_members=$3, last_scanned=NOW()',
        [g.id, g.name, g.participants]
      ).catch(function() {});
    });

    return result;
  } catch (err) {
    try {
      var result = await pool.query('SELECT * FROM whatsapp_groups ORDER BY group_name');
      return result.rows.map(function(r) {
        return { id: r.id, name: r.group_name, participants: r.current_members, currentMembers: r.current_members };
      });
    } catch (e2) {
      throw new Error('Erro ao listar grupos: ' + err.message);
    }
  }
}

async function getGroupMembers(groupId) {
  if (!sock || !connectionStatus.ready) {
    throw new Error('WhatsApp não conectado');
  }

  try {
    var metadata = await sock.groupMetadata(groupId);
    if (!metadata || !metadata.participants) {
      throw new Error('Grupo não encontrado');
    }

    return {
      groupName: metadata.subject,
      totalMembers: metadata.participants.length,
      participants: metadata.participants.map(function(p) {
        var phone = p.id.split('@')[0];
        return {
          id: p.id,
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

// Re-scan periódico com detecção de diff (a cada 10 minutos)
setInterval(function() {
  if (connectionStatus.ready) {
    scanGroupsWithDiff();
  }
}, 10 * 60 * 1000);

async function restart() {
  console.log('[WHATSAPP] Reiniciando cliente...');
  connectionStatus.connected = false;
  connectionStatus.ready = false;
  connectionStatus.error = null;
  currentQR = null;
  reconnectAttempts = 0;
  connectionStatus.reconnectAttempts = 0;
  pairingCodeRequested = false;
  pendingPairingPhone = null;

  if (sock) {
    try {
      await sock.logout();
    } catch (err) {
      // Se logout falha, tenta end()
      try { sock.end(); } catch(e) {}
    }
    sock = null;
  }

  // Limpa sessão para forçar novo login
  var fs = require('fs');
  try { fs.rmSync('./whatsapp-session', { recursive: true, force: true }); } catch(e) {}

  // Re-inicializa
  await initializeSocket();
}

/**
 * Desconecta sem limpar a sessão (mantém logado)
 */
async function disconnect() {
  console.log('[WHATSAPP] Desconectando...');
  connectionStatus.connected = false;
  connectionStatus.ready = false;
  currentQR = null;
  pairingCodeRequested = false;

  if (sock) {
    try { sock.end(); } catch(e) {}
    sock = null;
  }
}

// ===== HEALTH CHECK HELPERS =====

async function checkGroupExists(groupId) {
  if (!sock || !connectionStatus.ready) return null;
  try {
    var metadata = await sock.groupMetadata(groupId);
    if (metadata && metadata.subject) {
      return { exists: true, name: metadata.subject, participants: metadata.participants ? metadata.participants.length : 0 };
    }
    return { exists: false };
  } catch (err) {
    return { exists: false, error: err.message };
  }
}

async function checkInviteCode(inviteCode) {
  if (!sock || !connectionStatus.ready) return null;
  try {
    var info = await sock.groupGetInviteInfo(inviteCode);
    return { valid: true, groupName: info.subject, size: info.size };
  } catch (err) {
    var msg = (err.message || '').toLowerCase();
    if (msg.includes('invite') || msg.includes('revoked') || msg.includes('not found') || msg.includes('invalid') || msg.includes('not-authorized')) {
      return { valid: false, definitive: true, error: err.message };
    }
    return { valid: false, definitive: false, error: err.message };
  }
}

async function getLiveGroupIds() {
  if (!sock || !connectionStatus.ready) return null;
  try {
    var allGroups = await sock.groupFetchAllParticipating();
    return Object.keys(allGroups);
  } catch (err) {
    return null;
  }
}

function getClient() {
  return sock;
}

module.exports = {
  initialize: initialize,
  getStatus: getStatus,
  getQR: getQR,
  getGroups: getGroups,
  getGroupMembers: getGroupMembers,
  getClient: getClient,
  restart: restart,
  disconnect: disconnect,
  requestPairingCode: requestPairingCode,
  checkGroupExists: checkGroupExists,
  checkInviteCode: checkInviteCode,
  getLiveGroupIds: getLiveGroupIds
};
