/**
 * WhatsApp Group Monitor - Multi-Tenant
 * Monitora entradas/saídas de membros nos grupos
 * Cada usuário tem sua própria conexão WhatsApp
 * Usa whatsapp-web.js + PostgreSQL
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const path = require('path');

let clients = {}; // uid -> Client
let pool = null; // PostgreSQL pool
let qrCodes = {}; // uid -> qr string
let statuses = {}; // uid -> { connected, ready, phone, lastDisconnect, error }

function getDefaultStatus() {
  return {
    connected: false,
    ready: false,
    phone: null,
    lastDisconnect: null,
    error: null
  };
}

/**
 * Inicializa o pool de conexão PostgreSQL (chamada uma vez na startup)
 */
function initialize(pgPool) {
  pool = pgPool;
}

/**
 * Conecta o WhatsApp para um usuário específico
 */
function connectUser(uid) {
  if (clients[uid]) {
    // Already connected or connecting
    return;
  }

  if (!statuses[uid]) statuses[uid] = getDefaultStatus();

  var sessionPath = path.join('.', 'whatsapp-sessions', uid);

  var client = new Client({
    authStrategy: new LocalAuth({ dataPath: sessionPath }),
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

  clients[uid] = client;

  // QR Code para autenticação
  client.on('qr', function(qr) {
    qrCodes[uid] = qr;
    console.log('[WHATSAPP][' + uid.substring(0, 8) + '] QR Code gerado');
    qrcode.generate(qr, { small: true });
  });

  // Autenticado
  client.on('authenticated', function() {
    console.log('[WHATSAPP][' + uid.substring(0, 8) + '] Autenticado com sucesso!');
    qrCodes[uid] = null;
  });

  // Pronto para usar
  client.on('ready', async function() {
    statuses[uid] = statuses[uid] || getDefaultStatus();
    statuses[uid].connected = true;
    statuses[uid].ready = true;
    statuses[uid].error = null;

    var info = client.info;
    statuses[uid].phone = info ? info.wid.user : 'N/A';
    console.log('[WHATSAPP][' + uid.substring(0, 8) + '] Conectado! Número: ' + statuses[uid].phone);

    // Faz scan inicial dos grupos do usuário
    await scanGroupsForUser(uid, client);
  });

  // Membro entrou no grupo
  client.on('group_join', async function(notification) {
    try {
      var groupId = notification.chatId;
      var memberId = notification.recipientIds ? notification.recipientIds[0] : notification.id.participant;
      var memberPhone = memberId ? memberId.replace('@c.us', '') : 'desconhecido';

      var groupName = await getGroupName(client, groupId);

      // Registra evento no PostgreSQL com owner_uid
      await pool.query(
        'INSERT INTO member_events (whatsapp_group_id, group_name, phone, phone_partial, action, owner_uid) VALUES ($1, $2, $3, $4, $5, $6)',
        [groupId, groupName, hashPhone(memberPhone), memberPhone.slice(-4), 'join', uid]
      );

      // Atualiza contagem de membros
      await updateGroupMemberCount(client, groupId);

      // Cria alerta com owner_uid
      await pool.query(
        'INSERT INTO alerts (type, whatsapp_group_id, group_name, member_phone, message, owner_uid) VALUES ($1, $2, $3, $4, $5, $6)',
        ['member_joined', groupId, groupName, '***' + memberPhone.slice(-4), 'Novo membro entrou no grupo ' + groupName, uid]
      );

      // Backup lead contact
      if (memberPhone && memberPhone !== 'desconhecido') {
        await pool.query(
          'INSERT INTO lead_contacts (phone, whatsapp_group_id, group_name, joined_at, is_active, owner_uid) VALUES ($1, $2, $3, NOW(), true, $6) ' +
          'ON CONFLICT (phone, whatsapp_group_id) DO UPDATE SET is_active=true, left_at=NULL, joined_at=NOW()',
          [memberPhone, groupId, groupName, null, null, uid]
        ).catch(function() {});
      }

    } catch (err) {
      console.error('[WHATSAPP][' + uid.substring(0, 8) + '] Erro ao registrar entrada:', err.message);
    }
  });

  // Membro saiu do grupo
  client.on('group_leave', async function(notification) {
    try {
      var groupId = notification.chatId;
      var memberId = notification.recipientIds ? notification.recipientIds[0] : notification.id.participant;
      var memberPhone = memberId ? memberId.replace('@c.us', '') : 'desconhecido';

      var groupName = await getGroupName(client, groupId);

      // Registra evento com owner_uid
      await pool.query(
        'INSERT INTO member_events (whatsapp_group_id, group_name, phone, phone_partial, action, owner_uid) VALUES ($1, $2, $3, $4, $5, $6)',
        [groupId, groupName, hashPhone(memberPhone), memberPhone.slice(-4), 'leave', uid]
      );

      // Atualiza contagem
      await updateGroupMemberCount(client, groupId);

      // Mark lead as inactive
      if (memberPhone && memberPhone !== 'desconhecido') {
        await pool.query(
          'UPDATE lead_contacts SET is_active=false, left_at=NOW() WHERE phone=$1 AND whatsapp_group_id=$2',
          [memberPhone, groupId]
        ).catch(function() {});
      }

    } catch (err) {
      console.error('[WHATSAPP][' + uid.substring(0, 8) + '] Erro ao registrar saída:', err.message);
    }
  });

  // Desconectado
  client.on('disconnected', function(reason) {
    statuses[uid] = statuses[uid] || getDefaultStatus();
    statuses[uid].connected = false;
    statuses[uid].ready = false;
    statuses[uid].lastDisconnect = new Date().toISOString();
    statuses[uid].error = reason;
    console.log('[WHATSAPP][' + uid.substring(0, 8) + '] Desconectado. Motivo:', reason);

    setTimeout(function() {
      if (clients[uid]) {
        console.log('[WHATSAPP][' + uid.substring(0, 8) + '] Tentando reconectar...');
        clients[uid].initialize().catch(function(err) {
          console.error('[WHATSAPP][' + uid.substring(0, 8) + '] Falha ao reconectar:', err.message);
        });
      }
    }, 30000);
  });

  // Erro de autenticação
  client.on('auth_failure', function(msg) {
    statuses[uid] = statuses[uid] || getDefaultStatus();
    statuses[uid].error = 'Falha na autenticação: ' + msg;
    console.error('[WHATSAPP][' + uid.substring(0, 8) + '] Falha na autenticação:', msg);
  });

  // Inicia
  console.log('[WHATSAPP][' + uid.substring(0, 8) + '] Inicializando cliente...');
  client.initialize().catch(function(err) {
    statuses[uid] = statuses[uid] || getDefaultStatus();
    statuses[uid].error = err.message;
    console.error('[WHATSAPP][' + uid.substring(0, 8) + '] Erro ao inicializar:', err.message);
  });
}

/**
 * Desconecta o WhatsApp de um usuário
 */
async function disconnectUser(uid) {
  if (!clients[uid]) return;

  console.log('[WHATSAPP][' + uid.substring(0, 8) + '] Desconectando...');
  statuses[uid] = getDefaultStatus();
  qrCodes[uid] = null;

  try {
    await clients[uid].destroy();
  } catch (err) {
    console.error('[WHATSAPP][' + uid.substring(0, 8) + '] Erro ao destruir cliente:', err.message);
  }
  delete clients[uid];
}

/**
 * Busca nome de um grupo (com cache simples)
 */
var groupNameCache = {};
async function getGroupName(clientInstance, groupId) {
  if (groupNameCache[groupId]) return groupNameCache[groupId];
  try {
    var chat = await clientInstance.getChatById(groupId);
    if (chat && chat.name) {
      groupNameCache[groupId] = chat.name;
      return chat.name;
    }
  } catch (err) {}
  return groupId;
}

/**
 * Faz scan de todos os grupos de um usuário
 */
async function scanGroupsForUser(uid, clientInstance) {
  try {
    var chats = await clientInstance.getChats();
    var groups = chats.filter(function(c) { return c.isGroup; });

    console.log('[WHATSAPP][' + uid.substring(0, 8) + '] Encontrados ' + groups.length + ' grupos');

    for (var group of groups) {
      try {
        var participants = group.participants || [];
        var memberCount = participants.length;

        var groupChat = await clientInstance.getChatById(group.id._serialized);
        if (groupChat && groupChat.participants) {
          memberCount = groupChat.participants.length;
        }

        // Upsert no PostgreSQL com owner_uid
        await pool.query(
          'INSERT INTO whatsapp_groups (id, group_name, current_members, last_scanned, owner_uid) VALUES ($1, $2, $3, NOW(), $4) ON CONFLICT (id) DO UPDATE SET group_name=$2, current_members=$3, last_scanned=NOW(), owner_uid=$4',
          [group.id._serialized, group.name, memberCount, uid]
        );

        groupNameCache[group.id._serialized] = group.name;

      } catch (err) {
        console.error('[WHATSAPP][' + uid.substring(0, 8) + '] Erro ao escanear grupo ' + group.name + ':', err.message);
      }
    }

    console.log('[WHATSAPP][' + uid.substring(0, 8) + '] Scan de grupos concluído');
  } catch (err) {
    console.error('[WHATSAPP][' + uid.substring(0, 8) + '] Erro no scan:', err.message);
  }
}

/**
 * Atualiza contagem de membros de um grupo
 */
async function updateGroupMemberCount(clientInstance, groupId) {
  try {
    var chat = await clientInstance.getChatById(groupId);
    if (chat && chat.participants) {
      await pool.query(
        'INSERT INTO whatsapp_groups (id, group_name, current_members, last_scanned) VALUES ($1, $2, $3, NOW()) ON CONFLICT (id) DO UPDATE SET group_name=$2, current_members=$3, last_scanned=NOW()',
        [groupId, chat.name, chat.participants.length]
      );
      groupNameCache[groupId] = chat.name;
    }
  } catch (err) {
    console.error('[WHATSAPP] Erro ao atualizar contagem:', err.message);
  }
}

// ===== API PÚBLICAS =====

function getStatus(uid) {
  return statuses[uid] || getDefaultStatus();
}

function getQR(uid) {
  return qrCodes[uid] || null;
}

var groupsCaches = {}; // uid -> { data, timestamp }
var GROUPS_CACHE_TTL = 60000;

async function getGroups(uid) {
  // Return cache if fresh
  if (groupsCaches[uid] && groupsCaches[uid].data && (Date.now() - groupsCaches[uid].timestamp) < GROUPS_CACHE_TTL) {
    return groupsCaches[uid].data;
  }

  var clientInstance = clients[uid];
  if (!clientInstance || !statuses[uid] || !statuses[uid].ready) {
    // Retorna dados do PostgreSQL para este usuário
    var result = await pool.query('SELECT * FROM whatsapp_groups WHERE owner_uid=$1 ORDER BY group_name', [uid]);
    var groups = result.rows.map(function(r) {
      return { id: r.id, name: r.group_name, participants: r.current_members, currentMembers: r.current_members, groupName: r.group_name, lastScanned: { seconds: Math.floor(new Date(r.last_scanned).getTime() / 1000) } };
    });
    groupsCaches[uid] = { data: groups, timestamp: Date.now() };
    return groups;
  }

  try {
    var chats = await clientInstance.getChats();
    var groups = chats.filter(function(c) { return c.isGroup; });

    var result = groups.map(function(g) {
      return {
        id: g.id._serialized,
        name: g.name,
        participants: g.participants ? g.participants.length : 0,
        isReadOnly: g.isReadOnly
      };
    });

    groupsCaches[uid] = { data: result, timestamp: Date.now() };

    // Update PostgreSQL in background
    result.forEach(function(g) {
      pool.query(
        'INSERT INTO whatsapp_groups (id, group_name, current_members, last_scanned, owner_uid) VALUES ($1, $2, $3, NOW(), $4) ON CONFLICT (id) DO UPDATE SET group_name=$2, current_members=$3, last_scanned=NOW(), owner_uid=$4',
        [g.id, g.name, g.participants, uid]
      ).catch(function() {});
    });

    return result;
  } catch (err) {
    // Fallback to PostgreSQL
    try {
      var result = await pool.query('SELECT * FROM whatsapp_groups WHERE owner_uid=$1 ORDER BY group_name', [uid]);
      return result.rows.map(function(r) {
        return { id: r.id, name: r.group_name, participants: r.current_members, currentMembers: r.current_members };
      });
    } catch (e2) {
      throw new Error('Erro ao listar grupos: ' + err.message);
    }
  }
}

async function getGroupMembers(uid, groupId) {
  var clientInstance = clients[uid];
  if (!clientInstance || !statuses[uid] || !statuses[uid].ready) {
    throw new Error('WhatsApp não conectado');
  }

  try {
    var chat = await clientInstance.getChatById(groupId);
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

// Re-scan periódico (a cada 15 minutos) - para todos os clientes conectados
setInterval(function() {
  Object.keys(clients).forEach(function(uid) {
    if (statuses[uid] && statuses[uid].ready && clients[uid]) {
      scanGroupsForUser(uid, clients[uid]);
    }
  });
}, 15 * 60 * 1000);

async function restart(uid) {
  await disconnectUser(uid);
  connectUser(uid);
}

// ===== HEALTH CHECK HELPERS =====

/**
 * Verifica se um grupo ainda existe via WhatsApp client
 * Tenta usar qualquer client conectado
 */
async function checkGroupExists(groupId) {
  var connectedUids = Object.keys(clients).filter(function(uid) {
    return statuses[uid] && statuses[uid].ready;
  });
  if (connectedUids.length === 0) return null;

  // Try with the first connected client
  var clientInstance = clients[connectedUids[0]];
  try {
    var chat = await clientInstance.getChatById(groupId);
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
  var connectedUids = Object.keys(clients).filter(function(uid) {
    return statuses[uid] && statuses[uid].ready;
  });
  if (connectedUids.length === 0) return null;

  var clientInstance = clients[connectedUids[0]];
  try {
    var info = await clientInstance.getInviteInfo(inviteCode);
    return { valid: true, groupName: info.subject, size: info.size };
  } catch (err) {
    var msg = (err.message || '').toLowerCase();
    if (msg.includes('invite') || msg.includes('revoked') || msg.includes('not found') || msg.includes('invalid')) {
      return { valid: false, definitive: true, error: err.message };
    }
    return { valid: false, definitive: false, error: err.message };
  }
}

/**
 * Retorna lista de IDs dos grupos ativos no WhatsApp (de todos os clientes)
 */
async function getLiveGroupIds() {
  var allGroupIds = [];
  var connectedUids = Object.keys(clients).filter(function(uid) {
    return statuses[uid] && statuses[uid].ready;
  });

  for (var uid of connectedUids) {
    try {
      var chats = await clients[uid].getChats();
      var groups = chats.filter(function(c) { return c.isGroup; });
      groups.forEach(function(g) { allGroupIds.push(g.id._serialized); });
    } catch (err) {}
  }

  return allGroupIds.length > 0 ? allGroupIds : null;
}

function getClient(uid) {
  return uid ? clients[uid] : null;
}

function getConnectedUsers() {
  return Object.keys(clients).filter(function(uid) {
    return statuses[uid] && statuses[uid].ready;
  });
}

module.exports = {
  initialize: initialize,
  connectUser: connectUser,
  disconnectUser: disconnectUser,
  getStatus: getStatus,
  getQR: getQR,
  getGroups: getGroups,
  getGroupMembers: getGroupMembers,
  getClient: getClient,
  getConnectedUsers: getConnectedUsers,
  restart: restart,
  checkGroupExists: checkGroupExists,
  checkInviteCode: checkInviteCode,
  getLiveGroupIds: getLiveGroupIds
};
