import { describe, expect, it } from "vitest";
import { parseIbkrActivity } from "@/lib/import/parsers/ibkr-activity";
import { readIbkrTradeDirection } from "@/lib/import/ibkr-trade-direction";
const header="Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,C. Price,Proceeds,Comm/Fee,Basis,Realized P/L,MTM P/L,Code";
describe("IBKR direction evidence",()=>{
 it.each(["O","C;P","C;O;P"])("retains %s without changing the import identity",code=>{
   const row=`Trades,Data,Order,Stocks,USD,TEST,"2026-08-28, 10:28:55",-10,100,100,1000,-1,0,0,0,${code}`;
   const tx=parseIbkrActivity(header+"\n"+row,"test.csv").transactions[0];
   expect(tx.type).toBe("SELL");
   expect(tx.sourceKey).toBe("ibkr:trade:2026-08-28:TEST:-10:1000");
   expect(readIbkrTradeDirection(tx.notes)).toEqual({open:code.includes("O"),close:code.includes("C"),time:"2026-08-28 10:28:55"});
 });
 it("does not interpret incidental letters in another broker code as open/close",()=>{
   const row='Trades,Data,Order,Stocks,USD,TEST,"2026-08-28, 10:28:55",-10,100,100,1000,-1,0,0,0,Co;CP';
   expect(parseIbkrActivity(header+"\n"+row,"test.csv").transactions[0].notes).toBeUndefined();
 });
});
