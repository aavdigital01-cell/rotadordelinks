/**
 * WhatsApp Group Monitor
 * Monitora entradas/saídas de membros nos grupos
 * Usa whatsapp-web.js (API não-oficial)
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');

let client = null;
let db = null;
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
function initialize(firestore) {
  db = firestore;

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

      // Registra evento no Firestore
      await db.collection('member_events').add({
        whatsappGroupId: groupId,
        phone: hashPhone(memberPhone),
        phonePartial: memberPhone.slice(-4),
        action: 'join',
        timestamp: require('firebase-admin').firestore.FieldValue.serverTimestamp()
      });

      // Atualiza contagem de membros
      await updateGroupMemberCount(groupId);

      // Cria alerta de novo membro
      var groupInfo = await getGroupInfo(groupId);
      await db.collection('alerts').add({
        type: 'member_joined',
        whatsappGroupId: groupId,
        groupName: groupInfo ? groupInfo.name : groupId,
        memberPhone: '***' + memberPhone.slice(-4),
        timestamp: require('firebase-admin').firestore.FieldValue.serverTimestamp(),
        read: false
      });

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

      // Registra evento
      await db.collection('member_events').add({
        whatsappGroupId: groupId,
        phone: hashPhone(memberPhone),
        phonePartial: memberPhone.slice(-4),
        action: 'leave',
        timestamp: require('firebase-admin').firestore.FieldValue.serverTimestamp()
      });

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

    // Tenta reconectar após 30s
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
    console.log('[WHATSAPP] Verifique se o Chromium está instalado');
  });
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

        // Tenta pegar mais detalhes
        var groupChat = await client.getChatById(group.id._serialized);
        if (groupChat && groupChat.participants) {
          memberCount = groupChat.participants.length;
        }

        await db.collection('group_members').doc(group.id._serialized).set({
          whatsappGroupId: group.id._serialized,
          groupName: group.name,
          currentMembers: memberCount,
          lastScanned: require('firebase-admin').firestore.FieldValue.serverTimestamp()
        }, { merge: true });

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
      await db.collection('group_members').doc(groupId).set({
        whatsappGroupId: groupId,
        groupName: chat.name,
        currentMembers: chat.participants.length,
        lastUpdated: require('firebase-admin').firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }
  } catch (err) {
    console.error('[WHATSAPP] Erro ao atualizar contagem:', err.message);
  }
}

/**
 * Retorna info de um grupo
 */
async function getGroupInfo(groupId) {
  try {
    var chat = await client.getChatById(groupId);
    return chat ? { name: chat.name, participants: chat.participants ? chat.participants.length : 0 } : null;
  } catch (err) {
    return null;
  }
}

// ===== API PÚBLICAS =====

function getStatus() {
  return connectionStatus;
}

function getQR() {
  return currentQR;
}

async function getGroups() {
  if (!client || !connectionStatus.ready) {
    // Retorna dados do Firestore se WhatsApp não está conectado
    var snap = await db.collection('group_members').get();
    var groups = [];
    snap.forEach(function(doc) { groups.push({ id: doc.id, ...doc.data() }); });
    return groups;
  }

  try {
    var chats = await client.getChats();
    var groups = chats.filter(function(c) { return c.isGroup; });

    return groups.map(function(g) {
      return {
        id: g.id._serialized,
        name: g.name,
        participants: g.participants ? g.participants.length : 0,
        isReadOnly: g.isReadOnly
      };
    });
  } catch (err) {
    throw new Error('Erro ao listar grupos: ' + err.message);
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

module.exports = {
  initialize: initialize,
  getStatus: getStatus,
  getQR: getQR,
  getGroups: getGroups,
  getGroupMembers: getGroupMembers
};
