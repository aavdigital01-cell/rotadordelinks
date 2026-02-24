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
let connectionStatus = {
  connected: false,
  ready: false,
  phone: null,
  lastDisconnect: null,
  error: null
};

/**
 * Inicializa o cliente WhatsApp
 */
function initialize(pgPool) {
  pool = pgPool;

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

    var info = client.info;
    connectionStatus.phone = info ? info.wid.user : 'N/A';
    console.log('[WHATSAPP] Conectado! Número: ' + connectionStatus.phone);

    // Faz scan inicial dos grupos
    await scanGroups();
  });

  // Membro entrou no grupo
  client.on('group_join', async function(notification) {
    try {
      var groupId = notification.chatId;
      var memberId = notification.recipientIds ? notification.recipientIds[0] : notification.id.participant;
      var memberPhone = memberId ? memberId.replace('@c.us', '') : 'desconhecido';

      console.log('[WHATSAPP] Membro entrou: ' + memberPhone + ' no grupo ' + groupId);

      // Busca nome do grupo
      var groupName = await getGroupName(groupId);

      // Registra evento no PostgreSQL
      await pool.query(
        'INSERT INTO member_events (whatsapp_group_id, group_name, phone, phone_partial, action) VALUES ($1, $2, $3, $4, $5)',
        [groupId, groupName, hashPhone(memberPhone), memberPhone.slice(-4), 'join']
      );

      // Atualiza contagem de membros
      await updateGroupMemberCount(groupId);

      // Cria alerta
      await pool.query(
        'INSERT INTO alerts (type, whatsapp_group_id, group_name, member_phone, message) VALUES ($1, $2, $3, $4, $5)',
        ['member_joined', groupId, groupName, '***' + memberPhone.slice(-4), 'Novo membro entrou no grupo ' + groupName]
      );

    } catch (err) {
      console.error('[WHATSAPP] Erro ao registrar entrada:', err.message);
    }
  });

  // Membro saiu do grupo
  client.on('group_leave', async function(notification) {
    try {
      var groupId = notification.chatId;
      var memberId = notification.recipientIds ? notification.recipientIds[0] : notification.id.participant;
      var memberPhone = memberId ? memberId.replace('@c.us', '') : 'desconhecido';

      console.log('[WHATSAPP] Membro saiu: ' + memberPhone + ' do grupo ' + groupId);

      var groupName = await getGroupName(groupId);

      // Registra evento
      await pool.query(
        'INSERT INTO member_events (whatsapp_group_id, group_name, phone, phone_partial, action) VALUES ($1, $2, $3, $4, $5)',
        [groupId, groupName, hashPhone(memberPhone), memberPhone.slice(-4), 'leave']
      );

      // Atualiza contagem
      await updateGroupMemberCount(groupId);

    } catch (err) {
      console.error('[WHATSAPP] Erro ao registrar saída:', err.message);
    }
  });

  // Desconectado
  client.on('disconnected', function(reason) {
    connectionStatus.connected = false;
    connectionStatus.ready = false;
    connectionStatus.lastDisconnect = new Date().toISOString();
    connectionStatus.error = reason;
    console.log('[WHATSAPP] Desconectado. Motivo:', reason);

    setTimeout(function() {
      console.log('[WHATSAPP] Tentando reconectar...');
      client.initialize().catch(function(err) {
        console.error('[WHATSAPP] Falha ao reconectar:', err.message);
      });
    }, 30000);
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
 * Busca nome de um grupo (com cache simples)
 */
var groupNameCache = {};
async function getGroupName(groupId) {
  if (groupNameCache[groupId]) return groupNameCache[groupId];
  try {
    var chat = await client.getChatById(groupId);
    if (chat && chat.name) {
      groupNameCache[groupId] = chat.name;
      return chat.name;
    }
  } catch (err) {}
  return groupId;
}

/**
 * Faz scan de todos os grupos
 */
async function scanGroups() {
  try {
    var chats = await client.getChats();
    var groups = chats.filter(function(c) { return c.isGroup; });

    console.log('[WHATSAPP] Encontrados ' + groups.length + ' grupos');

    for (var group of groups) {
      try {
        var participants = group.participants || [];
        var memberCount = participants.length;

        var groupChat = await client.getChatById(group.id._serialized);
        if (groupChat && groupChat.participants) {
          memberCount = groupChat.participants.length;
        }

        // Upsert no PostgreSQL
        await pool.query(
          'INSERT INTO whatsapp_groups (id, group_name, current_members, last_scanned) VALUES ($1, $2, $3, NOW()) ON CONFLICT (id) DO UPDATE SET group_name=$2, current_members=$3, last_scanned=NOW()',
          [group.id._serialized, group.name, memberCount]
        );

        // Cache do nome
        groupNameCache[group.id._serialized] = group.name;

      } catch (err) {
        console.error('[WHATSAPP] Erro ao escanear grupo ' + group.name + ':', err.message);
      }
    }

    console.log('[WHATSAPP] Scan de grupos concluído');
  } catch (err) {
    console.error('[WHATSAPP] Erro no scan:', err.message);
  }
}

/**
 * Atualiza contagem de membros de um grupo
 */
async function updateGroupMemberCount(groupId) {
  try {
    var chat = await client.getChatById(groupId);
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

function getStatus() {
  return connectionStatus;
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
    var groups = chats.filter(function(c) { return c.isGroup; });

    var result = groups.map(function(g) {
      return {
        id: g.id._serialized,
        name: g.name,
        participants: g.participants ? g.participants.length : 0,
        isReadOnly: g.isReadOnly
      };
    });

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

// Re-scan periódico (a cada 15 minutos)
setInterval(function() {
  if (connectionStatus.ready) {
    scanGroups();
  }
}, 15 * 60 * 1000);

async function restart() {
  console.log('[WHATSAPP] Reiniciando cliente...');
  connectionStatus.connected = false;
  connectionStatus.ready = false;
  connectionStatus.error = null;
  currentQR = null;

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

module.exports = {
  initialize: initialize,
  getStatus: getStatus,
  getQR: getQR,
  getGroups: getGroups,
  getGroupMembers: getGroupMembers,
  restart: restart
};
