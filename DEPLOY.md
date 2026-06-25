# Deploy na Vercel com login Google

Este repo esta preparado para rodar como um servidor Node/Express na Vercel. A Vercel detecta `server.js` e o transforma em uma Function Node.

## 1. Criar OAuth Client no Google

No Google Cloud Console:

1. Crie ou selecione um projeto.
2. Va em `APIs & Services -> Credentials`.
3. Crie `OAuth client ID` do tipo `Web application`.
4. Em `Authorized JavaScript origins`, adicione:

```text
https://SEU-PROJETO.vercel.app
```

5. Copie o `Client ID`; ele sera usado em `GOOGLE_CLIENT_ID`.

## 2. Importar o repo na Vercel

1. Na Vercel, importe `diogenes-a-jr/finboard-public`.
2. Framework preset: `Other`.
3. Configure as variaveis de ambiente:

```env
NODE_ENV=production
FINBOARD_REQUIRE_LOGIN=true
APP_BASE_URL=https://SEU-PROJETO.vercel.app
APP_TOKEN=gere-um-token-aleatorio-com-32-bytes
GOOGLE_CLIENT_ID=seu-client-id.apps.googleusercontent.com
GOOGLE_ALLOWED_EMAILS=seu-email@gmail.com
PLUGGY_CLIENT_ID=seu-client-id-pluggy
PLUGGY_CLIENT_SECRET=seu-client-secret-pluggy
PLUGGY_ITEM_IDS=
PLUGGY_WEBHOOK_URL=https://SEU-PROJETO.vercel.app/api/webhooks/pluggy
DB_PATH=/tmp/finboard.db
SETTINGS_PATH=/tmp/settings.json
```

Para gerar `APP_TOKEN`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 3. Configurar webhook na Pluggy

No setup da Pluggy, registre:

```text
https://SEU-PROJETO.vercel.app/api/webhooks/pluggy
```

O app tambem envia essa URL dentro do Connect Token quando `PLUGGY_WEBHOOK_URL` esta configurado.

## 4. Usar o app

1. Abra `https://SEU-PROJETO.vercel.app`.
2. Entre com a conta Google listada em `GOOGLE_ALLOWED_EMAILS`.
3. Va em `Admin -> Conectar banco`.
4. Ao concluir o Pluggy Connect, o `itemId` e salvo automaticamente no runtime atual.
5. Para persistir no plano gratuito da Vercel, copie o itemId para `PLUGGY_ITEM_IDS` nas variaveis de ambiente e redeploy.

## Limite importante da Vercel gratuita

O filesystem da Function nao e persistente. Com `DB_PATH=/tmp/finboard.db` e `SETTINGS_PATH=/tmp/settings.json`, itemIds e customizacoes salvas pelo app podem ser perdidos entre cold starts. As credenciais Pluggy, o Google login e o webhook funcionam por variaveis de ambiente, mas persistencia duravel de regras/categorias deve ser migrada depois para Vercel Postgres, Supabase ou outro KV externo.
