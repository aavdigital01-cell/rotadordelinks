// ============================================
// CONFIGURAÇÃO DO FIREBASE
// ============================================
// INSTRUÇÕES DE SETUP:
// 1. Acesse https://console.firebase.google.com
// 2. Clique em "Adicionar projeto" e crie um projeto
// 3. No painel do projeto, clique na engrenagem > Configurações do projeto
// 4. Em "Seus apps", clique no ícone </> (Web)
// 5. Registre o app e copie os valores abaixo
// 6. Ative Authentication > Email/Senha nas configurações
// 7. Ative Firestore Database e crie em modo produção
// 8. Copie as regras do arquivo firestore.rules para o Firestore Rules
// ============================================

const FIREBASE_CONFIG = {
  apiKey: "COLE_SUA_API_KEY_AQUI",
  authDomain: "SEU_PROJETO.firebaseapp.com",
  projectId: "SEU_PROJETO_ID",
  storageBucket: "SEU_PROJETO.appspot.com",
  messagingSenderId: "SEU_SENDER_ID",
  appId: "SEU_APP_ID"
};

// ============================================
// CONFIGURAÇÕES DO SISTEMA
// ============================================
const SYSTEM_CONFIG = {
  // API gratuita para geolocalização (limite: 45 req/min)
  geoApiUrl: "https://ipapi.co/json/",

  // Percentual para alerta de grupo quase cheio
  alertThreshold: 90,

  // Máximo de tentativas de clique por IP por minuto (anti-bot)
  maxClicksPerMinute: 10,

  // Versão do sistema
  version: "1.0.0",

  // Nome do sistema
  appName: "LinkRotator Pro"
};
