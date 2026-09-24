require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const cheerio = require("cheerio");

const app = express();
app.use(express.json({limit:"10mb"}));
app.use(express.static(path.join(__dirname,"public")));

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const APP_ID = process.env.MELI_APP_ID;
const APP_SECRET = process.env.MELI_APP_SECRET;
let account = { access_token:null, refresh_token:null, expires_at:0, user_id:null };

function requireConfig(){
  if(!APP_ID || !APP_SECRET) throw new Error("Configure MELI_APP_ID e MELI_APP_SECRET no .env.");
}
function normalizeUrl(raw){
  const u = new URL(raw);
  if(!["http:","https:"].includes(u.protocol)) throw new Error("URL inválida.");
  return u.toString();
}
function extractItemId(url){
  const m = String(url).match(/MLB\d{6,}/i);
  return m ? m[0].toUpperCase() : null;
}
async function tokenRequest(body){
  const r = await fetch("https://api.mercadolibre.com/oauth/token",{
    method:"POST",
    headers:{"accept":"application/json","content-type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams(body)
  });
  const data=await r.json();
  if(!r.ok) throw new Error(data.message || `OAuth ${r.status}`);
  return data;
}
async function refresh(){
  requireConfig();
  if(!account.refresh_token) throw new Error("Mercado Livre ainda não está conectado.");
  const data=await tokenRequest({
    grant_type:"refresh_token", client_id:APP_ID, client_secret:APP_SECRET,
    refresh_token:account.refresh_token
  });
  account={...account,access_token:data.access_token,refresh_token:data.refresh_token,
    expires_at:Date.now()+data.expires_in*1000,user_id:data.user_id};
  return account.access_token;
}
async function api(pathname){
  if(!account.access_token || Date.now()>account.expires_at-60000) await refresh();
  let r=await fetch(`https://api.mercadolibre.com${pathname}`,{
    headers:{Authorization:`Bearer ${account.access_token}`}
  });
  if(r.status===401){await refresh();r=await fetch(`https://api.mercadolibre.com${pathname}`,{headers:{Authorization:`Bearer ${account.access_token}`}})}
  const data=await r.json();
  if(!r.ok) throw new Error(data.message||`API ${r.status}`);
  return data;
}

app.get("/auth/mercadolivre",(req,res)=>{
  try{
    requireConfig();
    const state=crypto.randomBytes(24).toString("hex");
    // Prototype: state is kept in memory. Production should persist it per session.
    global.__meliState=state;
    const q=new URLSearchParams({
      response_type:"code",client_id:APP_ID,redirect_uri:`${BASE_URL}/auth/callback`,
      state
    });
    res.redirect(`https://auth.mercadolivre.com.br/authorization?${q.toString()}`);
  }catch(e){res.status(500).send(e.message)}
});

app.get("/auth/callback",async(req,res)=>{
  try{
    if(!req.query.code || req.query.state!==global.__meliState) throw new Error("Estado OAuth inválido.");
    const data=await tokenRequest({
      grant_type:"authorization_code",client_id:APP_ID,client_secret:APP_SECRET,
      code:req.query.code,redirect_uri:`${BASE_URL}/auth/callback`
    });
    account={access_token:data.access_token,refresh_token:data.refresh_token,
      expires_at:Date.now()+data.expires_in*1000,user_id:data.user_id};
    res.redirect("/?connected=1");
  }catch(e){res.redirect("/?error="+encodeURIComponent(e.message))}
});

app.get("/api/status",(req,res)=>{
  res.json({connected:!!account.access_token,user_id:account.user_id});
});

app.post("/api/import",async(req,res)=>{
  try{
    const raw=String(req.body?.url||"").trim();
    if(!raw) throw new Error("Cole um link de produto.");
    const url=normalizeUrl(raw);
    const itemId=extractItemId(url);
    if(!itemId) throw new Error("Este protótipo v3 está preparado para links de anúncios do Mercado Livre (MLB...).");
    const item=await api(`/items/${itemId}`);
    const images=(item.pictures||[]).map(p=>p.secure_url||p.url).filter(Boolean);
    res.json({
      id:item.id,title:item.title,price:item.price,currency:item.currency_id,
      original_price:item.original_price,image:images[0]||"",images,
      permalink:item.permalink||url,source:"Mercado Livre API"
    });
  }catch(e){res.status(400).json({error:e.message})}
});

app.listen(PORT,()=>console.log(`BRENEX v3: ${BASE_URL}`));
