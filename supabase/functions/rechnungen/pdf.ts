// Erzeugt das Rechnungs-PDF (DIN A4, Anschriftfeld nach DIN 5008 Form B, GiroCode).
import { degrees, PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from "npm:pdf-lib@1.17.1";
import fontkit from "npm:@pdf-lib/fontkit@1.1.1";
import qrcode from "npm:qrcode-generator@2.0.4";
import { BILLING_LABEL, BILLING_SUFFIX, billingOf, eur, fmtDate, formatIban, type Item, lineNet, qty, splitByBilling, totals } from "./util.ts";

const MM = 72 / 25.4;
const W = 595.28;
const H = 841.89;
const ML = 20 * MM;
const RIGHT = W - 18 * MM;
const CW = RIGHT - ML;
const FOOT_TOP = 30 * MM;
const BOTTOM = FOOT_TOP + 8 * MM;

// ---------- Schrift ----------
const FONT_BASE = "https://cdn.jsdelivr.net/npm/@expo-google-fonts/outfit@0.4.3";
const FONT_FILES = {
  regular: `${FONT_BASE}/400Regular/Outfit_400Regular.ttf`,
  semibold: `${FONT_BASE}/600SemiBold/Outfit_600SemiBold.ttf`,
  bold: `${FONT_BASE}/700Bold/Outfit_700Bold.ttf`,
};
export type FontBytes = { regular: Uint8Array; semibold: Uint8Array; bold: Uint8Array };
let fontCache: FontBytes | null = null;
async function loadFontBytes(): Promise<FontBytes | null> {
  if (fontCache) return fontCache;
  try {
    const [regular, semibold, bold] = await Promise.all(
      Object.values(FONT_FILES).map(async (u) => {
        const r = await fetch(u);
        if (!r.ok) throw new Error(String(r.status));
        return new Uint8Array(await r.arrayBuffer());
      }),
    );
    fontCache = { regular, semibold, bold };
    return fontCache;
  } catch (e) {
    console.error("Schrift konnte nicht geladen werden, nutze Helvetica", e);
    return null;
  }
}

// Zeichen, die die Ersatzschrift (WinAnsi) darstellen kann
const CP1252 = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
let unicodeFont = false;
export function clean(s: unknown): string {
  return Array.from(String(s ?? "").replace(/\r/g, "").replace(/\t/g, " "))
    .map((ch) => {
      const c = ch.codePointAt(0)!;
      if (ch === "\n") return ch;
      if (c > 0xffff || (c >= 0xfe00 && c <= 0xfe0f) || c === 0x200d) return ""; // Emojis
      if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || CP1252.has(ch)) return ch;
      if (c === 0x2009 || c === 0x202f || c === 0x2007) return " ";
      if (c === 0x2212) return "-";
      return unicodeFont ? ch : "?";
    })
    .join("");
}

export function wrap(str: unknown, font: PDFFont, size: number, maxW: number): string[] {
  const out: string[] = [];
  for (const para of clean(str).split("\n")) {
    if (!para.trim()) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(/ +/)) {
      const test = line ? line + " " + word : word;
      if (font.widthOfTextAtSize(test, size) <= maxW) {
        line = test;
        continue;
      }
      if (line) out.push(line);
      let w = word;
      while (font.widthOfTextAtSize(w, size) > maxW && w.length > 1) {
        let i = w.length - 1;
        while (i > 1 && font.widthOfTextAtSize(w.slice(0, i), size) > maxW) i--;
        out.push(w.slice(0, i));
        w = w.slice(i);
      }
      line = w;
    }
    out.push(line);
  }
  return out;
}

type Color = ReturnType<typeof rgb>;
function hex(h: unknown, fallback: Color): Color {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(h ?? "").trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function roundRect(p: PDFPage, x: number, y: number, w: number, h: number, r: number, o: { color?: Color; border?: Color; bw?: number }) {
  const path = `M ${r} 0 L ${w - r} 0 Q ${w} 0 ${w} ${r} L ${w} ${h - r} Q ${w} ${h} ${w - r} ${h} L ${r} ${h} Q 0 ${h} 0 ${h - r} L 0 ${r} Q 0 0 ${r} 0 Z`;
  p.drawSvgPath(path, { x, y: y + h, color: o.color, borderColor: o.border, borderWidth: o.border ? (o.bw ?? 0.6) : 0 });
}

// EPC-QR (GiroCode) für SEPA-Überweisungen
export function epcPayload(o: { name: string; iban: string; bic?: string; amount: number; text: string }) {
  return [
    "BCD", "002", "1", "SCT",
    (o.bic ?? "").replace(/\s/g, "").toUpperCase(),
    o.name.slice(0, 70),
    o.iban.replace(/\s/g, "").toUpperCase(),
    `EUR${o.amount.toFixed(2)}`,
    "", "",
    o.text.slice(0, 140),
  ].join("\n");
}
function drawQr(p: PDFPage, data: string, x: number, y: number, size: number, color: Color) {
  // deno-lint-ignore no-explicit-any
  const qr: any = (qrcode as any)(0, "M");
  qr.addData(data, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  const s = size / n;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) p.drawRectangle({ x: x + c * s, y: y + size - (r + 1) * s, width: s + 0.05, height: s + 0.05, color });
    }
  }
}

// deno-lint-ignore no-explicit-any
type Any = any;

export interface PdfInput {
  inv: Any;
  company: Any;
  ref?: { number?: string; issue_date?: string } | null;
  fonts?: FontBytes | null;
}

export async function buildInvoicePdf({ inv, company: c, ref, fonts }: PdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fb = fonts === undefined ? await loadFontBytes() : fonts;
  let f: PDFFont, fm: PDFFont, fb2: PDFFont;
  if (fb) {
    doc.registerFontkit(fontkit);
    f = await doc.embedFont(fb.regular, { subset: true });
    fm = await doc.embedFont(fb.semibold, { subset: true });
    fb2 = await doc.embedFont(fb.bold, { subset: true });
    unicodeFont = true;
  } else {
    f = await doc.embedFont(StandardFonts.Helvetica);
    fm = await doc.embedFont(StandardFonts.HelveticaBold);
    fb2 = fm;
    unicodeFont = false;
  }

  // Medialyte-Farben: Nachtblau für Schrift und Gesamtbetrag, Koralle als Akzent
  const ink = rgb(14 / 255, 25 / 255, 42 / 255);
  const body = rgb(0.2, 0.25, 0.32);
  const muted = rgb(0.4, 0.467, 0.561);
  const hair = rgb(0.86, 0.88, 0.91);
  const accent = hex(c.accent, rgb(244 / 255, 76 / 255, 76 / 255));
  const panel = rgb(0.953, 0.961, 0.976);

  const isDraft = inv.status === "draft";
  const isStorno = inv.kind === "storno";
  const isQuote = inv.kind === "quote";
  const smallSetting = c.small_business === true || c.small_business === "true";
  const items0: Item[] = Array.isArray(inv.items) ? inv.items : [];
  // Kleinunternehmer: Entwürfe folgen der Einstellung, ausgestellte Rechnungen ihren gespeicherten Steuersätzen
  const small = smallSetting && (isDraft || items0.every((i) => !Number(i.vat)));
  const items: Item[] = Array.isArray(inv.items) ? inv.items : [];
  const t = totals(items, small);
  const cu = inv.customer ?? {};
  const docType = isQuote ? "Angebot" : isStorno ? "Stornorechnung" : "Rechnung";
  const fullTitle = `${docType} ${inv.number ?? "(Entwurf)"}`;

  doc.setTitle(clean(fullTitle));
  doc.setAuthor(clean(c.name ?? ""));
  doc.setSubject(clean(`${docType} an ${cu.name ?? ""}`));
  doc.setCreator("Medialyte Rechnungen");
  doc.setProducer("Medialyte Rechnungen");
  doc.setLanguage("de-DE");

  type TO = { size?: number; font?: PDFFont; color?: Color; align?: "left" | "right" | "center" };
  const T = (p: PDFPage, s: unknown, x: number, y: number, o: TO = {}) => {
    const str = clean(s);
    if (!str) return 0;
    const size = o.size ?? 10;
    const font = o.font ?? f;
    const w = font.widthOfTextAtSize(str, size);
    const xx = o.align === "right" ? x - w : o.align === "center" ? x - w / 2 : x;
    p.drawText(str, { x: xx, y, size, font, color: o.color ?? body });
    return w;
  };

  const pages: PDFPage[] = [];
  let page!: PDFPage;
  let y = 0;
  const newPage = () => {
    page = doc.addPage([W, H]);
    pages.push(page);
    y = H - 22 * MM;
    if (pages.length > 1) {
      T(page, clean(c.name), ML, y, { size: 9, font: fm, color: ink });
      T(page, `${fullTitle} · Fortsetzung`, RIGHT, y, { size: 9, color: muted, align: "right" });
      y -= 12 * MM;
    }
  };
  newPage();

  // ---------- Falz- und Lochmarken (DIN 5008) ----------
  // (werden am Ende auf alle Seiten gezeichnet)

  // ---------- Kopf: Logo / Name + Absenderblock ----------
  const headTop = H - 14 * MM;
  let logoDrawn = false;
  if (typeof c.logo === "string" && c.logo.startsWith("data:image/")) {
    try {
      const img = c.logo.startsWith("data:image/png") ? await doc.embedPng(c.logo) : await doc.embedJpg(c.logo);
      const maxW = 72 * MM, maxH = 26 * MM;
      const sc = Math.min(maxW / img.width, maxH / img.height);
      page.drawImage(img, { x: ML, y: headTop - img.height * sc, width: img.width * sc, height: img.height * sc });
      logoDrawn = true;
    } catch (e) {
      console.error("Logo konnte nicht eingebettet werden", e);
    }
  }
  if (!logoDrawn) {
    T(page, c.name || "Firmenname", ML, headTop - 16, { size: 18, font: fb2, color: ink });
    if (c.tagline) T(page, c.tagline, ML, headTop - 30, { size: 8.5, color: muted });
  }
  const headRight: [string, boolean][] = [
    [c.name, true],
    [c.street, false],
    [[c.zip, c.city].filter(Boolean).join(" "), false],
    [c.phone ? `Tel. ${c.phone}` : "", false],
    [c.email, false],
    [c.website, false],
  ];
  let hy = headTop - 7;
  for (const [l, b] of headRight) {
    if (!l) continue;
    T(page, l, RIGHT, hy, { size: 8.5, font: b ? fm : f, color: b ? ink : muted, align: "right" });
    hy -= 11.5;
  }

  // ---------- Anschriftfeld ----------
  const sy = H - 50 * MM;
  const sender = [c.name, c.street, [c.zip, c.city].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
  const senderLine = wrap(sender, f, 7, 85 * MM)[0] ?? "";
  T(page, senderLine, ML, sy, { size: 7, color: muted });
  page.drawLine({ start: { x: ML, y: sy - 2.6 }, end: { x: ML + f.widthOfTextAtSize(senderLine, 7), y: sy - 2.6 }, thickness: 0.4, color: hair });
  let ry = sy - 17;
  const showCountry = cu.country && !/^(deutschland|germany|de)$/i.test(String(cu.country).trim());
  const rec: [unknown, boolean][] = [
    [cu.name || "Kunde fehlt", true],
    [cu.contact, false],
    [cu.street, false],
    [[cu.zip, cu.city].filter(Boolean).join(" "), false],
    [showCountry ? cu.country : "", false],
  ];
  for (const [l, bold] of rec) {
    if (!l) continue;
    for (const ln of wrap(l, bold ? fm : f, 10.5, 85 * MM)) {
      T(page, ln, ML, ry, { size: 10.5, font: bold ? fm : f, color: ink });
      ry -= 14;
    }
  }

  // ---------- Infobox ----------
  const info: [string, string][] = [
    [isQuote ? "Angebotsnr." : isStorno ? "Storno-Nr." : "Rechnungsnr.", inv.number ?? "Entwurf"],
  ];
  if (cu.number) info.push(["Kundennr.", String(cu.number)]);
  info.push([isQuote ? "Angebotsdatum" : isStorno ? "Datum" : "Rechnungsdatum", !inv.number ? "beim Abschließen" : fmtDate(inv.issue_date)]);
  if (inv.service_text) info.push(["Leistung", String(inv.service_text)]);
  if (isQuote) {
    info.push(["Gültig bis", inv.valid_until ? fmtDate(inv.valid_until) : `${c.quote_valid_days ?? 30} Tage ab Datum`]);
  } else {
    if (!isStorno && !isDraft && inv.due_date) info.push(["Fällig am", fmtDate(inv.due_date)]);
    if (isDraft) info.push(["Zahlungsziel", `${c.payment_days ?? 14} Tage`]);
  }
  if (cu.vat_id) info.push(["USt-IdNr. Kunde", String(cu.vat_id)]);
  if (ref?.number) info.push([isStorno ? "Storniert" : "Ersetzt", String(ref.number)]);

  const boxW = 74 * MM;
  const boxX = RIGHT - boxW;
  const pad = 4 * MM;
  const valMax = boxW - pad * 2 - 27 * MM;
  const infoLines = info.map(([k, v]) => [k, wrap(v, fm, 9, valMax)] as [string, string[]]);
  const boxH = pad * 2 + infoLines.reduce((s, [, v]) => s + v.length * 12.5, 0) - 3;
  const boxTop = sy + 4;
  roundRect(page, boxX, boxTop - boxH, boxW, boxH, 7, { color: panel });
  page.drawRectangle({ x: boxX, y: boxTop - boxH + 7, width: 2.2, height: boxH - 14, color: accent });
  let iy = boxTop - pad - 6;
  for (const [k, vals] of infoLines) {
    T(page, k, boxX + pad + 2, iy, { size: 8.5, color: muted });
    vals.forEach((v, i) => T(page, v, RIGHT - pad, iy - i * 12.5, { size: 9, font: fm, color: ink, align: "right" }));
    iy -= vals.length * 12.5;
  }

  y = Math.min(ry, boxTop - boxH, H - 88 * MM) - 12 * MM;

  // ---------- Titel + Einleitung ----------
  const tw = T(page, docType, ML, y, { size: 21, font: fb2, color: ink });
  if (inv.number) T(page, inv.number, ML + tw + 8, y, { size: 21, font: f, color: muted });
  else if (isDraft) T(page, "Entwurf", ML + tw + 8, y, { size: 21, font: f, color: muted });
  y -= 22;
  const intro = isStorno
    ? `Hiermit stornieren wir die Rechnung ${ref?.number ?? ""}${ref?.issue_date ? ` vom ${fmtDate(ref.issue_date)}` : ""} in voller Höhe.`
    : (inv.intro ?? "");
  for (const ln of wrap(intro, f, 10, CW)) {
    T(page, ln, ML, y, { size: 10 });
    y -= 14;
  }
  y -= 10;

  // ---------- Positionen ----------
  const hasDisc = items.some((i) => Number(i.discount) > 0);
  const rates = new Set(items.map((i) => Number(i.vat) || 0));
  const showVat = !small && rates.size > 1;
  // Spalten von rechts nach links
  const cols: { key: string; label: string; right: number; w: number }[] = [];
  let edge = RIGHT;
  const addCol = (key: string, label: string, w: number) => {
    cols.push({ key, label, right: edge, w });
    edge -= w;
  };
  addCol("total", "Gesamt €", 23 * MM);
  if (showVat) addCol("vat", "USt", 12 * MM);
  if (hasDisc) addCol("disc", "Rabatt", 15 * MM);
  addCol("price", "Einzel €", 21 * MM);
  addCol("unit", "Einheit", 16 * MM);
  addCol("qty", "Menge", 13 * MM);
  const descX = ML + 9 * MM;
  const descW = edge - descX - 3 * MM;
  const col = (k: string) => cols.find((x) => x.key === k)!;

  const head = () => {
    const o = { size: 7.5, font: fm, color: muted };
    T(page, "POS.", ML, y, o);
    T(page, "BEZEICHNUNG", descX, y, o);
    for (const cl of cols) {
      if (cl.key === "unit") T(page, cl.label.toUpperCase(), cl.right - cl.w + 3 * MM, y, o);
      else T(page, cl.label.toUpperCase(), cl.right, y, { ...o, align: "right" });
    }
    y -= 7;
    page.drawLine({ start: { x: ML, y }, end: { x: RIGHT, y }, thickness: 0.9, color: ink });
    y -= 15;
  };
  head();

  items.forEach((it, idx) => {
    const raw = clean(it.description || "–").split("\n");
    const titleLines = wrap(raw[0], fm, 9.5, descW);
    const detailLines = raw.length > 1 ? wrap(raw.slice(1).join("\n"), f, 8.8, descW) : [];
    const rowH = titleLines.length * 13 + detailLines.length * 12 + 12;
    if (y - rowH + 10 < BOTTOM) {
      newPage();
      head();
    }
    const top = y;
    T(page, String(idx + 1), ML, y, { size: 9.5, color: muted });
    titleLines.forEach((ln, i) => T(page, ln, descX, y - i * 13, { size: 9.5, font: fm, color: ink }));
    let dy = y - titleLines.length * 13;
    detailLines.forEach((ln) => {
      T(page, ln, descX, dy + 0.5, { size: 8.8, color: muted });
      dy -= 12;
    });
    const o = { size: 9.5, align: "right" as const, color: body };
    T(page, qty(Number(it.quantity)), col("qty").right, top, o);
    T(page, it.unit ?? "", col("unit").right - col("unit").w + 3 * MM, top, { size: 9.5, color: body });
    T(page, eur(Number(it.price)).replace(/\s?€/, ""), col("price").right, top, o);
    if (hasDisc) T(page, Number(it.discount) > 0 ? `${qty(Number(it.discount))} %` : "–", col("disc").right, top, o);
    if (showVat) T(page, `${qty(Number(it.vat))} %`, col("vat").right, top, o);
    T(page, eur(lineNet(it)).replace(/\s?€/, ""), col("total").right, top, { ...o, font: fm, color: ink });
    if (isQuote && billingOf(it) !== "once") {
      T(page, BILLING_LABEL[billingOf(it)].toLowerCase(), col("total").right, top - 12, { size: 7.5, font: fm, color: accent, align: "right" });
    }
    y -= rowH;
    page.drawLine({ start: { x: ML, y: y + 12 }, end: { x: RIGHT, y: y + 12 }, thickness: 0.4, color: hair });
  });

  // ---------- Summen ----------
  y -= 4;
  const lx = RIGHT - 78 * MM;
  const sumRow = (k: string, v: string) => {
    T(page, k, lx + 3 * MM, y, { size: 9.5, color: muted });
    T(page, v, RIGHT - 3 * MM, y, { size: 9.5, color: body, align: "right" });
    y -= 15;
  };
  const totH = 26;
  const groups = isQuote ? splitByBilling(items) : [{ billing: "once", items }];
  groups.forEach((g, gi) => {
    const gt = totals(g.items, small);
    const sumRows = small ? 0 : 1 + gt.vatLines.length;
    if (y - (sumRows * 15 + 40) < BOTTOM) newPage();
    if (!small) {
      sumRow(groups.length > 1 ? `${BILLING_LABEL[g.billing]} netto` : "Summe netto", eur(gt.net) + BILLING_SUFFIX[g.billing]);
      for (const v of gt.vatLines) sumRow(`zzgl. USt ${qty(v.rate)} %`, eur(v.amount) + BILLING_SUFFIX[g.billing]);
      if (!gt.vatLines.length) sumRow("USt", eur(0));
    }
    y -= 4;
    const primary = gi === 0;
    const boxColor = isStorno ? rgb(0.4, 0.467, 0.561) : primary ? ink : rgb(1, 1, 1);
    roundRect(page, lx, y - totH + 15, RIGHT - lx, totH, 7, primary ? { color: boxColor } : { color: boxColor, border: ink, bw: 1 });
    const label = isQuote
      ? (groups.length === 1 && g.billing === "once" ? "Angebotssumme" : g.billing === "once" ? "Einmalig" : BILLING_LABEL[g.billing])
      : isStorno ? "Stornobetrag" : "Gesamtbetrag";
    const txt = primary ? rgb(1, 1, 1) : ink;
    T(page, label + (small ? "*" : ""), lx + 3 * MM, y - 2.5, { size: 11, font: fm, color: txt });
    T(page, eur(gt.gross) + BILLING_SUFFIX[g.billing], RIGHT - 3 * MM, y - 3, { size: 13, font: fb2, color: txt, align: "right" });
    y -= totH + 8;
  });
  y += 2;
  if (small) {
    T(page, "* Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.", RIGHT, y, { size: 8, color: muted, align: "right" });
    y -= 12;
  }
  if (isQuote && groups.some((g) => g.billing !== "once")) {
    y -= 2;
    for (const ln of wrap("Laufende Leistungen werden ab Beginn der Zusammenarbeit im jeweiligen Rhythmus im Voraus berechnet.", f, 8.5, CW)) {
      T(page, ln, ML, y, { size: 8.5, color: muted });
      y -= 12;
    }
  }

  // ---------- Zahlung ----------
  y -= 8;
  const iban = String(c.iban ?? "").replace(/\s/g, "");
  const holder = String(c.account_holder || c.name || "");
  const showPay = !isQuote && !isStorno && t.gross > 0 && !!iban;
  if (showPay) {
    const payH = 34 * MM;
    if (y - payH < BOTTOM) newPage();
    const top = y + 4;
    roundRect(page, ML, top - payH, CW, payH, 8, { color: rgb(1, 1, 1), border: hair, bw: 0.8 });
    const px = ML + 5 * MM;
    let py = top - 6 * MM;
    T(page, "Zahlungsinformationen", px, py, { size: 10, font: fm, color: ink });
    py -= 15;
    const due = isDraft ? `innerhalb von ${c.payment_days ?? 14} Tagen` : `bis ${fmtDate(inv.due_date)}`;
    const payRows: [string, string][] = [
      ["Betrag", `${eur(t.gross)}  ${due}`],
      ["Empfänger", holder],
      ["IBAN", formatIban(iban)],
    ];
    if (c.bic || c.bank) payRows.push(["BIC / Bank", [c.bic, c.bank].filter(Boolean).join(" · ")]);
    payRows.push(["Verwendungszweck", inv.number ? `Rechnung ${inv.number}` : "Rechnungsnummer"]);
    for (const [k, v] of payRows) {
      T(page, k, px, py, { size: 8.5, color: muted });
      T(page, v, px + 31 * MM, py, { size: 8.5, font: k === "IBAN" || k === "Betrag" ? fm : f, color: ink });
      py -= 12;
    }
    const qs = payH - 10 * MM;
    const qx = RIGHT - 5 * MM - qs;
    const qy = top - 5 * MM - qs;
    if (isDraft || !inv.number) {
      roundRect(page, qx, qy, qs, qs, 6, { color: panel, border: hair, bw: 0.6 });
      T(page, "QR-Code", qx + qs / 2, qy + qs / 2 + 3, { size: 8, font: fm, color: muted, align: "center" });
      T(page, "nach dem Abschließen", qx + qs / 2, qy + qs / 2 - 8, { size: 7, color: muted, align: "center" });
    } else {
      drawQr(page, epcPayload({ name: holder, iban, bic: c.bic, amount: t.gross, text: `Rechnung ${inv.number}` }), qx, qy, qs, ink);
      const cx = qx - 4 * MM;
      T(page, "Überweisen per Code", cx, qy + qs - 9, { size: 8.5, font: fm, color: accent, align: "right" });
      T(page, "Mit der Banking-App", cx, qy + qs - 21, { size: 8, color: muted, align: "right" });
      T(page, "scannen – alles ist", cx, qy + qs - 31, { size: 8, color: muted, align: "right" });
      T(page, "schon ausgefüllt.", cx, qy + qs - 41, { size: 8, color: muted, align: "right" });
    }
    y = top - payH - 10 * MM;
  } else if (isQuote) {
    // Gültigkeit und Feld für die Auftragserteilung
    const validTxt = inv.valid_until
      ? `Dieses Angebot ist gültig bis zum ${fmtDate(inv.valid_until)}. Die Zahlung erfolgt nach Rechnungsstellung innerhalb von ${c.payment_days ?? 14} Tagen.`
      : `Dieses Angebot ist ${c.quote_valid_days ?? 30} Tage gültig. Die Zahlung erfolgt nach Rechnungsstellung innerhalb von ${c.payment_days ?? 14} Tagen.`;
    for (const ln of wrap(validTxt, f, 10, CW)) {
      T(page, ln, ML, y, { size: 10 });
      y -= 14;
    }
    y -= 8;
    const accH = 30 * MM;
    if (y - accH < BOTTOM) newPage();
    const top = y + 4;
    roundRect(page, ML, top - accH, CW, accH, 8, { color: rgb(1, 1, 1), border: hair, bw: 0.8 });
    const px = ML + 5 * MM;
    T(page, "Auftragserteilung", px, top - 6 * MM, { size: 10, font: fm, color: ink });
    T(page, `Hiermit erteilen wir den Auftrag gemäß Angebot ${inv.number ?? ""}.`, px, top - 6 * MM - 14, { size: 9, color: body });
    const lineY = top - accH + 9 * MM;
    const half = (CW - 15 * MM) / 2;
    page.drawLine({ start: { x: px, y: lineY }, end: { x: px + half - 5 * MM, y: lineY }, thickness: 0.6, color: muted });
    page.drawLine({ start: { x: px + half + 5 * MM, y: lineY }, end: { x: RIGHT - 5 * MM, y: lineY }, thickness: 0.6, color: muted });
    T(page, "Ort, Datum", px, lineY - 11, { size: 8, color: muted });
    T(page, "Unterschrift, Firmenstempel", px + half + 5 * MM, lineY - 11, { size: 8, color: muted });
    y = top - accH - 10 * MM;
  } else if (isStorno) {
    T(page, "Bereits gezahlte Beträge erstatten oder verrechnen wir.", ML, y, { size: 10 });
    y -= 22;
  }

  // ---------- Anmerkungen, Schlusssatz ----------
  const paras: string[] = [];
  if (inv.notes) paras.push(String(inv.notes));
  if (isQuote) {
    if (c.quote_closing) paras.push(String(c.quote_closing));
  } else if (!isStorno && c.closing) paras.push(String(c.closing));
  for (const p of paras) {
    const lines = wrap(p, f, 10, CW);
    if (y - lines.length * 14 < BOTTOM) newPage();
    for (const ln of lines) {
      T(page, ln, ML, y, { size: 10 });
      y -= 14;
    }
    y -= 6;
  }

  // ---------- Fußzeile, Falzmarken, Entwurf-Wasserzeichen ----------
  const footCols = [
    [c.name, c.street, [c.zip, c.city].filter(Boolean).join(" "), c.owner],
    [c.phone && `Tel. ${c.phone}`, c.email, c.website],
    [c.tax_number && `Steuernummer: ${c.tax_number}`, c.vat_id && `USt-IdNr.: ${c.vat_id}`, c.register],
    [c.account_holder, c.bank, iban && `IBAN: ${formatIban(iban)}`, c.bic && `BIC: ${c.bic}`],
  ].map((cl) => cl.filter(Boolean) as string[]).filter((cl) => cl.length);
  const weights = footCols.length === 4 ? [0.24, 0.22, 0.25, 0.29] : footCols.map(() => 1 / footCols.length);
  const colX = weights.map((_, i) => ML + CW * weights.slice(0, i).reduce((a, b) => a + b, 0));
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: 0, y: H - 105 * MM }, end: { x: 5 * MM, y: H - 105 * MM }, thickness: 0.5, color: hair });
    p.drawLine({ start: { x: 0, y: H - 210 * MM }, end: { x: 5 * MM, y: H - 210 * MM }, thickness: 0.5, color: hair });
    p.drawLine({ start: { x: 0, y: H / 2 }, end: { x: 7 * MM, y: H / 2 }, thickness: 0.5, color: hair });
    p.drawLine({ start: { x: ML, y: FOOT_TOP }, end: { x: RIGHT, y: FOOT_TOP }, thickness: 0.5, color: hair });
    footCols.forEach((cl, ci) => {
      let fy = FOOT_TOP - 12;
      cl.forEach((l, li) => {
        for (const ln of wrap(l, li === 0 ? fm : f, 7.2, CW * weights[ci] - 6)) {
          T(p, ln, colX[ci], fy, { size: 7.2, font: li === 0 ? fm : f, color: li === 0 ? body : muted });
          fy -= 9.5;
        }
      });
    });
    T(p, `Seite ${i + 1}/${pages.length}`, W / 2, 10 * MM, { size: 7.5, color: muted, align: "center" });
    if (isDraft) {
      p.drawText(clean("ENTWURF"), {
        x: W / 2 - 165,
        y: H / 2 - 115,
        size: 96,
        font: fb2,
        color: rgb(0.85, 0.15, 0.15),
        opacity: 0.07,
        rotate: degrees(35),
      });
    }
  });

  return await doc.save();
}
