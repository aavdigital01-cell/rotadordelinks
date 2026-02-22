# LinkRotator Pro - Guia de Instalação

## Arquivos do Projeto

| Arquivo | Descrição |
|---------|-----------|
| `index.html` | Página de login |
| `painel.html` | Painel administrativo completo |
| `r.html` | Rotacionador ultra-rápido (usado nos botões) |
| `config.js` | Configuração do Firebase |
| `firestore.rules` | Regras de segurança do banco de dados |

---

## Passo 1: Criar Projeto Firebase (Gratuito)

1. Acesse [console.firebase.google.com](https://console.firebase.google.com)
2. Clique em **"Adicionar projeto"**
3. Digite um nome (ex: "linkrotator") e clique **Continuar**
4. Desative o Google Analytics (opcional) e clique **Criar projeto**
5. Aguarde a criação e clique **Continuar**

## Passo 2: Registrar App Web

1. Na página inicial do projeto, clique no ícone **</>** (Web)
2. Digite um apelido (ex: "linkrotator-web")
3. **NÃO** marque "Firebase Hosting" (vamos hospedar no seu site)
4. Clique **Registrar app**
5. Copie os valores do `firebaseConfig` que aparecem
6. Clique **Continuar para o console**

## Passo 3: Configurar o config.js

Abra o arquivo `config.js` e substitua os valores com os que você copiou:

```javascript
const FIREBASE_CONFIG = {
  apiKey: "AIzaSy...",           // Cole sua API Key
  authDomain: "seu-projeto.firebaseapp.com",
  projectId: "seu-projeto",
  storageBucket: "seu-projeto.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc123"
};
```

## Passo 4: Ativar Autenticação

1. No painel do Firebase, vá em **Authentication** (menu lateral)
2. Clique em **Começar**
3. Na aba **Sign-in method**, clique em **Email/Senha**
4. Ative **Email/Senha** (o primeiro toggle)
5. Clique **Salvar**

## Passo 5: Criar Banco de Dados Firestore

1. No painel do Firebase, vá em **Firestore Database** (menu lateral)
2. Clique em **Criar banco de dados**
3. Selecione **Iniciar em modo de produção**
4. Escolha a localização mais próxima (ex: `southamerica-east1` para Brasil)
5. Clique **Ativar**

## Passo 6: Configurar Regras de Segurança

1. No Firestore, vá na aba **Regras**
2. Apague todo o conteúdo
3. Cole o conteúdo do arquivo `firestore.rules`
4. Clique **Publicar**

## Passo 7: Criar Índices do Firestore

No Firestore, vá na aba **Índices** e crie estes índices compostos:

### Índice 1 - Campanhas
- Coleção: `campaigns`
- Campos: `slug` (Ascendente), `isActive` (Ascendente)

### Índice 2 - Links
- Coleção: `links`
- Campos: `campaignId` (Ascendente), `isActive` (Ascendente), `isFull` (Ascendente)

**Nota:** Se os índices não existirem, o Firebase mostrará um link no console do navegador (F12) para criá-los automaticamente. Basta clicar no link.

## Passo 8: Upload dos Arquivos

Faça upload destes 4 arquivos para seu site (mesma pasta):
- `index.html`
- `painel.html`
- `r.html`
- `config.js`

---

## Como Usar

### 1. Criar sua conta
Acesse `seusite.com/index.html` e crie sua conta de administrador.

### 2. Criar uma campanha
No painel, vá em **Campanhas** > **Nova Campanha**:
- Nome: ex. "Campanha Principal"
- Slug: ex. "principal" (será usado na URL)
- Modo de Rotação: escolha o que preferir

### 3. Adicionar links
Vá em **Links** > **Novo Link**:
- Selecione a campanha
- Cole o link do grupo WhatsApp
- Defina o número de vagas (membros máximos)

### 4. Usar nos botões da sua página
Nos botões da sua página de captura, use a URL:

```
https://seusite.com/r.html?c=SLUG_DA_CAMPANHA
```

Exemplo: Se o slug é "principal":
```
https://seusite.com/r.html?c=principal
```

### Com parâmetros UTM (opcional):
```
https://seusite.com/r.html?c=principal&utm_source=facebook&utm_medium=ads&utm_campaign=black-friday
```

---

## Modos de Rotação

| Modo | Descrição |
|------|-----------|
| **Aleatório** | Distribui aleatoriamente entre os links disponíveis |
| **Sequencial** | Round-robin na ordem cadastrada (1, 2, 3, 1, 2, 3...) |
| **Por Peso** | Links com maior peso recebem proporcionalmente mais tráfego |
| **Menos Cheio** | Prioriza grupos com mais vagas disponíveis |

---

## Limites do Plano Gratuito Firebase

| Recurso | Limite |
|---------|--------|
| Leituras Firestore | 50.000/dia |
| Escritas Firestore | 20.000/dia |
| Storage | 1 GB |
| Autenticação | Ilimitado |

Para a maioria dos negócios, o plano gratuito é mais que suficiente. Cada click do visitante consome ~3 leituras e ~2 escritas.

**Estimativa:** Com o plano gratuito, você suporta ~6.500 clicks/dia.
Para mais, use o plano Blaze (pague conforme o uso).
