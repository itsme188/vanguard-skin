import { notFound } from "next/navigation";
import { getOption, OPTIONS } from "../options";
import { TodayPreview } from "../TodayPreview";
import { PreviewNav } from "../PreviewNav";
import "../options.css";

export const dynamic = "force-static";

export function generateStaticParams() {
  return OPTIONS.map((o) => ({ option: o.id }));
}

interface PageProps {
  params: Promise<{ option: string }>;
}

export default async function OptionPage({ params }: PageProps) {
  const { option } = await params;
  const meta = getOption(option);
  if (!meta) notFound();

  return (
    <div data-preview={meta.layout.paletteScope} className="min-h-screen bg-canvas text-ink">
      <div className="max-w-[1600px] mx-auto px-4 md:px-6 pb-20">
        <PreviewNav current={meta.id} />
        <div className="py-3">
          <p className="text-[10px] uppercase tracking-widest text-ink-faint">
            Design preview · {meta.name}
          </p>
          <p className="text-[13px] text-ink-dim mt-0.5 italic">{meta.tagline}</p>
        </div>
        <TodayPreview density={meta.layout.density} header={meta.layout.header} />
      </div>
    </div>
  );
}
