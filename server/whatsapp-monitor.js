/**
 * WhatsApp Group Monitor
 * Monitora entradas/saídas de membros nos grupos
 * Usa whatsapp-web.js + PostgreSQL
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

let client = null;
let pool = null; // PostgreSQL pool
let currentQR = null;
let reconnectAttempts = 0;
var MAX_RECONNECT_ATTEMPTS = 5;
let connectionStatus = {
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
 * Inicializa o cliente WhatsApp
 */
function initialize(pgPool) {
  pool = pgPool;
  reconnectAttempts = 0;

  try {
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
  } catch (err) {
    console.error('[WHATSAPP] Erro ao criar cliente:', err.message);
    connectionStatus.error = err.message;
    return;
  }

  // QR Code para autenticação
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
    reconnectAttempts = 0;
    connectionStatus.reconnectAttempts = 0;

    var info = client.info;
    connectionStatus.phone = info ? info.wid.user : 'N/A';
    console.log('[WHATSAPP] Conectado! Número: ' + connectionStatus.phone);

    // Faz scan inicial dos grupos e captura snapshot de membros
    await scanGroupsWithDiff();
  });

  // Membro entrou no grupo - captura TODOS os membros do evento
  client.on('group_join', async function(notification) {
    try {
      var groupId = notification.chatId;

      // Extrai TODOS os membros que entraram (pode ser múltiplos)
      var memberIds = extractMemberIds(notification);

      if (memberIds.length === 0) {
        console.warn('[WHATSAPP] group_join sem membros identificados no grupo ' + groupId);
        return;
      }

      var groupName = await getGroupName(groupId);

      console.log('[WHATSAPP] ' + memberIds.length + ' membro(s) entrou(ram) no grupo ' + groupName + ' (' + groupId + ')');

      // Registra cada membro individualmente
      for (var i = 0; i < memberIds.length; i++) {
        var memberPhone = memberIds[i];

        await saveEventSafe(
          'INSERT INTO member_events (whatsapp_group_id, group_name, phone, phone_partial, action) VALUES ($1, $2, $3, $4, $5)',
          [groupId, groupName, hashPhone(memberPhone), memberPhone.slice(-4), 'join'],
          'join:' + memberPhone.slice(-4) + '@' + groupName
        );

        // Cria alerta
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
      }

      // Atualiza contagem de membros
      await updateGroupMemberCount(groupId);

    } catch (err) {
      console.error('[WHATSAPP] Erro ao registrar entrada:', err.message);
    }
  });

  // Membro saiu do grupo - captura TODOS os membros do evento
  client.on('group_leave', async function(notification) {
    try {
      var groupId = notification.chatId;

      // Extrai TODOS os membros que saíram
      var memberIds = extractMemberIds(notification);

      if (memberIds.length === 0) {
        console.warn('[WHATSAPP] group_leave sem membros identificados no grupo ' + groupId);
        return;
      }

      var groupName = await getGroupName(groupId);

      console.log('[WHATSAPP] ' + memberIds.length + ' membro(s) saiu(ram) do grupo ' + groupName + ' (' + groupId + ')');

      for (var i = 0; i < memberIds.length; i++) {
        var memberPhone = memberIds[i];

        await saveEventSafe(
          'INSERT INTO member_events (whatsapp_group_id, group_name, phone, phone_partial, action) VALUES ($1, $2, $3, $4, $5)',
          [groupId, groupName, hashPhone(memberPhone), memberPhone.slice(-4), 'leave'],
          'leave:' + memberPhone.slice(-4) + '@' + groupName
        );

        // Mark lead as inactive
        if (memberPhone && memberPhone !== 'desconhecido') {
          await saveEventSafe(
            'UPDATE lead_contacts SET is_active=false, left_at=NOW() WHERE phone=$1 AND whatsapp_group_id=$2',
            [memberPhone, groupId],
            'lead:leave:' + memberPhone.slice(-4)
          );
        }
      }

      // Atualiza contagem
      await updateGroupMemberCount(groupId);

    } catch (err) {
      console.error('[WHATSAPP] Erro ao registrar saída:', err.message);
    }
  });

  // Evento de atualização de grupo (configurações, descrição, etc.)
  client.on('group_update', async function(notification) {
    try {
      var groupId = notification.chatId;
      var updateType = notification.type;

      console.log('[WHATSAPP] Atualização no grupo ' + groupId + ': ' + updateType);

      // Atualiza dados do grupo no DB
      var groupName = await getGroupName(groupId, true); // force refresh
      await updateGroupMemberCount(groupId);

    } catch (err) {
      console.error('[WHATSAPP] Erro ao processar atualização do grupo:', err.message);
    }
  });

  // Desconectado - reconexão com backoff exponencial
  client.on('disconnected', function(reason) {
    connectionStatus.connected = false;
    connectionStatus.ready = false;
    connectionStatus.lastDisconnect = new Date().toISOString();
    connectionStatus.error = reason;
    console.log('[WHATSAPP] Desconectado. Motivo:', reason);

    attemptReconnect();
  });

  // Erro de autenticação
  client.on('auth_failure', function(msg) {
    connectionStatus.error = 'Falha na autenticação: ' + msg;
    console.error('[WHATSAPP] Falha na autenticação:', msg);
  });

  // Inicia
  console.log('[WHATSAPP] Inicializando cliente...');
  client.initialize().catch(function(err) {
    connectionStatus.error = err.message;
    console.error('[WHATSAPP] Erro ao inicializar:', err.message);
  });
}

/**
 * Extrai TODOS os IDs de membros de uma notificação de grupo
 * Resolve o problema de só pegar o primeiro membro
 */
function extractMemberIds(notification) {
  var members = [];

  // recipientIds é um array com TODOS os membros envolvidos
  if (notification.recipientIds && notification.recipientIds.length > 0) {
    for (var i = 0; i < notification.recipientIds.length; i++) {
      var phone = notification.recipientIds[i].replace('@c.us', '');
      if (phone && members.indexOf(phone) === -1) {
        members.push(phone);
      }
    }
  }

  // Fallback: id.participant (só se recipientIds vazio)
  // CUIDADO: participant pode ser o admin que executou a ação
  if (members.length === 0 && notification.id && notification.id.participant) {
    var fallbackPhone = notification.id.participant.replace('@c.us', '');
    // Verifica se não é o nosso próprio número
    if (fallbackPhone && connectionStatus.phone && fallbackPhone !== connectionStatus.phone) {
      members.push(fallbackPhone);
      console.warn('[WHATSAPP] Usando fallback id.participant - pode ser impreciso: ***' + fallbackPhone.slice(-4));
    }
  }

  // Último recurso: tenta notification.author
  if (members.length === 0 && notification.author) {
    var authorPhone = notification.author.replace('@c.us', '');
    if (authorPhone && connectionStatus.phone && authorPhone !== connectionStatus.phone) {
      members.push(authorPhone);
      console.warn('[WHATSAPP] Usando último recurso notification.author: ***' + authorPhone.slice(-4));
    }
  }

  return members;
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

  // Backoff exponencial: 10s, 20s, 40s, 80s, 160s
  var delay = Math.min(10000 * Math.pow(2, reconnectAttempts - 1), 300000);
  console.log('[WHATSAPP] Tentativa de reconexão ' + reconnectAttempts + '/' + MAX_RECONNECT_ATTEMPTS + ' em ' + (delay / 1000) + 's...');

  setTimeout(function() {
    if (connectionStatus.ready) return; // Já reconectou

    console.log('[WHATSAPP] Tentando reconectar (tentativa ' + reconnectAttempts + ')...');
    client.initialize().catch(function(err) {
      console.error('[WHATSAPP] Falha ao reconectar:', err.message);
      attemptReconnect(); // Tenta novamente com delay maior
    });
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
    var chat = await client.getChatById(groupId);
    if (chat && chat.name) {
      groupNameCache[groupId] = { name: chat.name, timestamp: Date.now() };
      return chat.name;
    }
  } catch (err) {
    // Se temos cache expirado, retorna ele mesmo assim
    if (cached) return cached.name;
  }
  return groupId;
}

/**
 * Faz scan de todos os grupos COM detecção de diferenças
 * Detecta membros que entraram/saíram entre scans (eventos perdidos)
 */
async function scanGroupsWithDiff() {
  try {
    var chats = await client.getChats();
    var groups = chats.filter(function(c) { return c.isGroup; });

    console.log('[WHATSAPP] Encontrados ' + groups.length + ' grupos');

    for (var group of groups) {
      try {
        var groupId = group.id._serialized;
        var groupChat = await client.getChatById(groupId);
        var currentParticipants = [];
        var memberCount = 0;

        if (groupChat && groupChat.participants) {
          memberCount = groupChat.participants.length;
          currentParticipants = groupChat.participants.map(function(p) {
            return p.id.user;
          });
        } else if (group.participants) {
          memberCount = group.participants.length;
          currentParticipants = group.participants.map(function(p) {
            return p.id.user;
          });
        }

        // Detecta diferenças com snapshot anterior
        var previousMembers = lastKnownMembers[groupId];
        if (previousMembers && previousMembers.length > 0 && currentParticipants.length > 0) {
          // Novos membros (estão no atual mas não estavam no anterior)
          var newMembers = currentParticipants.filter(function(m) {
            return previousMembers.indexOf(m) === -1;
          });

          // Membros que saíram (estavam no anterior mas não estão no atual)
          var leftMembers = previousMembers.filter(function(m) {
            return currentParticipants.indexOf(m) === -1;
          });

          if (newMembers.length > 0 || leftMembers.length > 0) {
            var groupName = group.name || groupId;
            console.log('[WHATSAPP] Diff detectado em ' + groupName + ': +' + newMembers.length + ' -' + leftMembers.length + ' (eventos possivelmente perdidos)');

            // Registra joins detectados por diff
            for (var j = 0; j < newMembers.length; j++) {
              await saveEventSafe(
                'INSERT INTO member_events (whatsapp_group_id, group_name, phone, phone_partial, action) VALUES ($1, $2, $3, $4, $5)',
                [groupId, groupName, hashPhone(newMembers[j]), newMembers[j].slice(-4), 'join'],
                'diff:join:' + newMembers[j].slice(-4) + '@' + groupName
              );

              // Backup lead
              await saveEventSafe(
                'INSERT INTO lead_contacts (phone, whatsapp_group_id, group_name, joined_at, is_active) VALUES ($1, $2, $3, NOW(), true) ' +
                'ON CONFLICT (phone, whatsapp_group_id) DO UPDATE SET is_active=true, left_at=NULL, joined_at=NOW()',
                [newMembers[j], groupId, groupName],
                'diff:lead:join:' + newMembers[j].slice(-4)
              );
            }

            // Registra leaves detectados por diff
            for (var l = 0; l < leftMembers.length; l++) {
              await saveEventSafe(
                'INSERT INTO member_events (whatsapp_group_id, group_name, phone, phone_partial, action) VALUES ($1, $2, $3, $4, $5)',
                [groupId, groupName, hashPhone(leftMembers[l]), leftMembers[l].slice(-4), 'leave'],
                'diff:leave:' + leftMembers[l].slice(-4) + '@' + groupName
              );

              // Mark lead inactive
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
          [groupId, group.name, memberCount]
        );

        // Cache do nome com TTL
        groupNameCache[groupId] = { name: group.name, timestamp: Date.now() };

      } catch (err) {
        console.error('[WHATSAPP] Erro ao escanear grupo ' + group.name + ':', err.message);
      }
    }

    console.log('[WHATSAPP] Scan de grupos concluído (' + groups.length + ' grupos, ' + Object.keys(lastKnownMembers).length + ' com snapshot)');
  } catch (err) {
    console.error('[WHATSAPP] Erro no scan:', err.message);
  }
}

// Mantém compatibilidade - scanGroups agora usa scanGroupsWithDiff
var scanGroups = scanGroupsWithDiff;

/**
 * Atualiza contagem de membros de um grupo
 */
async function updateGroupMemberCount(groupId) {
  try {
    var chat = await client.getChatById(groupId);
    if (chat && chat.participants) {
      await queryWithRetry(
        'INSERT INTO whatsapp_groups (id, group_name, current_members, last_scanned) VALUES ($1, $2, $3, NOW()) ON CONFLICT (id) DO UPDATE SET group_name=$2, current_members=$3, last_scanned=NOW()',
        [groupId, chat.name, chat.participants.length]
      );
      groupNameCache[groupId] = { name: chat.name, timestamp: Date.now() };

      // Atualiza snapshot de membros
      lastKnownMembers[groupId] = chat.participants.map(function(p) {
        return p.id.user;
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
    trackedGroups: Object.keys(lastKnownMembers).length
  });
}

function getQR() {
  return currentQR;
}

var groupsCache = { data: null, timestamp: 0 };
var GROUPS_CACHE_TTL = 60000; // 60 seconds

async function getGroups() {
  // Return cache if fresh
  if (groupsCache.data && (Date.now() - groupsCache.timestamp) < GROUPS_CACHE_TTL) {
    return groupsCache.data;
  }

  if (!client || !connectionStatus.ready) {
    // Retorna dados do PostgreSQL se WhatsApp não está conectado
    var result = await pool.query('SELECT * FROM whatsapp_groups ORDER BY group_name');
    var groups = result.rows.map(function(r) {
      return { id: r.id, name: r.group_name, participants: r.current_members, currentMembers: r.current_members, groupName: r.group_name, lastScanned: { seconds: Math.floor(new Date(r.last_scanned).getTime() / 1000) } };
    });
    groupsCache = { data: groups, timestamp: Date.now() };
    return groups;
  }

  try {
    var chats = await client.getChats();
    var groupChats = chats.filter(function(c) { return c.isGroup; });

    // Carrega participantes de cada grupo corretamente
    var result = [];
    for (var i = 0; i < groupChats.length; i++) {
      var g = groupChats[i];
      var memberCount = g.participants ? g.participants.length : 0;

      // Se participants não carregou (comum com getChats), busca individualmente
      if (memberCount === 0) {
        try {
          var fullChat = await client.getChatById(g.id._serialized);
          if (fullChat && fullChat.participants) {
            memberCount = fullChat.participants.length;
          }
        } catch (e) {
          // Tenta fallback do DB
          try {
            var dbR = await pool.query('SELECT current_members FROM whatsapp_groups WHERE id=$1', [g.id._serialized]);
            if (dbR.rows.length > 0) memberCount = dbR.rows[0].current_members;
          } catch (e2) {}
        }
      }

      result.push({
        id: g.id._serialized,
        name: g.name,
        participants: memberCount,
        isReadOnly: g.isReadOnly
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
    // Fallback to PostgreSQL
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
  if (!client || !connectionStatus.ready) {
    throw new Error('WhatsApp não conectado');
  }

  try {
    var chat = await client.getChatById(groupId);
    if (!chat || !chat.participants) {
      throw new Error('Grupo não encontrado');
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

  if (client) {
    try {
      await client.destroy();
    } catch (err) {
      console.error('[WHATSAPP] Erro ao destruir cliente:', err.message);
    }
    client = null;
  }

  initialize(pool);
}

// ===== HEALTH CHECK HELPERS =====

/**
 * Verifica se um grupo ainda existe via WhatsApp client
 */
async function checkGroupExists(groupId) {
  if (!client || !connectionStatus.ready) return null;
  try {
    var chat = await client.getChatById(groupId);
    if (chat && chat.name) {
      return { exists: true, name: chat.name, participants: chat.participants ? chat.participants.length : 0 };
    }
    return { exists: false };
  } catch (err) {
    return { exists: false, error: err.message };
  }
}

/**
 * Verifica se um código de convite do WhatsApp é válido
 */
async function checkInviteCode(inviteCode) {
  if (!client || !connectionStatus.ready) return null;
  try {
    var info = await client.getInviteInfo(inviteCode);
    return { valid: true, groupName: info.subject, size: info.size };
  } catch (err) {
    var msg = (err.message || '').toLowerCase();
    // Only mark as definitively invalid for specific error messages
    if (msg.includes('invite') || msg.includes('revoked') || msg.includes('not found') || msg.includes('invalid')) {
      return { valid: false, definitive: true, error: err.message };
    }
    // Other errors (network, rate limit, timeout) = inconclusive
    return { valid: false, definitive: false, error: err.message };
  }
}

/**
 * Retorna lista de IDs dos grupos ativos no WhatsApp
 */
async function getLiveGroupIds() {
  if (!client || !connectionStatus.ready) return null;
  try {
    var chats = await client.getChats();
    var groups = chats.filter(function(c) { return c.isGroup; });
    return groups.map(function(g) { return g.id._serialized; });
  } catch (err) {
    return null;
  }
}

function getClient() {
  return client;
}

module.exports = {
  initialize: initialize,
  getStatus: getStatus,
  getQR: getQR,
  getGroups: getGroups,
  getGroupMembers: getGroupMembers,
  getClient: getClient,
  restart: restart,
  checkGroupExists: checkGroupExists,
  checkInviteCode: checkInviteCode,
  getLiveGroupIds: getLiveGroupIds
};
