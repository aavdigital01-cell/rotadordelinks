# Servidor Backend - Guia de Instalação

O servidor é necessário para:
- **Meta Ads API** - Dados reais de campanhas, custos, gerenciamento
- **WhatsApp Monitor** - Contagem real de membros nos grupos

## Requisitos

- **VPS** com Node.js 18+ (DigitalOcean, Vultr, Contabo, etc. - a partir de R$25/mês)
- Ou rodar no **seu computador** para testes

## Passo 1: Instalar Node.js

No VPS (Ubuntu/Debian):
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo apt-get install -y chromium-browser  # Necessário para WhatsApp
```

## Passo 2: Clonar e instalar

```bash
git clone https://github.com/aavdigital01-cell/rotadordelinks.git
cd rotadordelinks/server
npm install
```

## Passo 3: Firebase Service Account

1. Acesse [console.firebase.google.com](https://console.firebase.google.com)
2. Seu projeto → Engrenagem → **Configurações do projeto**
3. Aba **Contas de serviço**
4. Clique **Gerar nova chave privada**
5. Baixe o JSON e copie os valores para o `.env`

## Passo 4: Meta Ads API

1. Acesse [developers.facebook.com](https://developers.facebook.com)
2. **Meus Apps** → **Criar App** → Tipo **Business**
3. Adicione o produto **Marketing API**
4. Vá em **Ferramentas** → **Graph API Explorer**
5. Selecione seu app
6. Gere um token com permissões: `ads_read`, `ads_management`
7. Clique **Generate Access Token** e copie
8. Para pegar seu Ad Account ID:
   - No Facebook Ads Manager, o ID aparece na URL: `act_XXXXXXXXX`

## Passo 5: Configurar .env

```bash
cp .env.example .env
nano .env
```

Preencha:
```
PORT=3000
FRONTEND_URL=https://rotador.promosdetododia.com.br

FIREBASE_PROJECT_ID=linkrotator-2bae9
FIREBASE_CLIENT_EMAIL=cole-o-client-email-do-json
FIREBASE_PRIVATE_KEY="cole-a-private-key-do-json"

META_ACCESS_TOKEN=cole-seu-token
META_AD_ACCOUNT_ID=act_XXXXXXXXX
META_APP_ID=seu-app-id
META_APP_SECRET=seu-app-secret
```

## Passo 6: Iniciar

```bash
node index.js
```

Na primeira vez, um **QR Code** aparecerá no terminal. Escaneie com o WhatsApp do número que administra os grupos.

## Passo 7: Manter rodando (produção)

Use PM2 para manter o servidor rodando:
```bash
npm install -g pm2
pm2 start index.js --name linkrotator
pm2 startup  # Auto-inicia no boot
pm2 save
```

## Passo 8: Atualizar config.js no site

No arquivo `config.js` do seu site, atualize:
```javascript
serverUrl: "http://SEU-IP-DO-VPS:3000"
```

Se tiver domínio apontando para o VPS:
```javascript
serverUrl: "https://api.seudominio.com"
```

## Monitoramento

```bash
pm2 logs linkrotator    # Ver logs
pm2 status              # Ver status
pm2 restart linkrotator # Reiniciar
```

## Notas Importantes

- O **token do Meta** expira em 60 dias. Renove periodicamente.
- O **WhatsApp** pode desconectar se o celular ficar muito tempo offline.
- Use **HTTPS** em produção (configure nginx como reverse proxy).
- O servidor sincroniza dados do Meta a cada 5 minutos automaticamente.
- Os grupos do WhatsApp são escaneados a cada 15 minutos.
