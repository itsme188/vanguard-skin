/** Broker evidence retained in the existing notes field; source keys never change. */
const PREFIX = "IBKR trade direction: ";

export interface IbkrTradeDirection {
  open: boolean;
  close: boolean;
  time: string;
}

export function ibkrTradeDirectionNote(code: string, dateTime: string): string | undefined {
  const codes = code.split(";").map((c) => c.trim());
  const open = codes.includes("O");
  const close = codes.includes("C");
  if (!open && !close) return undefined;
  const time = /^(\d{4}-\d{2}-\d{2}),?\s+(\d{2}:\d{2}:\d{2})$/.exec(dateTime);
  return PREFIX + JSON.stringify({ open, close, time: time ? `${time[1]} ${time[2]}` : "" });
}

export function readIbkrTradeDirection(notes: string | null | undefined): IbkrTradeDirection | null {
  const line = notes?.split("\n").find((s) => s.startsWith(PREFIX));
  if (!line) return null;
  try {
    const value: unknown = JSON.parse(line.slice(PREFIX.length));
    if (value == null || typeof value !== "object") return null;
    if (!("open" in value) || typeof value.open !== "boolean" ||
        !("close" in value) || typeof value.close !== "boolean" ||
        !("time" in value) || typeof value.time !== "string" ||
        (!value.open && !value.close) ||
        (value.time !== "" && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value.time))) return null;
    return { open: value.open, close: value.close, time: value.time };
  } catch {
    return null;
  }
}
