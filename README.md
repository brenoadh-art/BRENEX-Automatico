# BRENEX Gerador Automático v3

## O que esta versão faz
1. Botão "Conectar Mercado Livre".
2. OAuth 2.0 no servidor.
3. Depois de conectado, você cola um link MLB do Mercado Livre.
4. O backend consulta `/items/{ITEM_ID}` e retorna título, preço e imagens.
5. A interface preenche os dados e gera a arte BRENEX.

## Configuração
1. Crie uma aplicação no DevCenter do Mercado Livre.
2. Configure o Redirect URI como:
   `http://localhost:3000/auth/callback` (teste local)
3. Copie o App ID e Client Secret para `.env`:
   MELI_APP_ID=...
   MELI_APP_SECRET=...
4. Instale:
   npm install
5. Rode:
   npm start
6. Abra:
   http://localhost:3000

## Produção
Use HTTPS e um domínio próprio. O refresh token deve ser armazenado com segurança em banco/secret manager, e o state OAuth deve ser persistido por sessão.

## Observação
O protótipo mantém tokens somente em memória para facilitar testes. Ao reiniciar o servidor, a conexão é perdida.
