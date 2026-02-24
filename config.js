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
// 7. Backend usa PostgreSQL (Firestore não é mais necessário)
// ============================================

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDykCbXTvSAn8SawlQbXxJA6zAuQhSjZq4",
  authDomain: "linkrotator-2bae9.firebaseapp.com",
  projectId: "linkrotator-2bae9",
  storageBucket: "linkrotator-2bae9.firebasestorage.app",
  messagingSenderId: "948801458032",
  appId: "1:948801458032:web:ca78d46ff23c71e280c9b5"
};

// ============================================
// CONFIGURAÇÕES DO SISTEMA
// ============================================
const SYSTEM_CONFIG = {
  // URL do servidor backend (Meta API + WhatsApp Monitor)
  // Mude para a URL do seu VPS quando configurar
  serverUrl: "https://api.promosdetododia.com.br",

  // API gratuita para geolocalização (limite: 45 req/min)
  geoApiUrl: "https://ipapi.co/json/",

  // Percentual para alerta de grupo quase cheio
  alertThreshold: 90,

  // Máximo de tentativas de clique por IP por minuto (anti-bot)
  maxClicksPerMinute: 10,

  // Versão do sistema
  version: "2.0.0",

  // Nome do sistema
  appName: "LinkRotator Pro"
};
