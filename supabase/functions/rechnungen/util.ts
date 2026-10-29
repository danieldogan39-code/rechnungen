// Gemeinsame Hilfsfunktionen für die Rechnungs-App (Server).

export interface Item {
  description?: string;
  quantity?: number;
  unit?: string;
  price?: number; // Einzelpreis netto
  vat?: number; // Steuersatz in Prozent
  discount?: number; // Rabatt in Prozent
}

export const DEFAULTS: Record<string, unknown> = {
  prefix: "RE",
  number_year: false,
  number_digits: 4,
  number_start: 1,
  small_business: false,
  payment_days: 14,
  accent: "#F44C4C",
  intro: "Vielen Dank für Ihren Auftrag. Wir stellen Ihnen folgende Leistungen in Rechnung:",
  closing: "Vielen Dank für die gute Zusammenarbeit!",
  bcc_self: true,
  reminders_enabled: true,
  reminder_interval: 7,
  max_reminders: 3,
  quote_prefix: "AN",
  quote_valid_days: 30,
  quote_intro: "Vielen Dank für Ihre Anfrage. Gerne unterbreiten wir Ihnen folgendes Angebot:",
  quote_closing: "Wir freuen uns auf Ihre Zusage und die Zusammenarbeit.",
  tpl_quote_subject: "Angebot {nummer} – {firma}",
  tpl_quote_body:
    "{anrede},\n\nvielen Dank für Ihr Interesse. Anbei erhalten Sie unser Angebot {nummer} über {betrag}. Es ist gültig bis zum {gueltig}.\n\nWenn alles passt, genügt eine kurze Antwort auf diese E-Mail. Bei Fragen melden Sie sich jederzeit gern.\n\nViele Grüße\n{firma}",
  tpl_invoice_subject: "Rechnung {nummer} – {firma}",
  tpl_invoice_body:
    "{anrede},\n\nanbei erhalten Sie unsere Rechnung {nummer} vom {datum} über {betrag}.\n\nBitte überweisen Sie den Betrag bis zum {faellig} unter Angabe der Rechnungsnummer.\n\nVielen Dank und viele Grüße\n{firma}",
  tpl_correction_subject: "Korrigierte Rechnung {nummer} (ersetzt {alte_nummer})",
  tpl_correction_body:
    "{anrede},\n\ndie Rechnung {alte_nummer} wurde storniert und durch die beigefügte Rechnung {nummer} über {betrag} ersetzt. Im Anhang finden Sie die Stornorechnung und die neue Rechnung.\n\nBitte überweisen Sie den Betrag bis zum {faellig}. Falls Sie die ursprüngliche Rechnung bereits bezahlt haben, geben Sie uns bitte kurz Bescheid, dann verrechnen wir den Betrag.\n\nViele Grüße\n{firma}",
  tpl_cancel_subject: "Stornierung der Rechnung {alte_nummer}",
  tpl_cancel_body:
    "{anrede},\n\ndie Rechnung {alte_nummer} wurde storniert. Die Stornorechnung {nummer} finden Sie im Anhang. Sie müssen nichts weiter tun. Falls Sie bereits bezahlt haben, erstatten wir Ihnen den Betrag.\n\nViele Grüße\n{firma}",
  tpl_reminder_subject: "Zahlungserinnerung zur Rechnung {nummer}",
  tpl_reminder_body:
    "{anrede},\n\nsicher ist es nur untergegangen: Für unsere Rechnung {nummer} vom {datum} über {betrag}, fällig am {faellig}, konnten wir noch keinen Zahlungseingang feststellen.\n\nBitte überweisen Sie den Betrag in den nächsten Tagen. Die Rechnung finden Sie noch einmal im Anhang. Falls Sie bereits gezahlt haben, betrachten Sie diese E-Mail bitte als gegenstandslos.\n\nViele Grüße\n{firma}",
};

export const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export const lineNet = (it: Item) =>
  r2((Number(it.quantity) || 0) * (Number(it.price) || 0) * (1 - Math.min(Math.max(Number(it.discount) || 0, 0), 100) / 100));

export function totals(items: Item[] = [], smallBusiness = false) {
  let net = 0;
  const byRate: Record<string, number> = {};
  for (const it of items) {
    const line = lineNet(it);
    net += line;
    const rate = smallBusiness ? 0 : Number(it.vat) || 0;
    byRate[rate] = (byRate[rate] || 0) + line;
  }
  net = r2(net);
  const vatLines = Object.entries(byRate)
    .map(([rate, base]) => ({ rate: Number(rate), base: r2(base), amount: r2((base * Number(rate)) / 100) }))
    .filter((v) => v.rate > 0)
    .sort((a, b) => b.rate - a.rate);
  const vat = r2(vatLines.reduce((s, v) => s + v.amount, 0));
  return { net, vat, gross: r2(net + vat), vatLines };
}

const EUR = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
export const eur = (n: number) => EUR.format(Number(n) || 0);
export const qty = (n: number) =>
  new Intl.NumberFormat("de-DE", { maximumFractionDigits: 3, useGrouping: false }).format(Number(n) || 0);
export const fmtDate = (iso?: string | null) => (iso ? String(iso).slice(0, 10).split("-").reverse().join(".") : "");

export const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date());

export function addDays(iso: string, n: number) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function addMonths(iso: string, n: number) {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
}

export const fill = (tpl: unknown, vars: Record<string, string>) =>
  String(tpl ?? "").replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

export function formatIban(iban?: string) {
  return String(iban ?? "").replace(/\s+/g, "").toUpperCase().replace(/(.{4})/g, "$1 ").trim();
}
