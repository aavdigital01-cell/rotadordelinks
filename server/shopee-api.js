/**
 * Shopee Affiliate API Module
 * Integração com a API GraphQL da Shopee para afiliados
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

async function graphqlRequest(query, variables) {
  if (!isConfigured()) {
    throw new Error('Shopee API não configurada. Configure App ID e Secret nas Configurações.');
  }

  var payload = JSON.stringify({ query: query, variables: variables || {} });
  var auth = generateSignature(payload);

  var response = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'SHA256 Credential=' + appId + ',Timestamp=' + auth.timestamp + ',Signature=' + auth.signature
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
 * @param {object} options - keyword, page, limit, sortType
 */
async function searchProducts(options) {
  options = options || {};
  var keyword = options.keyword || '';
  var page = options.page || 1;
  var limit = options.limit || 20;
  var sortType = options.sortType || 'relevance';

  var query = '{\n' +
    '  productOfferV2(\n' +
    '    keyword: "' + keyword.replace(/"/g, '\\"') + '",\n' +
    '    page: ' + page + ',\n' +
    '    limit: ' + limit + ',\n' +
    '    sortType: ' + sortType + '\n' +
    '  ) {\n' +
    '    nodes {\n' +
    '      itemId\n' +
    '      productName\n' +
    '      productLink\n' +
    '      offerLink\n' +
    '      imageUrl\n' +
    '      price\n' +
    '      priceMin\n' +
    '      priceMax\n' +
    '      commission\n' +
    '      commissionRate\n' +
    '      sales\n' +
    '      ratingStar\n' +
    '      shopName\n' +
    '      shopId\n' +
    '      categoryName\n' +
    '    }\n' +
    '    pageInfo {\n' +
    '      page\n' +
    '      limit\n' +
    '      hasNextPage\n' +
    '    }\n' +
    '  }\n' +
    '}';

  var data = await graphqlRequest(query);
  return data.productOfferV2;
}

/**
 * Busca melhores ofertas / produtos em promoção
 */
async function getTopOffers(options) {
  options = options || {};
  var page = options.page || 1;
  var limit = options.limit || 20;
  var sortType = options.sortType || 'commission_rate';

  var query = '{\n' +
    '  productOfferV2(\n' +
    '    keyword: "",\n' +
    '    page: ' + page + ',\n' +
    '    limit: ' + limit + ',\n' +
    '    sortType: ' + sortType + '\n' +
    '  ) {\n' +
    '    nodes {\n' +
    '      itemId\n' +
    '      productName\n' +
    '      productLink\n' +
    '      offerLink\n' +
    '      imageUrl\n' +
    '      price\n' +
    '      commission\n' +
    '      commissionRate\n' +
    '      sales\n' +
    '      ratingStar\n' +
    '      shopName\n' +
    '      categoryName\n' +
    '    }\n' +
    '    pageInfo {\n' +
    '      page\n' +
    '      limit\n' +
    '      hasNextPage\n' +
    '    }\n' +
    '  }\n' +
    '}';

  var data = await graphqlRequest(query);
  return data.productOfferV2;
}

/**
 * Busca lojas com comissões
 */
async function searchShops(options) {
  options = options || {};
  var keyword = options.keyword || '';
  var page = options.page || 1;
  var limit = options.limit || 20;

  var query = '{\n' +
    '  shopOfferV2(\n' +
    '    keyword: "' + keyword.replace(/"/g, '\\"') + '",\n' +
    '    page: ' + page + ',\n' +
    '    limit: ' + limit + '\n' +
    '  ) {\n' +
    '    nodes {\n' +
    '      shopId\n' +
    '      shopName\n' +
    '      commissionRate\n' +
    '      ratingStar\n' +
    '      shopType\n' +
    '      imageUrl\n' +
    '      offerLink\n' +
    '    }\n' +
    '    pageInfo {\n' +
    '      page\n' +
    '      limit\n' +
    '      hasNextPage\n' +
    '    }\n' +
    '  }\n' +
    '}';

  var data = await graphqlRequest(query);
  return data.shopOfferV2;
}

// ===== GERAÇÃO DE LINKS =====

/**
 * Gera link de afiliado a partir de URL da Shopee
 * @param {string} originalUrl - URL original do produto
 * @param {string} subId - SubID para rastreamento (ex: 'whatsapp')
 */
async function generateAffiliateLink(originalUrl, subId) {
  subId = subId || 'whatsapp';

  var query = '{\n' +
    '  generateShortLink(\n' +
    '    input: {\n' +
    '      originUrl: "' + originalUrl.replace(/"/g, '\\"') + '",\n' +
    '      subIds: ["' + subId.replace(/"/g, '\\"') + '"]\n' +
    '    }\n' +
    '  ) {\n' +
    '    shortLink\n' +
    '  }\n' +
    '}';

  var data = await graphqlRequest(query);
  return data.generateShortLink;
}

// ===== RELATÓRIOS DE COMISSÃO =====

/**
 * Busca relatório de conversões
 * @param {object} options - startDate, endDate, subId
 */
async function getConversionReport(options) {
  options = options || {};
  var startDate = options.startDate || new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().split('T')[0];
  var endDate = options.endDate || new Date().toISOString().split('T')[0];

  var filters = '';
  if (options.subId) {
    filters = ', publisherSubId: "' + options.subId.replace(/"/g, '\\"') + '"';
  }

  var query = '{\n' +
    '  conversionReport(\n' +
    '    startTime: "' + startDate + '",\n' +
    '    endTime: "' + endDate + '"' + filters + '\n' +
    '  ) {\n' +
    '    nodes {\n' +
    '      orderId\n' +
    '      orderAmount\n' +
    '      commission\n' +
    '      commissionRate\n' +
    '      status\n' +
    '      itemName\n' +
    '      itemId\n' +
    '      shopName\n' +
    '      publisherSubId\n' +
    '      orderCreatedTime\n' +
    '      clickTime\n' +
    '    }\n' +
    '    pageInfo {\n' +
    '      hasNextPage\n' +
    '    }\n' +
    '    summary {\n' +
    '      totalOrders\n' +
    '      totalCommission\n' +
    '      totalOrderAmount\n' +
    '    }\n' +
    '  }\n' +
    '}';

  var data = await graphqlRequest(query);
  return data.conversionReport;
}

module.exports = {
  configure: configure,
  isConfigured: isConfigured,
  searchProducts: searchProducts,
  getTopOffers: getTopOffers,
  searchShops: searchShops,
  generateAffiliateLink: generateAffiliateLink,
  getConversionReport: getConversionReport
};
