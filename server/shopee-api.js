/**
 * Shopee Affiliate API Module
 * Integração com a API GraphQL da Shopee para afiliados
 * Docs: https://www.affiliateshopee.com.br/documentacao
 */

const crypto = require('crypto');
const fetch = require('node-fetch');

const BASE_URL = 'https://open-api.affiliate.shopee.com.br/graphql';

var appId = '';
var secret = '';

function configure(config) {
  if (config.appId) appId = config.appId;
  if (config.secret) secret = config.secret;
}

function isConfigured() {
  return !!(appId && secret);
}

function generateSignature(payload) {
  var timestamp = Math.floor(Date.now() / 1000);
  var signatureString = appId + timestamp.toString() + payload + secret;
  var signature = crypto.createHash('sha256').update(signatureString).digest('hex');
  return { timestamp: timestamp, signature: signature };
}

async function graphqlRequest(query) {
  if (!isConfigured()) {
    throw new Error('Shopee API não configurada. Configure App ID e Secret nas Configurações.');
  }

  var payload = JSON.stringify({ query: query });
  var auth = generateSignature(payload);

  var response = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'SHA256 Credential=' + appId + ', Timestamp=' + auth.timestamp + ', Signature=' + auth.signature
    },
    body: payload,
    timeout: 15000
  });

  var data = await response.json();

  if (data.errors && data.errors.length > 0) {
    throw new Error('Shopee API: ' + data.errors[0].message);
  }

  return data.data;
}

// ===== BUSCA DE PRODUTOS =====

/**
 * Busca produtos com comissões
 * sortType: 1=Relevância, 2=Mais vendidos, 3=Maior preço, 4=Menor preço, 5=Maior comissão
 * listType: 0=Recomendados, 1=Maior comissão, 2=Top performance
 */
async function searchProducts(options) {
  options = options || {};
  var keyword = options.keyword || '';
  var page = parseInt(options.page) || 1;
  var limit = parseInt(options.limit) || 20;
  var sortType = parseInt(options.sortType) || 1;
  var listType = parseInt(options.listType);

  var params = 'keyword: "' + keyword.replace(/"/g, '\\"') + '", sortType: ' + sortType + ', page: ' + page + ', limit: ' + limit;
  if (!isNaN(listType)) {
    params += ', listType: ' + listType;
  }

  var query = '{ productOfferV2(' + params + ') { ' +
    'nodes { ' +
      'itemId productName productLink offerLink imageUrl ' +
      'priceMin priceMax priceDiscountRate sales ratingStar ' +
      'commissionRate sellerCommissionRate shopeeCommissionRate commission ' +
      'shopId shopName shopType periodStartTime periodEndTime ' +
    '} ' +
    'pageInfo { page limit hasNextPage } ' +
  '} }';

  var data = await graphqlRequest(query);
  return data.productOfferV2;
}

/**
 * Busca melhores ofertas (maior comissão)
 */
async function getTopOffers(options) {
  options = options || {};
  var page = parseInt(options.page) || 1;
  var limit = parseInt(options.limit) || 20;
  var sortType = parseInt(options.sortType) || 5;

  var query = '{ productOfferV2(sortType: ' + sortType + ', listType: 1, page: ' + page + ', limit: ' + limit + ') { ' +
    'nodes { ' +
      'itemId productName productLink offerLink imageUrl ' +
      'priceMin priceMax priceDiscountRate sales ratingStar ' +
      'commissionRate sellerCommissionRate shopeeCommissionRate commission ' +
      'shopId shopName shopType ' +
    '} ' +
    'pageInfo { page limit hasNextPage } ' +
  '} }';

  var data = await graphqlRequest(query);
  return data.productOfferV2;
}

/**
 * Busca lojas com comissões diferenciadas
 * sortType: 1=Mais recentes, 2=Maior comissão, 3=Populares
 */
async function searchShops(options) {
  options = options || {};
  var keyword = options.keyword || '';
  var page = parseInt(options.page) || 1;
  var limit = parseInt(options.limit) || 20;
  var sortType = parseInt(options.sortType) || 2;

  var query = '{ shopOfferV2(keyword: "' + keyword.replace(/"/g, '\\"') + '", sortType: ' + sortType + ', page: ' + page + ', limit: ' + limit + ') { ' +
    'nodes { ' +
      'shopId shopName commissionRate ratingStar shopType imageUrl offerLink ' +
      'remainingBudget sellerCommCoveRatio periodStartTime periodEndTime ' +
    '} ' +
    'pageInfo { page limit hasNextPage } ' +
  '} }';

  var data = await graphqlRequest(query);
  return data.shopOfferV2;
}

/**
 * Busca campanhas e ofertas especiais da Shopee
 * sortType: 1=Mais recentes, 2=Maior comissão
 */
async function getShopeeOffers(options) {
  options = options || {};
  var page = parseInt(options.page) || 1;
  var limit = parseInt(options.limit) || 20;
  var sortType = parseInt(options.sortType) || 2;

  var query = '{ shopeeOfferV2(sortType: ' + sortType + ', page: ' + page + ', limit: ' + limit + ') { ' +
    'nodes { ' +
      'commissionRate imageUrl offerLink originalLink offerName offerType ' +
      'categoryId collectionId periodStartTime periodEndTime ' +
    '} ' +
    'pageInfo { page limit hasNextPage } ' +
  '} }';

  var data = await graphqlRequest(query);
  return data.shopeeOfferV2;
}

// ===== GERAÇÃO DE LINKS =====

/**
 * Gera link de afiliado a partir de URL da Shopee
 * @param {string} originalUrl - URL original do produto
 * @param {string[]} subIds - SubIDs para rastreamento (até 5)
 */
async function generateAffiliateLink(originalUrl, subIds) {
  if (typeof subIds === 'string') subIds = [subIds];
  subIds = subIds || ['whatsapp'];

  var subIdsStr = subIds.map(function(s) { return '"' + s.replace(/"/g, '\\"') + '"'; }).join(', ');

  var query = 'mutation { generateShortLink(input: { ' +
    'originUrl: "' + originalUrl.replace(/"/g, '\\"') + '", ' +
    'subIds: [' + subIdsStr + '] ' +
  '}) { shortLink } }';

  var data = await graphqlRequest(query);
  return data.generateShortLink;
}

// ===== RELATÓRIOS DE CONVERSÃO =====

/**
 * Busca relatório de conversões
 * @param {object} options - purchaseTimeStart, purchaseTimeEnd (Unix timestamps), orderStatus, limit, scrollId
 * orderStatus: UNPAID, PENDING, COMPLETED, CANCELLED
 */
async function getConversionReport(options) {
  options = options || {};

  // Default: últimos 30 dias
  var now = Math.floor(Date.now() / 1000);
  var thirtyDaysAgo = now - (30 * 24 * 3600);

  var purchaseTimeStart = parseInt(options.purchaseTimeStart) || thirtyDaysAgo;
  var purchaseTimeEnd = parseInt(options.purchaseTimeEnd) || now;
  var limit = parseInt(options.limit) || 100;

  var params = 'purchaseTimeStart: ' + purchaseTimeStart + ', purchaseTimeEnd: ' + purchaseTimeEnd + ', limit: ' + limit;

  if (options.orderStatus) {
    params += ', orderStatus: "' + options.orderStatus + '"';
  }
  if (options.scrollId) {
    params += ', scrollId: "' + options.scrollId.replace(/"/g, '\\"') + '"';
  }

  var query = '{ conversionReport(' + params + ') { ' +
    'nodes { ' +
      'purchaseTime clickTime conversionId ' +
      'totalCommission sellerCommission shopeeCommissionCapped ' +
      'buyerType device utmContent ' +
      'orders { ' +
        'orderId orderStatus ' +
        'items { itemId itemName shopName itemPrice qty itemTotalCommission } ' +
      '} ' +
    '} ' +
    'pageInfo { limit hasNextPage scrollId } ' +
  '} }';

  var data = await graphqlRequest(query);
  return data.conversionReport;
}

/**
 * Busca relatório validado de comissões
 * @param {object} options - validationId, limit, scrollId
 */
async function getValidatedReport(options) {
  options = options || {};
  var validationId = parseInt(options.validationId) || 0;
  var limit = parseInt(options.limit) || 100;

  var params = 'validationId: ' + validationId + ', limit: ' + limit;
  if (options.scrollId) {
    params += ', scrollId: "' + options.scrollId.replace(/"/g, '\\"') + '"';
  }

  var query = '{ validatedReport(' + params + ') { ' +
    'nodes { ' +
      'conversionId netCommission totalCommission ' +
      'orders { orderId items { itemName itemTotalCommission refundAmount } } ' +
    '} ' +
    'pageInfo { hasNextPage scrollId } ' +
  '} }';

  var data = await graphqlRequest(query);
  return data.validatedReport;
}

module.exports = {
  configure: configure,
  isConfigured: isConfigured,
  searchProducts: searchProducts,
  getTopOffers: getTopOffers,
  searchShops: searchShops,
  getShopeeOffers: getShopeeOffers,
  generateAffiliateLink: generateAffiliateLink,
  getConversionReport: getConversionReport,
  getValidatedReport: getValidatedReport
};
