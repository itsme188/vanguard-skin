/**
 * EmptySection takes a node for `reason` and `hint`, not only a string
 * (TODO f9), so an empty state can carry a link or a privacy component.
 * A string caller renders exactly as before. Rendered with react-dom/server
 * (the repo has no DOM harness).
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EmptySection } from "@/app/dashboard/components/EmptySection";

const render = (props: Parameters<typeof EmptySection>[0]) =>
  renderToStaticMarkup(createElement(EmptySection, props));

describe("EmptySection — string props (unchanged)", () => {
  it("renders the title, the reason and the hint, and the hint is the badge tooltip", () => {
    const html = render({ title: "Sector tilt", reason: "No holdings yet.", hint: "Import a statement." });
    expect(html).toContain('<h3 class="text-sm font-medium text-ink">Sector tilt</h3>');
    expect(html).toContain('<p class="text-sm text-ink-faint">No holdings yet.</p>');
    expect(html).toContain('<p class="text-xs text-ink-faint mt-2 italic">Import a statement.</p>');
    expect(html).toContain('title="Import a statement."');
  });

  it("with no hint the badge keeps its stock tooltip and no hint line renders", () => {
    const html = render({ title: "Sector tilt", reason: "No holdings yet." });
    expect(html).toContain('title="This section needs more data to render."');
    expect(html).not.toContain("italic");
  });
});

describe("EmptySection — node props", () => {
  it("renders a node reason inside the reason sentence", () => {
    const html = render({
      title: "Sector tilt",
      reason: createElement("a", { href: "/dashboard/import" }, "Import a statement"),
    });
    expect(html).toContain(
      '<p class="text-sm text-ink-faint"><a href="/dashboard/import">Import a statement</a></p>',
    );
  });

  it("renders a node hint as the hint line and keeps the stock tooltip", () => {
    const html = render({
      title: "Sector tilt",
      reason: "No holdings yet.",
      hint: createElement("strong", null, "Try the Import tab"),
    });
    expect(html).toContain(
      '<p class="text-xs text-ink-faint mt-2 italic"><strong>Try the Import tab</strong></p>',
    );
    // A node cannot be a tooltip; it must not become "[object Object]".
    expect(html).toContain('title="This section needs more data to render."');
    expect(html).not.toContain("[object Object]");
  });
});
