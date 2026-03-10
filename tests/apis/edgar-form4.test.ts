/**
 * Tests for SEC Form 4 (insider trading) XML parsing.
 *
 * These tests validate the XML parsing helpers and the parseForm4Xml function
 * using inline XML fixtures that match the real Form 4 document structure.
 * No network calls are made — this is pure parsing logic.
 */
import { describe, it, expect } from "vitest";
import {
  xmlText,
  xmlBlocks,
  extractNestedValue,
  parseForm4Xml,
} from "@/lib/apis/edgar";

// ─── Sample Form 4 XML Fixtures ──────────────────────────────────

const SAMPLE_FORM4_XML = `<?xml version="1.0"?>
<ownershipDocument>
  <schemaVersion>X0407</schemaVersion>
  <documentType>4</documentType>
  <periodOfReport>2026-02-15</periodOfReport>
  <issuer>
    <issuerCik>0000320193</issuerCik>
    <issuerName>Apple Inc</issuerName>
    <issuerTradingSymbol>AAPL</issuerTradingSymbol>
  </issuer>
  <reportingOwner>
    <reportingOwnerId>
      <rptOwnerCik>0001234567</rptOwnerCik>
      <rptOwnerName>DOE JOHN A</rptOwnerName>
    </reportingOwnerId>
    <reportingOwnerAddress>
      <rptOwnerStreet1>ONE APPLE PARK WAY</rptOwnerStreet1>
      <rptOwnerCity>CUPERTINO</rptOwnerCity>
      <rptOwnerState>CA</rptOwnerState>
      <rptOwnerZipCode>95014</rptOwnerZipCode>
    </reportingOwnerAddress>
    <reportingOwnerRelationship>
      <isDirector>0</isDirector>
      <isOfficer>1</isOfficer>
      <officerTitle>Chief Executive Officer</officerTitle>
      <isTenPercentOwner>0</isTenPercentOwner>
    </reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <securityTitle>
        <value>Common Stock</value>
      </securityTitle>
      <transactionDate>
        <value>2026-02-15</value>
      </transactionDate>
      <transactionCoding>
        <transactionFormType>4</transactionFormType>
        <transactionCode>P</transactionCode>
        <equitySwapInvolved>0</equitySwapInvolved>
      </transactionCoding>
      <transactionAmounts>
        <transactionShares>
          <value>5000</value>
        </transactionShares>
        <transactionPricePerShare>
          <value>150.25</value>
        </transactionPricePerShare>
        <transactionAcquiredDisposedCode>
          <value>A</value>
        </transactionAcquiredDisposedCode>
      </transactionAmounts>
      <postTransactionAmounts>
        <sharesOwnedFollowingTransaction>
          <value>125000</value>
        </sharesOwnedFollowingTransaction>
      </postTransactionAmounts>
      <ownershipNature>
        <directOrIndirectOwnership>
          <value>D</value>
        </directOrIndirectOwnership>
      </ownershipNature>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>`;

const MULTI_TXN_XML = `<?xml version="1.0"?>
<ownershipDocument>
  <reportingOwner>
    <reportingOwnerId>
      <rptOwnerCik>0009876543</rptOwnerCik>
      <rptOwnerName>SMITH JANE B</rptOwnerName>
    </reportingOwnerId>
    <reportingOwnerRelationship>
      <isDirector>1</isDirector>
      <isOfficer>1</isOfficer>
      <officerTitle>CFO</officerTitle>
      <isTenPercentOwner>0</isTenPercentOwner>
    </reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <securityTitle>
        <value>Common Stock</value>
      </securityTitle>
      <transactionDate>
        <value>2026-03-01</value>
      </transactionDate>
      <transactionAmounts>
        <transactionShares>
          <value>10000</value>
        </transactionShares>
        <transactionPricePerShare>
          <value>200.50</value>
        </transactionPricePerShare>
        <transactionAcquiredDisposedCode>
          <value>D</value>
        </transactionAcquiredDisposedCode>
      </transactionAmounts>
      <postTransactionAmounts>
        <sharesOwnedFollowingTransaction>
          <value>90000</value>
        </sharesOwnedFollowingTransaction>
      </postTransactionAmounts>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <securityTitle>
        <value>Common Stock</value>
      </securityTitle>
      <transactionDate>
        <value>2026-03-02</value>
      </transactionDate>
      <transactionAmounts>
        <transactionShares>
          <value>3000</value>
        </transactionShares>
        <transactionPricePerShare>
          <value>198.75</value>
        </transactionPricePerShare>
        <transactionAcquiredDisposedCode>
          <value>A</value>
        </transactionAcquiredDisposedCode>
      </transactionAmounts>
      <postTransactionAmounts>
        <sharesOwnedFollowingTransaction>
          <value>93000</value>
        </sharesOwnedFollowingTransaction>
      </postTransactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>`;

const MISSING_PRICE_XML = `<?xml version="1.0"?>
<ownershipDocument>
  <reportingOwner>
    <reportingOwnerId>
      <rptOwnerName>MAJOR HOLDER LLC</rptOwnerName>
    </reportingOwnerId>
    <reportingOwnerRelationship>
      <isDirector>0</isDirector>
      <isOfficer>0</isOfficer>
      <isTenPercentOwner>1</isTenPercentOwner>
    </reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <securityTitle>
        <value>Common Stock</value>
      </securityTitle>
      <transactionDate>
        <value>2026-01-10</value>
      </transactionDate>
      <transactionAmounts>
        <transactionShares>
          <value>50000</value>
        </transactionShares>
        <transactionPricePerShare>
          <value>0</value>
        </transactionPricePerShare>
        <transactionAcquiredDisposedCode>
          <value>A</value>
        </transactionAcquiredDisposedCode>
      </transactionAmounts>
      <postTransactionAmounts>
        <sharesOwnedFollowingTransaction>
          <value>1000000</value>
        </sharesOwnedFollowingTransaction>
      </postTransactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>`;

// ─── Tests ───────────────────────────────────────────────────────

describe("xmlText", () => {
  it("extracts simple tag content", () => {
    expect(xmlText("<name>John</name>", "name")).toBe("John");
  });

  it("returns null for missing tag", () => {
    expect(xmlText("<name>John</name>", "age")).toBeNull();
  });

  it("trims whitespace", () => {
    expect(xmlText("<name>  John  </name>", "name")).toBe("John");
  });
});

describe("xmlBlocks", () => {
  it("extracts all occurrences of a tag", () => {
    const xml = "<item>A</item><other>X</other><item>B</item>";
    const blocks = xmlBlocks(xml, "item");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toBe("<item>A</item>");
    expect(blocks[1]).toBe("<item>B</item>");
  });

  it("handles nested content", () => {
    const xml = "<parent><child>nested</child></parent>";
    const blocks = xmlBlocks(xml, "parent");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("<child>nested</child>");
  });

  it("returns empty array for no matches", () => {
    expect(xmlBlocks("<a>b</a>", "missing")).toEqual([]);
  });
});

describe("extractNestedValue", () => {
  it("extracts value from single-level nesting", () => {
    const block = "<securityTitle><value>Common Stock</value></securityTitle>";
    expect(extractNestedValue(block, "securityTitle")).toBe("Common Stock");
  });

  it("extracts value from multi-level nesting", () => {
    const block = `<transactionAmounts>
      <transactionShares><value>5000</value></transactionShares>
    </transactionAmounts>`;
    expect(
      extractNestedValue(block, "transactionAmounts", "transactionShares")
    ).toBe("5000");
  });

  it("returns null for missing intermediate tag", () => {
    const block = "<outer><inner>X</inner></outer>";
    expect(extractNestedValue(block, "outer", "missing")).toBeNull();
  });

  it("returns raw text when no <value> sub-element", () => {
    const block = "<tag>plain text</tag>";
    expect(extractNestedValue(block, "tag")).toBe("plain text");
  });
});

describe("parseForm4Xml", () => {
  it("extracts owner name and title from standard filing", () => {
    const result = parseForm4Xml(SAMPLE_FORM4_XML, "2026-02-16", "0001234-26-000001");
    expect(result).not.toBeNull();
    expect(result!.ownerName).toBe("DOE JOHN A");
    expect(result!.ownerTitle).toBe("Chief Executive Officer");
  });

  it("extracts relationship flags correctly", () => {
    const result = parseForm4Xml(SAMPLE_FORM4_XML, "2026-02-16", "0001234-26-000001");
    expect(result!.isOfficer).toBe(true);
    expect(result!.isDirector).toBe(false);
    expect(result!.isTenPercentOwner).toBe(false);
  });

  it("extracts non-derivative transaction details", () => {
    const result = parseForm4Xml(SAMPLE_FORM4_XML, "2026-02-16", "0001234-26-000001");
    expect(result!.transactions).toHaveLength(1);

    const txn = result!.transactions[0];
    expect(txn.securityTitle).toBe("Common Stock");
    expect(txn.transactionDate).toBe("2026-02-15");
    expect(txn.shares).toBe(5000);
    expect(txn.pricePerShare).toBe(150.25);
    expect(txn.acquiredOrDisposed).toBe("A");
    expect(txn.sharesOwnedAfter).toBe(125000);
  });

  it("preserves filing metadata", () => {
    const result = parseForm4Xml(SAMPLE_FORM4_XML, "2026-02-16", "0001234-26-000001");
    expect(result!.filingDate).toBe("2026-02-16");
    expect(result!.accessionNumber).toBe("0001234-26-000001");
  });

  it("handles multiple transactions in one filing", () => {
    const result = parseForm4Xml(MULTI_TXN_XML, "2026-03-03", "0009876-26-000002");
    expect(result).not.toBeNull();
    expect(result!.transactions).toHaveLength(2);

    // First transaction: sell
    expect(result!.transactions[0].shares).toBe(10000);
    expect(result!.transactions[0].pricePerShare).toBe(200.50);
    expect(result!.transactions[0].acquiredOrDisposed).toBe("D");
    expect(result!.transactions[0].sharesOwnedAfter).toBe(90000);

    // Second transaction: buy
    expect(result!.transactions[1].shares).toBe(3000);
    expect(result!.transactions[1].pricePerShare).toBe(198.75);
    expect(result!.transactions[1].acquiredOrDisposed).toBe("A");
    expect(result!.transactions[1].sharesOwnedAfter).toBe(93000);
  });

  it("handles both director and officer flags", () => {
    const result = parseForm4Xml(MULTI_TXN_XML, "2026-03-03", "0009876-26-000002");
    expect(result!.ownerName).toBe("SMITH JANE B");
    expect(result!.ownerTitle).toBe("CFO");
    expect(result!.isDirector).toBe(true);
    expect(result!.isOfficer).toBe(true);
    expect(result!.isTenPercentOwner).toBe(false);
  });

  it("handles 10% owner with zero price", () => {
    const result = parseForm4Xml(MISSING_PRICE_XML, "2026-01-12", "0005555-26-000003");
    expect(result).not.toBeNull();
    expect(result!.ownerName).toBe("MAJOR HOLDER LLC");
    expect(result!.isTenPercentOwner).toBe(true);
    expect(result!.isDirector).toBe(false);
    expect(result!.isOfficer).toBe(false);

    const txn = result!.transactions[0];
    expect(txn.shares).toBe(50000);
    expect(txn.pricePerShare).toBe(0); // reported as 0, not null
    expect(txn.sharesOwnedAfter).toBe(1000000);
  });

  it("returns null for malformed XML without reportingOwner", () => {
    const badXml = `<?xml version="1.0"?>
<ownershipDocument>
  <issuer><issuerName>Test Co</issuerName></issuer>
</ownershipDocument>`;
    expect(parseForm4Xml(badXml, "2026-01-01", "000")).toBeNull();
  });

  it("returns null for XML without owner name", () => {
    const badXml = `<?xml version="1.0"?>
<ownershipDocument>
  <reportingOwner>
    <reportingOwnerId>
      <rptOwnerCik>0001234567</rptOwnerCik>
    </reportingOwnerId>
  </reportingOwner>
</ownershipDocument>`;
    expect(parseForm4Xml(badXml, "2026-01-01", "000")).toBeNull();
  });

  it("returns filing with empty transactions when no nonDerivativeTransaction", () => {
    // Some Form 4s only have derivative transactions (options)
    const derivativeOnlyXml = `<?xml version="1.0"?>
<ownershipDocument>
  <reportingOwner>
    <reportingOwnerId>
      <rptOwnerName>OPTIONS ONLY GUY</rptOwnerName>
    </reportingOwnerId>
    <reportingOwnerRelationship>
      <isDirector>0</isDirector>
      <isOfficer>1</isOfficer>
      <officerTitle>VP Engineering</officerTitle>
      <isTenPercentOwner>0</isTenPercentOwner>
    </reportingOwnerRelationship>
  </reportingOwner>
  <derivativeTable>
    <derivativeTransaction>
      <securityTitle><value>Stock Option</value></securityTitle>
    </derivativeTransaction>
  </derivativeTable>
</ownershipDocument>`;
    const result = parseForm4Xml(derivativeOnlyXml, "2026-01-01", "000");
    expect(result).not.toBeNull();
    expect(result!.ownerName).toBe("OPTIONS ONLY GUY");
    expect(result!.transactions).toHaveLength(0);
  });

  it("handles 'true'/'false' string boolean values", () => {
    const trueFalseXml = `<?xml version="1.0"?>
<ownershipDocument>
  <reportingOwner>
    <reportingOwnerId>
      <rptOwnerName>BOOLEAN TEST</rptOwnerName>
    </reportingOwnerId>
    <reportingOwnerRelationship>
      <isDirector>true</isDirector>
      <isOfficer>false</isOfficer>
      <isTenPercentOwner>true</isTenPercentOwner>
    </reportingOwnerRelationship>
  </reportingOwner>
</ownershipDocument>`;
    const result = parseForm4Xml(trueFalseXml, "2026-01-01", "000");
    expect(result!.isDirector).toBe(true);
    expect(result!.isOfficer).toBe(false);
    expect(result!.isTenPercentOwner).toBe(true);
  });
});
