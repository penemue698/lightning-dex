import nodeChildProcess from 'node:child_process'
import util from 'node:util'
import pg from 'pg'

const db = new pg.Pool({
  host: 'localhost',
  port: 5432,
  database: 'zap',
  user: 'postgres',
  password: 'postgres'
});

const exec = util.promisify(nodeChildProcess.exec);

updateDeposits();
setInterval(updateDeposits, 5000);

async function updateDeposits () {
  const { stdout, stderr } = await exec(`bitcoin-core.cli -testnet listtransactions`);
  const transactions = JSON.parse(stdout);
  const deposits = transactions.filter(t => t.category === "receive");
  for (let deposit of deposits) {
    const deposit_address_result = await db.query("SELECT * FROM deposit_addresses WHERE deposit_address=$1 AND deposit_currency='BTC'", [deposit.address]);
    if (deposit_address_result.rows.length != 1) continue;

    const outgoing_currency = deposit_address_result.rows[0].outgoing_currency;
    const outgoing_address = deposit_address_result.rows[0].outgoing_address;

    const bridge_data = ["BTC", deposit.address, deposit.amount, deposit.txid, outgoing_currency, outgoing_address];
    const result = await db.query(
      `INSERT INTO bridges (deposit_currency, deposit_address, deposit_amount, deposit_txid, deposit_timestamp, outgoing_currency, outgoing_address) 
       VALUES ($1,$2,$3,$4,NOW(),$5,$6) 
       ON CONFLICT (deposit_txid) DO NOTHING`, 
       bridge_data
    );
    if (result.rowCount === 1) console.log(bridge_data);
  }
}
