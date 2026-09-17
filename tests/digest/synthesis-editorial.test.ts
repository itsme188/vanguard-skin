import {readFileSync} from "node:fs";
import {describe,it,expect} from "vitest";
import {retainSuppliedSourceLinks, splitDigestOpening} from "@/lib/digest/synthesis-editorial";
import {retainSuppliedSourceLinks as workerLinks} from "../../workers/cron/src/synthesis-editorial";

describe("digest editorial parity and citation fidelity",()=>{
 it("keeps the editorial contract identical in Mac and Worker",()=>{
  expect(readFileSync("lib/digest/synthesis-editorial.ts","utf8")).toBe(readFileSync("workers/cron/src/synthesis-editorial.ts","utf8"));
 });
 it("handles adjacent citations and supplied URLs containing parentheses",()=>{
  const articles=[{source_url:"https://example.test/story_(update)",website_url:"https://example.test"}];
  const md="[One](https://example.test/story_(update))[Two](https://example.test)";
  expect(retainSuppliedSourceLinks(md,articles)).toBe(md);
 });
 it.each([retainSuppliedSourceLinks,workerLinks])("keeps exact supplied URLs and neutralizes altered or invented ones",(format)=>{
  const source={source_url:"https://example.test/fed-takeaways?q=1&x=2",website_url:"https://example.test"};
  const md="News. [Research](https://example.test/fed-takeaways?q=1&x=2) [Altered](https://example.test/vital-takeaways) [Site](https://example.test)";
  expect(format(md,[source])).toBe("News. [Research](https://example.test/fed-takeaways?q=1&x=2) Altered (source link unavailable) [Site](https://example.test)");
 });
});

describe("market opening",()=>{
 it("separates headline/subhead while retaining the body exactly",()=>{
  const body="## The Session\n\nBody with a [source](https://example.test).";
  expect(splitDigestOpening("# Hardware leads a mixed market\n\nStocks diverged as hardware orders strengthened.\n\n"+body)).toEqual({opening:"# Hardware leads a mixed market\n\nStocks diverged as hardware orders strengthened.",body});
 });
 it.each(["## The Session\n\nBody", "# Headline\n\n## The Session\n\nBody", "# Headline only"])("retains fallback behavior for incomplete opening %s",md=>{
  expect(splitDigestOpening(md)).toBeNull();
 });
});
