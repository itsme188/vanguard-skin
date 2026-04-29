import type { MockOhlcBar } from "./types";

interface Props {
  bars: MockOhlcBar[];
  width?: number;
  height?: number;
  stroke?: string;
  fill?: string;
  showAxisFloor?: boolean;
}

export function Sparkline({
  bars,
  width = 600,
  height = 200,
  stroke = "#ffb84d",
  fill = "rgba(255, 184, 77, 0.08)",
  showAxisFloor,
}: Props) {
  if (!bars.length) return null;
  const closes = bars.map((b) => b.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || 1;
  const padding = 8;
  const chartW = width - padding * 2;
  const chartH = height - padding * 2;
  const xStep = chartW / (bars.length - 1 || 1);

  const points = bars.map((b, i) => {
    const x = padding + i * xStep;
    const y = padding + chartH - ((b.close - min) / range) * chartH;
    return [x, y] as const;
  });

  const linePath = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const fillPath = `${linePath} L${(padding + chartW).toFixed(2)},${(padding + chartH).toFixed(2)} L${padding.toFixed(2)},${(padding + chartH).toFixed(2)} Z`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ display: "block", width: "100%", height: `${height}px`, maxWidth: "100%" }}
    >
      <path d={fillPath} fill={fill} />
      <path d={linePath} fill="none" stroke={stroke} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      {showAxisFloor && (
        <line
          x1={padding}
          x2={padding + chartW}
          y1={padding + chartH}
          y2={padding + chartH}
          stroke="#1f1f1f"
          strokeWidth={1}
        />
      )}
    </svg>
  );
}

export function MiniSparkline({ bars, width = 80, height = 24, color }: { bars: MockOhlcBar[]; width?: number; height?: number; color: string }) {
  if (!bars.length) return null;
  const closes = bars.map((b) => b.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || 1;
  const xStep = width / (bars.length - 1 || 1);
  const linePath = closes
    .map((c, i) => {
      const x = i * xStep;
      const y = height - ((c - min) / range) * height;
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      <path d={linePath} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" />
    </svg>
  );
}
