import { getOpenTaxLotsBySecurity } from "@/lib/queries/security-detail";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { getRoundTrips,computeGroupedTrades,getAvailableReviewPeriods } from "@/lib/compute/trade-roundtrips";
import { saveTradeRoundtrips } from "@/lib/mutations/trade-reviews";
import { ibkrTradeDirectionNote } from "@/lib/import/ibkr-trade-direction";
import { getOpenTaxLots,getTaxLotSummary } from "@/lib/queries/tax-lots";
let db: Database.Database;
vi.mock("@/lib/db",()=>({get db(){return db;}}));
vi.mock("@/lib/trade-review/generate",()=>({prepareTradeReview:vi.fn(),generateTradeReview:vi.fn()}));
import { GET } from "@/app/api/trade-review/route";
beforeEach(()=>{db=new Database(":memory:");runMigrations(db);
 db.prepare("INSERT INTO securities(id,symbol,name,security_type) VALUES(1,'TEST','Test','Stock')").run();
});afterEach(()=>db.close());
function trade(type:string,date:string,qty:number,price:number,code:string) {
 db.prepare("INSERT INTO transactions(account_id,security_id,type,trade_date,quantity,price_per_share,amount,fees,notes) VALUES(3,1,?,?,?,?,?,0,?)")
 .run(type,date,qty,price,(type==='BUY'?-1:1)*qty*price,ibkrTradeDirectionNote(code,`${date}, 12:00:00`));
}
function save() {
 db.prepare("INSERT INTO trade_reviews(id,account_id,period_start,period_end,total_trades,winning_trades,losing_trades,win_rate,total_realized_pnl,review_markdown) VALUES(1,3,'2026-08-01','2026-08-31',1,1,0,1,100,'test')").run();
 const trips=getRoundTrips(db,3,'2026-08-01','2026-08-31');saveTradeRoundtrips(db,1,trips,computeGroupedTrades(trips));
}
async function detail() { return (await GET(new Request('http://localhost/api/trade-review?id=1'))).json(); }
describe("saved directional review",()=>{
 it("returns a positive profit percentage, positive duration and short direction after saving",async()=>{
   trade('SELL','2026-08-28',10,100,'O');trade('BUY','2026-08-31',10,90,'C');computeTaxLots(db);save();
   const body=await detail();
   expect(body.groupedTrades[0]).toMatchObject({isShort:true,maxHoldingDays:3,totalPnl:100,avgEntryPrice:100,pairingsStale:false});
   expect(body.groupedTrades[0].returnPct).toBeCloseTo(100/900*100);
 });
 it("recognizes same-day short direction even though stored duration is zero",async()=>{
   trade('SELL','2026-08-28',10,100,'O');trade('BUY','2026-08-28',10,90,'C');computeTaxLots(db);save();
   expect((await detail()).groupedTrades[0]).toMatchObject({isShort:true,maxHoldingDays:0,pairingsStale:false});
 });
 it("flags both changed pairings and changed dollars without rewriting a saved review",async()=>{
   trade('SELL','2026-08-28',10,100,'O');trade('BUY','2026-08-31',10,90,'C');computeTaxLots(db);save();
   db.prepare('UPDATE tax_lot_sales SET proceeds=proceeds+5,realized_gain_loss=realized_gain_loss+5').run();
   expect((await detail()).groupedTrades[0].pairingsStale).toBe(true);
   expect(db.prepare('SELECT realized_pnl FROM trade_roundtrips').get()).toEqual({realized_pnl:100});
   db.prepare("UPDATE trade_roundtrips SET entry_date='2026-09-01'").run();
   expect((await detail()).groupedTrades[0].pairingsStale).toBe(true);
 });
 it("counts the closing portion of mixed trades consistently for review eligibility",()=>{
   trade('SELL','2026-08-01',4,100,'O');trade('BUY','2026-08-28',10,90,'C;O');computeTaxLots(db);
   expect(getAvailableReviewPeriods(db,3)).toMatchObject([{tradeCount:1,reviewableCount:1}]);
   expect(computeGroupedTrades(getRoundTrips(db,3,'2026-08-01','2026-08-31'))[0].lotCoverage).toBe(1);
 });
 it("shows the correct unrealized direction for a still-open short",()=>{
   trade('SELL','2026-08-01',10,100,'O');computeTaxLots(db);
   db.prepare("INSERT INTO prices(security_id,date,close_price,source) VALUES(1,'2026-08-31',90,'test')").run();
   expect(getOpenTaxLots(db)[0]).toMatchObject({is_short:1,unrealized_gain:100});
   expect(getTaxLotSummary(db).totalUnrealizedGain).toBe(100);
   expect(getOpenTaxLotsBySecurity(db,1)[0]).toMatchObject({is_short:1,unrealized_gain:100});
   expect(getOpenTaxLotsBySecurity(db,999)).toEqual([]);
 });
});
