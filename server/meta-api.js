/**
 * Meta (Facebook) Marketing API Module
 * Gerencia campanhas, adsets e coleta insights
 */

const fetch = require('node-fetch');

const BASE_URL = 'https://graph.facebook.com/v19.0';

function getToken() {
  return process.env.META_ACCESS_TOKEN;
}

function getAdAccountId() {
  return process.env.META_AD_ACCOUNT_ID;
}

async function apiCall(endpoint, method, body) {
  method = method || 'GET';
  var url = BASE_URL + endpoint;
  var separator = url.includes('?') ? '&' : '?';
  url += separator + 'access_token=' + getToken();

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
async function getCampaigns() {
  return await apiCall(
    '/' + getAdAccountId() + '/campaigns?fields=id,name,status,effective_status,objective,daily_budget,lifetime_budget,budget_remaining,created_time,updated_time&limit=100'
  );
}

/**
 * Insights de uma campanha específica
 * @param {string} campaignId - ID da campanha Meta
 * @param {string} dateRange - today, yesterday, last_7d, last_30d, this_month
 */
async function getCampaignInsights(campaignId, dateRange) {
  var datePreset = convertDateRange(dateRange);
  return await apiCall(
    '/' + campaignId + '/insights?fields=spend,impressions,clicks,cpc,cpm,ctr,reach,frequency,actions,cost_per_action_type,cost_per_unique_click,unique_clicks,unique_ctr&date_preset=' + datePreset
  );
}

/**
 * Insights gerais da conta de anúncios
 */
async function getAccountInsights(dateRange) {
  var datePreset = convertDateRange(dateRange);
  return await apiCall(
    '/' + getAdAccountId() + '/insights?fields=spend,impressions,clicks,cpc,cpm,ctr,reach,actions,cost_per_action_type&date_preset=' + datePreset
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
    '/' + campaignId + '/insights?fields=spend,impressions,clicks,cpc,actions,cost_per_action_type&time_range={"since":"' + sinceStr + '","until":"' + untilStr + '"}&time_increment=1'
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
 * @param {number} budget - Valor em reais (ex: 50.00)
 * @param {string} type - daily ou lifetime
 */
async function updateCampaignBudget(campaignId, budget, type) {
  type = type || 'daily';
  var budgetCents = Math.round(budget * 100); // Meta usa centavos
  var field = type === 'daily' ? 'daily_budget' : 'lifetime_budget';
  var payload = {};
  payload[field] = budgetCents.toString();
  return await apiCall('/' + campaignId, 'POST', payload);
}

/**
 * Lista adsets de uma campanha
 */
async function getAdsets(campaignId) {
  return await apiCall(
    '/' + campaignId + '/adsets?fields=id,name,status,daily_budget,targeting,optimization_goal,bid_strategy&limit=100'
  );
}

/**
 * Troca long-lived token (dura 60 dias)
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
