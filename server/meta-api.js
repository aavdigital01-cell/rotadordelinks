/**
 * Meta (Facebook) Marketing API Module
 * Gerencia campanhas, adsets e coleta insights
 *
 * All exported functions accept a `credentials` object as the last parameter:
 *   { accessToken: 'xxx', adAccountId: 'yyy', appId: 'zzz', appSecret: 'www' }
 */

const fetch = require('node-fetch');

const BASE_URL = 'https://graph.facebook.com/v19.0';

async function apiCall(endpoint, method, body, credentials) {
  method = method || 'GET';
  var url = BASE_URL + endpoint;
  var separator = url.includes('?') ? '&' : '?';
  url += separator + 'access_token=' + credentials.accessToken;

  var options = { method: method, headers: { 'Content-Type': 'application/json' } };
  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }

  var response = await fetch(url, options);
  var data = await response.json();

  if (data.error) {
    throw new Error(data.error.message || 'Meta API error');
  }

  return data;
}

// ===== CAMPANHAS =====

/**
 * Lista todas as campanhas da conta de anúncios
 */
async function getCampaigns(credentials) {
  return await apiCall(
    '/' + credentials.adAccountId + '/campaigns?fields=id,name,status,effective_status,objective,daily_budget,lifetime_budget,budget_remaining,created_time,updated_time&limit=100',
    'GET', null, credentials
  );
}

/**
 * Insights de uma campanha específica
 * @param {string} campaignId - ID da campanha Meta
 * @param {string} dateRange - today, yesterday, last_7d, last_30d, this_month
 * @param {object} credentials - { accessToken, adAccountId, appId, appSecret }
 */
async function getCampaignInsights(campaignId, dateRange, credentials) {
  var datePreset = convertDateRange(dateRange);
  return await apiCall(
    '/' + campaignId + '/insights?fields=spend,impressions,clicks,cpc,cpm,ctr,reach,frequency,actions,cost_per_action_type,cost_per_unique_click,unique_clicks,unique_ctr&date_preset=' + datePreset,
    'GET', null, credentials
  );
}

/**
 * Insights gerais da conta de anúncios
 */
async function getAccountInsights(dateRange, credentials) {
  var datePreset = convertDateRange(dateRange);
  return await apiCall(
    '/' + credentials.adAccountId + '/insights?fields=spend,impressions,clicks,cpc,cpm,ctr,reach,actions,cost_per_action_type&date_preset=' + datePreset,
    'GET', null, credentials
  );
}

/**
 * Insights com breakdown por dia
 */
async function getCampaignInsightsDaily(campaignId, days, credentials) {
  days = days || 30;
  var since = new Date();
  since.setDate(since.getDate() - days);
  var sinceStr = since.toISOString().split('T')[0];
  var untilStr = new Date().toISOString().split('T')[0];

  return await apiCall(
    '/' + campaignId + '/insights?fields=spend,impressions,clicks,cpc,actions,cost_per_action_type&time_range={"since":"' + sinceStr + '","until":"' + untilStr + '"}&time_increment=1',
    'GET', null, credentials
  );
}

// ===== GERENCIAMENTO =====

/**
 * Atualiza status da campanha
 * @param {string} campaignId
 * @param {string} status - ACTIVE ou PAUSED
 * @param {object} credentials - { accessToken, adAccountId, appId, appSecret }
 */
async function updateCampaignStatus(campaignId, status, credentials) {
  if (status !== 'ACTIVE' && status !== 'PAUSED') {
    throw new Error('Status deve ser ACTIVE ou PAUSED');
  }
  return await apiCall('/' + campaignId, 'POST', { status: status }, credentials);
}

/**
 * Atualiza orçamento da campanha
 * @param {string} campaignId
 * @param {number} budget - Valor em reais (ex: 50.00)
 * @param {string} type - daily ou lifetime
 * @param {object} credentials - { accessToken, adAccountId, appId, appSecret }
 */
async function updateCampaignBudget(campaignId, budget, type, credentials) {
  type = type || 'daily';
  var budgetCents = Math.round(budget * 100); // Meta usa centavos
  var field = type === 'daily' ? 'daily_budget' : 'lifetime_budget';
  var payload = {};
  payload[field] = budgetCents.toString();
  return await apiCall('/' + campaignId, 'POST', payload, credentials);
}

/**
 * Lista adsets de uma campanha
 */
async function getAdsets(campaignId, credentials) {
  return await apiCall(
    '/' + campaignId + '/adsets?fields=id,name,status,daily_budget,targeting,optimization_goal,bid_strategy&limit=100',
    'GET', null, credentials
  );
}

/**
 * Troca long-lived token (dura 60 dias)
 * @param {string} shortToken - Short-lived token to exchange
 * @param {object} credentials - { accessToken, adAccountId, appId, appSecret }
 */
async function exchangeToken(shortToken, credentials) {
  if (!credentials.appId || !credentials.appSecret) throw new Error('META_APP_ID e META_APP_SECRET necessários');

  return await apiCall(
    '/oauth/access_token?grant_type=fb_exchange_token&client_id=' + credentials.appId +
    '&client_secret=' + credentials.appSecret + '&fb_exchange_token=' + shortToken,
    'GET', null, credentials
  );
}

// ===== HELPERS =====

function convertDateRange(range) {
  var map = {
    'today': 'today',
    'yesterday': 'yesterday',
    'last_7d': 'last_7d',
    'last_14d': 'last_14d',
    'last_30d': 'last_30d',
    'this_month': 'this_month',
    'last_month': 'last_month',
    'this_year': 'this_year'
  };
  return map[range] || 'today';
}

module.exports = {
  getCampaigns: getCampaigns,
  getCampaignInsights: getCampaignInsights,
  getCampaignInsightsDaily: getCampaignInsightsDaily,
  getAccountInsights: getAccountInsights,
  updateCampaignStatus: updateCampaignStatus,
  updateCampaignBudget: updateCampaignBudget,
  getAdsets: getAdsets,
  exchangeToken: exchangeToken
};
