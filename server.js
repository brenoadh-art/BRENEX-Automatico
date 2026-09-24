require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const cheerio = require("cheerio");

const app = express();

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const APP_ID = process.env.MELI_APP_ID;
const APP_SECRET = process.env.MELI_APP_SECRET;

let account = {
  access_token: null,
  refresh_token: null,
  expires_at: 0,
  user_id: null
};

function requireConfig() {
  if (!APP_ID || !APP_SECRET) {
    throw new Error("Configure MELI_APP_ID e MELI_APP_SECRET no .env.");
  }
}

function normalizeUrl(raw) {
  const u = new URL(raw);

  if (!["http:", "https:"].includes(u.protocol)) {
    throw new Error("URL inválida.");
  }

  return u.toString();
}

function extractItemId(value) {
  const m = String(value).match(/MLB[-]?\d{6,}/i);

  return m
    ? m[0].replace("-", "").toUpperCase()
    : null;
}

/*
 * Resolve meli.la e procura o MLB:
 * 1. na URL final do redirecionamento;
 * 2. no HTML retornado;
 * 3. em URLs encontradas no HTML;
 * 4. em canonical / og:url / twitter:url / meta refresh.
 */
async function resolveAffiliateUrl(url) {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();

  if (!host.endsWith("meli.la")) {
    return {
      resolvedUrl: url,
      itemId: extractItemId(url)
    };
  }

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36",

    "Accept":
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",

    "Accept-Language":
      "pt-BR,pt;q=0.9,en;q=0.8"
  };

  let response;

  try {
    response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers
    });
  } catch (err) {
    throw new Error(
      `Não foi possível abrir o link meli.la: ${err.message}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Não foi possível resolver o link meli.la (HTTP ${response.status}).`
    );
  }

  const finalUrl = response.url || url;

  let html = "";

  try {
    html = await response.text();
  } catch (_) {}

  // 1. Procura o MLB na URL final.
  let itemId = extractItemId(finalUrl);

  // 2. Procura o MLB diretamente no HTML.
  if (!itemId && html) {
    itemId = extractItemId(html);
  }

  // 3. Procura URLs dentro do HTML.
  if (!itemId && html) {
    const urls =
      html.match(/https?:\/\/[^"'\\s<>]+/gi) || [];

    for (const candidate of urls) {
      const clean = candidate
        .replace(/&amp;/g, "&")
        .replace(/[),.;]+$/, "");

      const candidateId =
        extractItemId(clean);

      if (candidateId) {
        itemId = candidateId;
        break;
      }
    }
  }

  // 4. Procura nos metadados da página.
  if (!itemId && html) {
    try {
      const $ = cheerio.load(html);

      const candidates = [
        $('link[rel="canonical"]').attr("href"),
        $('meta[property="og:url"]').attr("content"),
        $('meta[name="twitter:url"]').attr("content"),
        $('meta[http-equiv="refresh"]').attr("content")
      ].filter(Boolean);

      for (const candidate of candidates) {
        const candidateId =
          extractItemId(candidate);

        if (candidateId) {
          itemId = candidateId;
          break;
        }
      }
    } catch (_) {}
  }

  if (!itemId) {
    throw new Error(
      "O link meli.la foi aberto, mas não encontrei o ID do anúncio (MLB)."
    );
  }

  return {
    resolvedUrl: finalUrl,
    itemId
  };
}

async function tokenRequest(body) {
  const r = await fetch(
    "https://api.mercadolibre.com/oauth/token",
    {
      method: "POST",

      headers: {
        accept: "application/json",
        "content-type":
          "application/x-www-form-urlencoded"
      },

      body: new URLSearchParams(body)
    }
  );

  const data = await r.json();

  if (!r.ok) {
    throw new Error(
      data.message || `OAuth ${r.status}`
    );
  }

  return data;
}

async function refresh() {
  requireConfig();

  if (!account.refresh_token) {
    throw new Error(
      "Mercado Livre ainda não está conectado."
    );
  }

  const data = await tokenRequest({
    grant_type: "refresh_token",
    client_id: APP_ID,
    client_secret: APP_SECRET,
    refresh_token: account.refresh_token
  });

  account = {
    ...account,

    access_token: data.access_token,

    refresh_token:
      data.refresh_token,

    expires_at:
      Date.now() +
      data.expires_in * 1000,

    user_id: data.user_id
  };

  return account.access_token;
}

async function api(pathname) {
  if (
    !account.access_token ||
    Date.now() >
      account.expires_at - 60000
  ) {
    await refresh();
  }

  let r = await fetch(
    `https://api.mercadolibre.com${pathname}`,
    {
      headers: {
        Authorization:
          `Bearer ${account.access_token}`
      }
    }
  );

  if (r.status === 401) {
    await refresh();

    r = await fetch(
      `https://api.mercadolibre.com${pathname}`,
      {
        headers: {
          Authorization:
            `Bearer ${account.access_token}`
        }
      }
    );
  }

  const data = await r.json();

  if (!r.ok) {
    throw new Error(
      data.message || `API ${r.status}`
    );
  }

  return data;
}


/*
 * CONEXÃO COM MERCADO LIVRE
 */

app.get(
  "/auth/mercadolivre",
  (req, res) => {
    try {
      requireConfig();

      const state =
        crypto
          .randomBytes(24)
          .toString("hex");

      global.__meliState = state;

      const q =
        new URLSearchParams({
          response_type: "code",

          client_id: APP_ID,

          redirect_uri:
            `${BASE_URL}/auth/callback`,

          state
        });

      res.redirect(
        `https://auth.mercadolivre.com.br/authorization?${q.toString()}`
      );

    } catch (e) {
      res.status(500).send(e.message);
    }
  }
);

app.get(
  "/auth/callback",
  async (req, res) => {
    try {
      if (
        !req.query.code ||
        req.query.state !==
          global.__meliState
      ) {
        throw new Error(
          "Estado OAuth inválido."
        );
      }

      const data =
        await tokenRequest({
          grant_type:
            "authorization_code",

          client_id: APP_ID,

          client_secret:
            APP_SECRET,

          code: req.query.code,

          redirect_uri:
            `${BASE_URL}/auth/callback`
        });

      account = {
        access_token:
          data.access_token,

        refresh_token:
          data.refresh_token,

        expires_at:
          Date.now() +
          data.expires_in * 1000,

        user_id:
          data.user_id
      };

      res.redirect(
        "/?connected=1"
      );

    } catch (e) {
      res.redirect(
        "/?error=" +
        encodeURIComponent(e.message)
      );
    }
  }
);

app.get(
  "/api/status",
  (req, res) => {
    res.json({
      connected:
        !!account.access_token,

      user_id:
        account.user_id
    });
  }
);


/*
 * IMPORTAÇÃO DO PRODUTO
 */

app.post(
  "/api/import",
  async (req, res) => {
    try {
      const raw =
        String(
          req.body?.url || ""
        ).trim();

      if (!raw) {
        throw new Error(
          "Cole um link de produto."
        );
      }

      // Preserva o link original
      // do afiliado.
      const originalUrl =
        normalizeUrl(raw);

      // Resolve o meli.la
      // e encontra o MLB.
      const resolved =
        await resolveAffiliateUrl(
          originalUrl
        );

      const resolvedUrl =
        resolved.resolvedUrl;

      const itemId =
        resolved.itemId;

      if (!itemId) {
        throw new Error(
          "Não consegui identificar o produto nesse link."
        );
      }

      // Consulta o produto
      // na API do Mercado Livre.
      const item =
        await api(
          `/items/${itemId}`
        );

      const images =
        (item.pictures || [])
          .map(
            p =>
              p.secure_url ||
              p.url
          )
          .filter(Boolean);

      res.json({

        id: item.id,

        title: item.title,

        price: item.price,

        currency:
          item.currency_id,

        original_price:
          item.original_price,

        image:
          images[0] || "",

        images,

        // URL normal do produto.
        permalink:
          item.permalink ||
          resolvedUrl,

        // IMPORTANTE:
        // mantém o link de afiliado.
        affiliate_url:
          originalUrl,

        // URL descoberta.
        resolved_url:
          resolvedUrl,

        source:
          "Mercado Livre API"
      });

    } catch (e) {

      console.error(
        "Erro /api/import:",
        e
      );

      res.status(400).json({
        error: e.message
      });
    }
  }
);


app.listen(
  PORT,
  () => {
    console.log(
      `BRENEX v3: ${BASE_URL}`
    );
  }
);
