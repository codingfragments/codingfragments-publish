/**
 * CSV dialect sniffing and normalisation (decision 12).
 *
 * The spike showed Drive's importer often gets semicolon/latin1 CSV right, but
 * that behaviour is undocumented and was only partly verified, so we normalise
 * locally to canonical UTF-8 comma CSV and report the detected dialect in the
 * dry-run so it can be reviewed.
 */

export type Encoding = "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" | "latin1";
export type Delimiter = "," | ";" | "\t" | "|";

export interface Dialect {
  encoding: Encoding;
  delimiter: Delimiter;
  /** True when re-emitting changed the bytes (worth reporting). */
  normalised: boolean;
}

export interface SniffResult extends Dialect {
  /** Canonical UTF-8, comma-delimited, LF-terminated CSV text. */
  text: string;
}

const DELIMITERS: Delimiter[] = [",", ";", "\t", "|"];

export function detectEncoding(buf: Buffer): Encoding {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return "utf-8-bom";
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return "utf-16le";
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return "utf-16be";
  // Valid UTF-8? Round-trip check is cheap and avoids mojibake on latin1 input.
  const asUtf8 = buf.toString("utf8");
  if (!asUtf8.includes("\uFFFD")) return "utf-8";
  return "latin1";
}

export function decode(buf: Buffer, encoding: Encoding): string {
  switch (encoding) {
    case "utf-8-bom":
      return buf.subarray(3).toString("utf8");
    case "utf-16le":
      return buf.subarray(2).toString("utf16le");
    case "utf-16be": {
      // Node has no utf16be decoder: swap byte pairs, then decode as LE.
      const swapped = Buffer.from(buf.subarray(2));
      swapped.swap16();
      return swapped.toString("utf16le");
    }
    case "latin1":
      return buf.toString("latin1");
    default:
      return buf.toString("utf8");
  }
}

/**
 * Detect the delimiter by row-consistency rather than raw counts.
 *
 * Counting occurrences is provably wrong: `Alice,loves a;b;c` contains more
 * semicolons than commas, so a count-based sniffer picks `;` and shreds a
 * perfectly good comma CSV (caught by test). Instead, parse the sample with
 * each candidate and prefer the delimiter that yields a consistent field count
 * above one - the approach Python's csv.Sniffer uses. Ties favour the earlier
 * candidate, so `,` wins when nothing distinguishes them.
 */
export function detectDelimiter(text: string, sampleLines = 20): Delimiter {
  const sample = text.split("\n").slice(0, sampleLines).join("\n");
  let best: { delim: Delimiter; consistency: number; modal: number } | null = null;
  for (const delim of DELIMITERS) {
    const rows = parseRows(sample, delim).filter((r) => r.length > 0);
    if (rows.length === 0) continue;
    const counts = new Map<number, number>();
    for (const row of rows) counts.set(row.length, (counts.get(row.length) ?? 0) + 1);
    let modal = 0;
    let modalFreq = 0;
    for (const [len, freq] of counts) {
      if (freq > modalFreq || (freq === modalFreq && len > modal)) {
        modal = len;
        modalFreq = freq;
      }
    }
    if (modal <= 1) continue; // this delimiter does not split the data at all
    const consistency = modalFreq / rows.length;
    if (
      best === null ||
      consistency > best.consistency ||
      (consistency === best.consistency && modal > best.modal)
    ) {
      best = { delim, consistency, modal };
    }
  }
  return best?.delim ?? ",";
}

/** Parse delimited text into rows, honouring RFC4180 quoting. */
export function parseRows(text: string, delim: Delimiter): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === delim) {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\r") continue;
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function serializeRows(rows: string[][]): string {
  // Quote any field containing a *candidate* delimiter, not just a comma.
  // Otherwise a field like "loves a;b;c" is emitted bare and a re-sniffing
  // reader (Drive does sniff) can decide the file is semicolon-delimited and
  // split the row into extra columns - the exact silent corruption this
  // module exists to prevent. Verified by test.
  const needsQuote = /[",;\t|\n\r]/;
  const cell = (v: string): string => (needsQuote.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return `${rows.map((r) => r.map(cell).join(",")).join("\n")}\n`;
}

/** Sniff encoding + delimiter and re-emit canonical UTF-8 comma CSV. */
export function normaliseCsv(buf: Buffer): SniffResult {
  const encoding = detectEncoding(buf);
  const decoded = decode(buf, encoding);
  const delimiter = detectDelimiter(decoded);
  const rows = parseRows(decoded, delimiter);
  const text = serializeRows(rows);
  const normalised = encoding !== "utf-8" || delimiter !== "," || text !== decoded;
  return { encoding, delimiter, normalised, text };
}

export function describeDialect(d: Dialect): string {
  const delim = d.delimiter === "\t" ? "\\t" : d.delimiter;
  return `delimiter='${delim}' encoding=${d.encoding}`;
}
