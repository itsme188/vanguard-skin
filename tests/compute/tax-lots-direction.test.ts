import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { ibkrTradeDirectionNote } from "@/lib/import/ibkr-trade-direction";
import { computeGroupedTrades, getRoundTrips } from "@/lib/compute/trade-roundtrips";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:"); runMigrations(db);
  db.prepare("INSERT INTO securities(id,symbol,security_type) VALUES (1,'TEST','Stock')").run();
});
afterEach(() => db.close());
function trade(type: string, date: string, qty: number, price: number, code = "", time = "12:00:00", fees = 0) {
  const buy = type.startsWith("BUY");
  return Number(db.prepare(`INSERT INTO transactions(account_id,security_id,type,trade_date,quantity,price_per_share,amount,fees,notes)
    VALUES(3,1,?,?,?,?,?,?,?)`).run(type,date,qty,price,(buy ? -1 : 1)*qty*price,fees,
      ibkrTradeDirectionNote(code, `${date}, ${time}`) ?? null).lastInsertRowid);
}
function sales() {
  return db.prepare(`SELECT x.*,l.is_short,l.acquisition_date FROM tax_lot_sales x JOIN tax_lots l ON l.id=x.tax_lot_id ORDER BY x.sale_date,x.id`).all() as Array<{
    is_short:number; acquisition_date:string; sale_date:string; holding_period_days:number;
    quantity_sold:number; proceeds:number; cost_basis_allocated:number; realized_gain_loss:number;
  }>;
}
describe("broker-directed chronological lots", () => {
  it("does not consume a future purchase for an uncovered legacy sale", () => {
    trade("SELL","2026-08-28",10,100); trade("BUY","2026-08-31",10,90);
    expect(computeTaxLots(db).replayWarnings).toEqual(expect.arrayContaining([expect.stringContaining("unmatched closing quantity")]));
    expect(sales()).toHaveLength(0);
  });
  it("a broker opening sell and partial covers conserve proceeds, basis and fees", () => {
    trade("SELL","2026-08-28",10,100,"O","12:00:00",2);
    trade("BUY","2026-08-31",4,90,"C","12:00:00",1);
    trade("BUY","2026-09-01",6,95,"C","12:00:00",1);
    expect(computeTaxLots(db).replayWarnings).toEqual([]);
    const rows=sales(); expect(rows).toHaveLength(2);
    expect(rows.every(r=>r.is_short===1 && r.acquisition_date<=r.sale_date)).toBe(true);
    expect(rows.reduce((s,r)=>s+r.proceeds,0)).toBeCloseTo(998);
    expect(rows.reduce((s,r)=>s+r.cost_basis_allocated,0)).toBeCloseTo(932);
    expect(rows.reduce((s,r)=>s+r.realized_gain_loss,0)).toBeCloseTo(66);
    const grouped=computeGroupedTrades(getRoundTrips(db,3,"2026-08-01","2026-09-30"));
    expect(grouped.map(t=>t.avgHoldingDays)).toEqual([3,4]);
  });
  it("uses broker execution time rather than import order for same-day round trips", () => {
    trade("BUY","2026-08-28",10,90,"C","15:00:00");
    trade("SELL","2026-08-28",10,100,"O","09:45:00");
    expect(computeTaxLots(db).replayWarnings).toEqual([]);
    expect(sales()).toMatchObject([{is_short:1,realized_gain_loss:100,holding_period_days:0}]);
  });
  it("never closes a long lot with an explicit short cover", () => {
    trade("BUY","2026-08-01",10,100);trade("BUY_TO_COVER","2026-08-28",10,90);
    expect(computeTaxLots(db).replayWarnings).toHaveLength(1);expect(sales()).toEqual([]);
  });
  it("mixed sell closes the long and opens the short with dollar conservation", () => {
    trade("BUY","2026-08-01",4,80,"O");
    trade("SELL","2026-08-28",10,100,"C;O","12:00:00",2);
    trade("BUY","2026-08-31",6,90,"C","12:00:00",1);
    expect(computeTaxLots(db).replayWarnings).toEqual([]);
    expect(sales().map(r=>[r.is_short,r.quantity_sold])).toEqual([[0,4],[1,6]]);
    expect(sales().reduce((s,r)=>s+r.proceeds,0)).toBeCloseTo(998);
    expect(sales().reduce((s,r)=>s+r.cost_basis_allocated,0)).toBeCloseTo(861);
  });
  it("mixed buy covers the short and opens the remaining long", () => {
    trade("SELL","2026-08-01",4,100,"O");
    trade("BUY","2026-08-28",10,90,"C;O","12:00:00",2);
    trade("SELL","2026-08-31",6,95,"C","12:00:00",1);
    expect(computeTaxLots(db).replayWarnings).toEqual([]);
    expect(sales().map(r=>[r.is_short,r.quantity_sold])).toEqual([[1,4],[0,6]]);
    expect(sales().reduce((s,r)=>s+r.cost_basis_allocated,0)).toBeCloseTo(902);
    expect(sales().reduce((s,r)=>s+r.proceeds,0)).toBeCloseTo(969);
  });
  it("refuses to infer the split of a mixed trade with missing opening history", () => {
    trade("SELL","2026-08-28",10,100,"C;O");
    expect(computeTaxLots(db).replayWarnings).toEqual([expect.stringContaining("cannot be split")]);
    expect(db.prepare("SELECT COUNT(*) n FROM tax_lots").get()).toEqual({n:0});
  });
  it("supports explicit stock shorts without broker metadata", () => {
    trade("SHORT_SELL","2026-08-28",10,100);trade("BUY_TO_COVER","2026-08-31",10,90);
    expect(computeTaxLots(db).replayWarnings).toEqual([]);
    expect(sales()).toMatchObject([{is_short:1,realized_gain_loss:100}]);
  });
});

it.each([0,40])("assignment premium survives a stock sell that opens a short (prior long=%s)", (priorLong) => {
  db.prepare("INSERT INTO securities(id,symbol,security_type,underlying_symbol,option_type,strike_price,expiration_date,multiplier) VALUES(2,'TEST  260918C00100000','Option','TEST','CALL',100,'2026-09-18',100)").run();
  db.prepare("INSERT INTO transactions(account_id,security_id,type,trade_date,quantity,price_per_share,amount,fees) VALUES(3,2,'SELL_TO_OPEN','2026-08-01',1,5,500,0),(3,2,'ASSIGNED','2026-08-28',1,5,0,0)").run();
  if(priorLong) trade('BUY','2026-08-01',priorLong,80,'O');
  trade('SELL','2026-08-28',100,100,priorLong?'C;O':'O');
  trade('BUY','2026-08-31',100-priorLong,90,'C');
  const result=computeTaxLots(db);
  expect(result.replayWarnings).toEqual([]);
  // All cash: option premium + stock proceeds - long acquisition - short cover.
  expect(sales().reduce((sum,r)=>sum+r.realized_gain_loss,0)).toBeCloseTo(500+10000-priorLong*80-(100-priorLong)*90);
  const short=sales().find(r=>r.is_short===1 && r.sale_date==='2026-08-31')!;
  expect(short.proceeds).toBeCloseTo((10000+500)*(100-priorLong)/100);
});

it("carries an exercise premium to the linked next-day acquisition", () => {
  db.prepare("INSERT INTO securities(id,symbol,security_type,underlying_symbol,option_type,strike_price,expiration_date,multiplier) VALUES(2,'TEST  260918C00100000','Option','TEST','CALL',100,'2026-09-18',100)").run();
  db.prepare("INSERT INTO transactions(account_id,security_id,type,trade_date,quantity,price_per_share,amount,fees) VALUES(3,2,'BUY_TO_OPEN','2026-08-01',1,5,-500,0),(3,2,'EXERCISED','2026-08-28',1,5,0,0)").run();
  trade('BUY','2026-08-29',100,100,'O');
  expect(computeTaxLots(db).replayWarnings).toEqual([]);
  expect(db.prepare('SELECT cost_basis FROM tax_lots WHERE security_id=1').get()).toEqual({cost_basis:10500});
  expect(db.prepare('SELECT premium_rollover,realized_gain_loss FROM tax_lot_sales').get()).toEqual({premium_rollover:1,realized_gain_loss:0});
});
