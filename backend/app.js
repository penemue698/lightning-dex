const express = require('express')
const app = express()
const LNInvoice = require("@node-lightning/invoice");
const { Pool } = require('pg');
const crypto = require('crypto');
const nodeChildProcess = require('node:child_process');
const util = require('node:util');
const dotenv = require('dotenv');
const { ethers } = require('ethers');
const solana = require('@solana/web3.js')
const {v4: uuid} = require('uuid')
const axios = require('axios')

dotenv.config();

const exec = util.promisify(nodeChildProcess.exec);

const db = new Pool({
  host: 'localhost',
  port: 5432,
  database: process.env.POSTGRES_DB,
  user: 'postgres',
  password: 'postgres'
});

// CORS
app.use('/', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept'
  )
  res.header('Access-Control-Allow-Methods', 'GET, POST')
  next()
})

app.use(express.json());

app.get('/btc_deposit', async (req, res, next) => {
  const outgoing_currency = req.query.outgoing_currency;
  const outgoing_address = req.query.outgoing_address;

  const valid_outgoing_currencies = ["ETH"];
  if (!valid_outgoing_currencies.includes(outgoing_currency)) return next("Bad outgoing_currency")
  if (!outgoing_address) return next("Must set outgoing_address")
  if (!ethers.isAddress(outgoing_address)) return next("Invalid outgoing_address")

  const deposit_address = await db.query("SELECT * FROM deposit_addresses WHERE deposit_currency=$1 AND outgoing_currency=$2 AND outgoing_address=$3 LIMIT 1", ["BTC", outgoing_currency, outgoing_address]);

  if (deposit_address.rows.length > 0) return res.status(200).json(deposit_address.rows[0]);
  else {
    const addressgen = await exec(`${process.env.BITCOIN_CLI_PREFIX} getnewaddress`);
    const deposit_address = addressgen.stdout.trim();
    try {
      await db.query("INSERT INTO deposit_addresses (deposit_currency, deposit_address, outgoing_currency, outgoing_address) VALUES ($1,$2,$3,$4)", ["BTC", deposit_address, outgoing_currency, outgoing_address]);
    } catch (e) {
      return next(e);
    }
    return res.status(200).json({ deposit_address, outgoing_currency, outgoing_address });
  }
});

app.get("/history/:address", async (req, res, next) => {
    if (!req.params.address) return next("GET /history/:address. Missing address");
    try {
      const bridges = await db.query("SELECT * FROM bridges WHERE LOWER(deposit_address)=$1 OR LOWER(outgoing_address)=$1", [req.params.address.toLowerCase()]);
      return res.status(200).json(bridges.rows);
    } catch (e) {
      return next(e);
    }
});

function deriveSolanaDepositAddress (depositId) {
  const masterPrivateKey = Buffer.from(process.env.SOL_LIQUIDITY_ACCOUNT_PRIV_KEY_BASE58, 'utf-8')
  const seed = crypto.createHash('sha256').update(masterPrivateKey).update(depositId).digest()
  return solana.Keypair.fromSeed(seed).publicKey.toString()
}

const SOL_DEPOSIT_EXPIRY_PERIOD = 3600 // 1 hour

app.get('/sol_deposit', async (req, res, next) => {
  const outgoingCurrency = req.query.outgoing_currency
  const outgoingAddress = req.query.outgoing_address

  if (outgoingCurrency !== 'ETH') return next('Only eth bridges supported')
  if (!ethers.isAddress(outgoingAddress)) return next("Invalid outgoing_address")
  
  const depositId = uuid()
  const depositAddress = deriveSolanaDepositAddress(depositId)
  const expiry = Math.floor(new Date().getTime() / 1000) + SOL_DEPOSIT_EXPIRY_PERIOD
  await db.query('INSERT INTO sol_deposits (id, deposit_address, outgoing_currency, outgoing_address, expiry) VALUES ($1,$2,$3,$4,to_timestamp($5))', [depositId, depositAddress, outgoingCurrency, outgoingAddress, expiry])
  return res.status(200).json({
    deposit_address: depositAddress,
    expires_at: expiry
  })
})

app.get('/prices', async (_, res) => {
  const gmxPrices = await axios.get('https://api.gmx.io/prices').then(({ data })=> ({
    btc_usd: data['0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f'] / 1e30,
    eth_usd: data['0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'] / 1e30 
  }))
  const coinCapPrices = await axios.get('https://api.coincap.io/v2/assets', {
    headers: {
      'Authorization': `Bearer ${process.env.COIN_CAP_API_KEY}`
    }
  }).then(({data}) => ({
    sol_usd: Number(data.data.find(asset => asset.id === 'solana').priceUsd)
  }))

  return res.status(200).json({
    ...gmxPrices,
    ...coinCapPrices
  })
})

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ err })
})

module.exports = { app, db }
