import { afterEach, beforeEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { backfillIbkrTradeDirection } from "@/lib/mutations/ibkr-trade-direction";
import { ibkrTradeDirectionNote } from "@/lib/import/ibkr-trade-direction";
import { getTaxInputGeneration } from "@/lib/compute/tax-convention";
let db: Database.Database;
const parsed={accountName:"IBKR",tradeDate:"2026-08-28",symbol:"TEST",quantity:10,amount:1000,type:"SELL",sourceKey:"ibkr:trade:2026-08-28:TEST:-10:1000",notes:ibkrTradeDirectionNote("O","2026-08-28, 12:00:00")};
beforeEach(()=>{db=new Database(":memory:");runMigrations(db);
 db.prepare("INSERT INTO securities(id,symbol,security_type) VALUES(1,'TEST','Stock')").run();
 db.prepare("INSERT INTO import_batches(id,filename,source_type,status) VALUES(1,'test.csv','ibkr-activity','committed')").run();
 db.prepare("INSERT INTO transactions(account_id,security_id,import_batch_id,type,trade_date,quantity,amount,source_key,notes) VALUES(3,1,1,'SELL',?,10,1000,?,'original note')").run(parsed.tradeDate,parsed.sourceKey);
});afterEach(()=>db.close());
it("previews, preserves existing notes, invalidates tax acceptance once, and dedupes",()=>{
 const generation=getTaxInputGeneration(db);
 expect(backfillIbkrTradeDirection(db,1,[parsed]).changed).toBe(1);
 expect(db.prepare('SELECT notes FROM transactions').get()).toEqual({notes:'original note'});
 expect(backfillIbkrTradeDirection(db,1,[parsed],true).changed).toBe(1);
 expect(getTaxInputGeneration(db)).toBe(generation+1);
 expect(db.prepare('SELECT notes FROM transactions').get()).toEqual({notes:'original note\n'+parsed.notes});
 expect(backfillIbkrTradeDirection(db,1,[parsed],true).unchanged).toBe(1);
 expect(getTaxInputGeneration(db)).toBe(generation+1);
});
it("refuses evidence from another batch or a changed economic leg",()=>{
 expect(backfillIbkrTradeDirection(db,2,[parsed],true).refused).toBe(1);
 expect(backfillIbkrTradeDirection(db,1,[{...parsed,amount:900}],true).refused).toBe(1);
 expect(db.prepare('SELECT notes FROM transactions').get()).toEqual({notes:'original note'});
});
