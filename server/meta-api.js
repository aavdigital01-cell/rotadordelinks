/**
 * Meta (Facebook) Marketing API Module
 * Gerencia campanhas, adsets e coleta insights
 *
 * NOTA: Todos os valores monetários retornados pela Meta API (spend, cpc, cpm,
 * cost_per_action_type) estão na moeda da conta de anúncios (geralmente USD).
 * A conversão para BRL deve ser feita no frontend/endpoint usando a cotação atual.
 */

const fetch = require('node-fetch');

const BASE_URL = 'https://graph.facebook.com/v21.0';

// Campos completos de insights para métricas precisas
const INSIGHT_FIELDS = [
  'spend', 'impressions', 'clicks', 'reach', 'frequency',
  'cpc', 'cpm', 'cpp', 'ctr',
  'unique_clicks', 'unique_ctr', 'cost_per_unique_click',
  'actions', 'cost_per_action_type',
  'conversions', 'cost_per_conversion',
  'purchase_roas',
  'quality_ranking', 'engagement_rate_ranking', 'conversion_rate_ranking'
].join(',');

// Campos reduzidos para daily breakdown (evita rate limit)
const DAILY_INSIGHT_FIELDS = [
  'spend', 'impressions', 'clicks', 'reach',
  'cpc', 'cpm', 'ctr',
  'actions', 'cost_per_action_type'
].join(',');

function getToken() {
  return process.env.META_ACCESS_TOKEN;
}

function getAdAccountId() {
  return process.env.META_AD_ACCOUNT_ID;
}

/**
 * Chamada genérica à Meta Graph API com retry automático
 * @param {string} endpoint - Endpoint da API
 * @param {string} method - GET ou POST
 * @param {object} body - Body para POST requests
 * @param {number} retries - Número de retries (default: 2)
 */
async function apiCall(endpoint, method, body, retries) {
  method = method || 'GET';
  retries = retries !== undefined ? retries : 2;

  var url = BASE_URL + endpoint;
  var separator = url.includes('?') ? '&' : '?';
  url += separator + 'access_token=' + getToken();

  var options = { method: method, headers: { 'Content-Type': 'application/json' } };
  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }

  try {
    var response = await fetch(url, options);
    var data = await response.json();

    if (data.error) {
      // Rate limit (code 32 ou 4) - retry com backoff
      if (data.error.code === 32 || data.error.code === 4 || data.error.code === 17) {
        if (retries > 0) {
          var waitMs = (3 - retries) * 2000 + 1000; // 1s, 3s
          await new Promise(function(r) { setTimeout(r, waitMs); });
          return apiCall(endpoint, method, body, retries - 1);
        }
      }
      // Token expirado
      if (data.error.code === 190) {
        throw new Error('[META_TOKEN_EXPIRED] ' + (data.error.message || 'Token expirado'));
      }
      throw new Error(data.error.message || 'Meta API error (code: ' + (data.error.code || 'unknown') + ')');
    }

    return data;
  } catch (err) {
    // Network errors - retry
    if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.type === 'system') {
      if (retries > 0) {
        var waitMs = (3 - retries) * 2000 + 1000;
        await new Promise(function(r) { setTimeout(r, waitMs); });
        return apiCall(endpoint, method, body, retries - 1);
      }
    }
    throw err;
  }
}

// ===== CAMPANHAS =====

/**
 * Lista todas as campanhas da conta de anúncios
 * Inclui status efetivo e orçamentos
 */
async function getCampaigns() {
  return await apiCall(
    '/' + getAdAccountId() + '/campaigns?fields=id,name,status,effective_status,objective,daily_budget,lifetime_budget,budget_remaining,bid_strategy,created_time,updated_time&limit=100'
  );
}

/**
 * Insights de uma campanha específica
 * @param {string} campaignId - ID da campanha Meta
 * @param {string} dateRange - today, yesterday, last_7d, last_30d, this_month
 *
 * RETORNO: Todos os valores monetários em USD (moeda da conta)
 * - spend: gasto total em USD
 * - cpc: custo por clique em USD (spend / clicks)
 * - cpm: custo por mil impressões em USD (spend / impressions * 1000)
 * - ctr: taxa de cliques em % (clicks / impressions * 100)
 */
async function getCampaignInsights(campaignId, dateRange) {
  var datePreset = convertDateRange(dateRange);
  return await apiCall(
    '/' + campaignId + '/insights?fields=' + INSIGHT_FIELDS + '&date_preset=' + datePreset
  );
}

/**
 * Insights gerais da conta de anúncios
 */
async function getAccountInsights(dateRange) {
  var datePreset = convertDateRange(dateRange);
  return await apiCall(
    '/' + getAdAccountId() + '/insights?fields=' + INSIGHT_FIELDS + '&date_preset=' + datePreset
  );
}

/**
 * Insights com breakdown por dia
 */
async function getCampaignInsightsDaily(campaignId, days) {
  days = days || 30;
  var since = new Date();
  since.setDate(since.getDate() - days);
  var sinceStr = since.toISOString().split('T')[0];
  var untilStr = new Date().toISOString().split('T')[0];

  return await apiCall(
    '/' + campaignId + '/insights?fields=' + DAILY_INSIGHT_FIELDS +
    '&time_range={"since":"' + sinceStr + '","until":"' + untilStr + '"}&time_increment=1'
  );
}

/**
 * Insights por idade e gênero (para analytics avançado)
 */
async function getCampaignInsightsByDemographics(campaignId, dateRange) {
  var datePreset = convertDateRange(dateRange || 'last_7d');
  return await apiCall(
    '/' + campaignId + '/insights?fields=spend,impressions,clicks,actions,cost_per_action_type' +
    '&breakdowns=age,gender&date_preset=' + datePreset + '&limit=100'
  );
}

/**
 * Insights por plataforma (Facebook, Instagram, Audience Network)
 */
async function getCampaignInsightsByPlatform(campaignId, dateRange) {
  var datePreset = convertDateRange(dateRange || 'last_7d');
  return await apiCall(
    '/' + campaignId + '/insights?fields=spend,impressions,clicks,cpc,cpm,ctr,actions,cost_per_action_type' +
    '&breakdowns=publisher_platform&date_preset=' + datePreset
  );
}

// ===== GERENCIAMENTO =====

/**
 * Atualiza status da campanha
 * @param {string} campaignId
 * @param {string} status - ACTIVE ou PAUSED
 */
async function updateCampaignStatus(campaignId, status) {
  if (status !== 'ACTIVE' && status !== 'PAUSED') {
    throw new Error('Status deve ser ACTIVE ou PAUSED');
  }
  return await apiCall('/' + campaignId, 'POST', { status: status });
}

/**
 * Atualiza orçamento da campanha
 * @param {string} campaignId
 * @param {number} budget - Valor na moeda da conta (USD) (ex: 50.00)
 * @param {string} type - daily ou lifetime
 *
 * NOTA: A Meta API aceita valores em centavos da moeda da conta.
 * Se a conta é em USD, $50.00 = 5000 centavos.
 * O frontend deve enviar o valor já em USD.
 */
async function updateCampaignBudget(campaignId, budget, type) {
  type = type || 'daily';
  var budgetCents = Math.round(budget * 100); // Meta usa centavos da moeda da conta
  var field = type === 'daily' ? 'daily_budget' : 'lifetime_budget';
  var payload = {};
  payload[field] = budgetCents.toString();
  return await apiCall('/' + campaignId, 'POST', payload);
}

/**
 * Lista adsets de uma campanha com métricas
 */
async function getAdsets(campaignId) {
  return await apiCall(
    '/' + campaignId + '/adsets?fields=id,name,status,effective_status,daily_budget,lifetime_budget,targeting,optimization_goal,bid_strategy,bid_amount&limit=100'
  );
}

/**
 * Troca short-lived token por long-lived token (dura 60 dias)
 */
async function exchangeToken(shortToken) {
  var appId = process.env.META_APP_ID;
  var appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) throw new Error('META_APP_ID e META_APP_SECRET necessários');

  return await apiCall(
    '/oauth/access_token?grant_type=fb_exchange_token&client_id=' + appId +
    '&client_secret=' + appSecret + '&fb_exchange_token=' + shortToken
  );
}

/**
 * Verifica se o token ainda é válido
 */
async function debugToken() {
  var appId = process.env.META_APP_ID;
  var appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) return null;

  try {
    return await apiCall(
      '/debug_token?input_token=' + getToken() +
      '&access_token=' + appId + '|' + appSecret
    );
  } catch (e) {
    return null;
  }
}

// ===== HELPERS =====

function convertDateRange(range) {
  var map = {
    'today': 'today',
    'yesterday': 'yesterday',
    'last_3d': 'last_3d',
    'last_7d': 'last_7d',
    'last_14d': 'last_14d',
    'last_30d': 'last_30d',
    'this_month': 'this_month',
    'last_month': 'last_month',
    'this_quarter': 'this_quarter',
    'this_year': 'this_year'
  };
  return map[range] || 'today';
}

/**
 * Extrai conversões do array de actions da Meta API.
 * Suporta todos os tipos comuns de conversão.
 * @param {Array} actions - Array de {action_type, value}
 * @returns {number} Total de conversões
 */
function extractConversions(actions) {
  if (!actions) return 0;

  // Tipos de conversão prioritários (do mais específico ao mais genérico)
  var conversionTypes = [
    'offsite_conversion.fb_pixel_lead',
    'offsite_conversion.fb_pixel_purchase',
    'offsite_conversion.fb_pixel_complete_registration',
    'offsite_conversion.fb_pixel_initiate_checkout',
    'offsite_conversion.fb_pixel_add_to_cart',
    'lead',
    'purchase',
    'complete_registration',
    'onsite_conversion.messaging_first_reply',
    'onsite_conversion.messaging_conversation_started_7d',
    'contact_total',
    'landing_page_view'
  ];

  // Tenta encontrar o tipo mais específico primeiro
  for (var i = 0; i < conversionTypes.length; i++) {
    var found = actions.find(function(a) { return a.action_type === conversionTypes[i]; });
    if (found) return parseInt(found.value) || 0;
  }

  return 0;
}

/**
 * Extrai custo por resultado do array cost_per_action_type
 * @param {Array} costPerAction - Array de {action_type, value}
 * @returns {number} Custo por resultado em USD
 */
function extractCostPerResult(costPerAction) {
  if (!costPerAction) return 0;

  var costTypes = [
    'offsite_conversion.fb_pixel_lead',
    'offsite_conversion.fb_pixel_purchase',
    'offsite_conversion.fb_pixel_complete_registration',
    'lead',
    'purchase',
    'complete_registration',
    'onsite_conversion.messaging_first_reply',
    'onsite_conversion.messaging_conversation_started_7d'
  ];

  for (var i = 0; i < costTypes.length; i++) {
    var found = costPerAction.find(function(a) { return a.action_type === costTypes[i]; });
    if (found) return parseFloat(found.value) || 0;
  }

  return 0;
}

/**
 * Extrai ROAS (Return on Ad Spend) se disponível
 */
function extractROAS(purchaseRoas) {
  if (!purchaseRoas) return 0;
  var found = purchaseRoas.find(function(a) { return a.action_type === 'omni_purchase'; });
  if (found) return parseFloat(found.value) || 0;
  return purchaseRoas[0] ? parseFloat(purchaseRoas[0].value) || 0 : 0;
}

/**
 * Processa dados brutos de insights para formato padronizado
 * Todos os valores monetários ficam em USD (moeda da conta Meta)
 * @param {object} d - Dados brutos de um insight
 * @returns {object} Dados normalizados
 */
function normalizeInsight(d) {
  if (!d) return {
    spend: 0, impressions: 0, clicks: 0, reach: 0, frequency: 0,
    cpc: 0, cpm: 0, ctr: 0,
    uniqueClicks: 0, uniqueCtr: 0, costPerUniqueClick: 0,
    conversions: 0, costPerResult: 0, roas: 0,
    qualityRanking: '', engagementRanking: '', conversionRanking: ''
  };

  var spend = parseFloat(d.spend || 0);
  var impressions = parseInt(d.impressions || 0);
  var clicks = parseInt(d.clicks || 0);
  var reach = parseInt(d.reach || 0);

  // Calcula CPC e CPM corretamente se a API não retornar
  // CPC = spend / clicks (em USD)
  // CPM = (spend / impressions) * 1000 (em USD)
  var cpc = d.cpc ? parseFloat(d.cpc) : (clicks > 0 ? spend / clicks : 0);
  var cpm = d.cpm ? parseFloat(d.cpm) : (impressions > 0 ? (spend / impressions) * 1000 : 0);
  var ctr = d.ctr ? parseFloat(d.ctr) : (impressions > 0 ? (clicks / impressions) * 100 : 0);

  return {
    spend: spend,
    impressions: impressions,
    clicks: clicks,
    reach: reach,
    frequency: d.frequency ? parseFloat(d.frequency) : (reach > 0 ? impressions / reach : 0),
    cpc: cpc,
    cpm: cpm,
    ctr: ctr,
    uniqueClicks: parseInt(d.unique_clicks || 0),
    uniqueCtr: parseFloat(d.unique_ctr || 0),
    costPerUniqueClick: parseFloat(d.cost_per_unique_click || 0),
    conversions: extractConversions(d.actions),
    costPerResult: extractCostPerResult(d.cost_per_action_type),
    roas: extractROAS(d.purchase_roas),
    qualityRanking: d.quality_ranking || '',
    engagementRanking: d.engagement_rate_ranking || '',
    conversionRanking: d.conversion_rate_ranking || ''
  };
}

module.exports = {
  getCampaigns: getCampaigns,
  getCampaignInsights: getCampaignInsights,
  getCampaignInsightsDaily: getCampaignInsightsDaily,
  getCampaignInsightsByDemographics: getCampaignInsightsByDemographics,
  getCampaignInsightsByPlatform: getCampaignInsightsByPlatform,
  getAccountInsights: getAccountInsights,
  updateCampaignStatus: updateCampaignStatus,
  updateCampaignBudget: updateCampaignBudget,
  getAdsets: getAdsets,
  exchangeToken: exchangeToken,
  debugToken: debugToken,
  extractConversions: extractConversions,
  extractCostPerResult: extractCostPerResult,
  extractROAS: extractROAS,
  normalizeInsight: normalizeInsight
};
