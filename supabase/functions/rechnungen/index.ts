// Edge Function "rechnungen": PDF, Abschließen, Versand, Korrektur/Storno, Abos, Zahlungserinnerungen.
import { createClient } from "npm:@supabase/supabase-js@2";
import { buildInvoicePdf } from "./pdf.ts";
import { addDays, addMonths, BILLING_SUFFIX, DEFAULTS, eur, fill, fmtDate, splitByBilling, today, totals } from "./util.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
// Server-Schlüssel: alte (service_role) und neue (sb_secret_…) Projekte werden unterstützt
function findServiceKey(): string {
  const direct = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY") ||
    Deno.env.get("SECRET_KEY") || Deno.env.get("SERVICE_ROLE_KEY");
  if (direct) return direct;
  const many = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (many) {
    try {
      const parsed = JSON.parse(many);
      const vals = Array.isArray(parsed) ? parsed : Object.values(parsed);
      const key = vals.map((v: unknown) => (typeof v === "string" ? v : (v as Record<string, string>)?.api_key ?? (v as Record<string, string>)?.key))
        .find((v: unknown) => typeof v === "string" && v.length > 20);
      if (key) return key as string;
    } catch {
      const first = many.split(/[\s,]+/).find((v) => v.startsWith("sb_secret_"));
      if (first) return first;
    }
  }
  throw new Error("Server-Schlüssel fehlt: Bitte unter Edge Functions → Secrets den Eintrag SECRET_KEY mit deinem Secret key (sb_secret_…) anlegen.");
}
const SERVICE_KEY = findServiceKey();
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const MAIL_PROVIDER = (Deno.env.get("MAIL_PROVIDER") ?? "resend").toLowerCase();
const MAIL_API_KEY = Deno.env.get("MAIL_API_KEY") ?? "";

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });

class UserError extends Error {}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action;

    if (action === "daily") {
      if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) return json({ error: "Nicht erlaubt" }, 401);
      return json(await runDaily());
    }

    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: u, error } = await db.auth.getUser(token);
    if (error || !u?.user) return json({ error: "Bitte neu anmelden." }, 401);
    const uid = u.user.id;

    switch (action) {
      case "pdf": {
        const s = await getSettings(uid);
        const { bytes, filename } = await renderPdf(await getInvoice(uid, body.id), s);
        return new Response(new Uint8Array(bytes), {
          headers: { ...CORS, "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${filename}"` },
        });
      }
      case "issue":
        return json(await issue(uid, body.id, !!body.send, { issueDate: body.issue_date, paidAt: body.paid_at, paid: !!body.paid }));
      case "recurring_backfill": {
        const { data: r } = await db.from("recurring").select("*").eq("id", body.id).eq("user_id", uid).maybeSingle();
        if (!r) throw new UserError("Abo nicht gefunden.");
        return json(await backfillRecurring(r, body.mode === "open" ? "open" : "paid"));
      }
      case "send":
        return json(await sendInvoice(uid, body.id));
      case "remind": {
        const inv = await getInvoice(uid, body.id);
        if (inv.kind !== "invoice" || inv.status !== "open") throw new UserError("Erinnerungen gibt es nur für offene Rechnungen.");
        return json(await sendInvoice(uid, body.id, "reminder"));
      }
      case "correct":
        return json(await correct(uid, body.id, body.mode === "cancel" ? "cancel" : "replace"));
      case "run_recurring": {
        const { data: r } = await db.from("recurring").select("*").eq("id", body.id).eq("user_id", uid).maybeSingle();
        if (!r) throw new UserError("Abo nicht gefunden.");
        return json(await createFromRecurring(r));
      }
      case "quote_pdf": {
        const s = await getSettings(uid);
        const q = await getQuote(uid, body.id);
        const { bytes, filename } = await renderQuotePdf(q, s);
        return new Response(new Uint8Array(bytes), {
          headers: { ...CORS, "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${filename}"` },
        });
      }
      case "quote_issue":
        return json(await issueQuote(uid, body.id, !!body.send, body.issue_date));
      case "quote_send":
        return json(await sendQuote(uid, body.id));
      case "import_invoice":
        return json(await importInvoice(uid, body));
      case "test_mail":
        return json(await testMail(uid, u.user.email ?? ""));
      default:
        return json({ error: "Unbekannte Aktion" }, 400);
    }
  } catch (e) {
    console.error(e);
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: msg }, 400);
  }
});

// ---------- Daten ----------

async function getSettings(uid: string) {
  const { data } = await db.from("settings").select("company").eq("user_id", uid).maybeSingle();
  const merged: Any = { ...DEFAULTS };
  for (const [k, v] of Object.entries(data?.company ?? {})) if (v !== "" && v !== null && v !== undefined) merged[k] = v;
  return merged;
}

async function getInvoice(uid: string, id: string) {
  const { data } = await db.from("invoices").select("*").eq("id", id).eq("user_id", uid).maybeSingle();
  if (!data) throw new UserError("Rechnung nicht gefunden.");
  return data;
}

async function getCustomer(uid: string, id: string) {
  const { data } = await db.from("customers").select("*").eq("id", id).eq("user_id", uid).maybeSingle();
  if (!data) throw new UserError("Kunde nicht gefunden.");
  return data;
}

const snapshot = (c: Any) => ({
  name: c.name, number: c.number, contact: c.contact, street: c.street, zip: c.zip, city: c.city,
  country: c.country, email: c.email, vat_id: c.vat_id,
});

function checkCompany(s: Any) {
  const missing: string[] = [];
  if (!s.name) missing.push("Firmenname");
  if (!s.street || !s.zip || !s.city) missing.push("Anschrift");
  if (!s.tax_number && !s.vat_id) missing.push("Steuernummer oder USt-IdNr.");
  if (!s.iban) missing.push("IBAN");
  if (missing.length) throw new UserError(`Bitte in den Einstellungen ergänzen: ${missing.join(", ")}.`);
}

const isOn = (v: unknown) => v === true || v === "true";

// Nummernformat: Präfix + optional Jahr + fortlaufende Nummer, z. B. RE0031 oder RE-2026-0031
async function nextNumber(uid: string, s: Any, isoDate: string, customerId?: string | null) {
  // Eigener Nummernkreis je Kunde: Präfix-Kundennummer-laufende Nummer, z. B. RE-10002-0031
  if (isOn(s.number_per_customer)) {
    if (!customerId) throw new UserError("Für die Rechnungsnummer wird ein Kunde benötigt.");
    const cust = await getCustomer(uid, customerId);
    const kn = String(cust.number ?? "").trim();
    if (!kn) throw new UserError(`Bitte für ${cust.name} eine Kundennummer eintragen – sie ist Teil der Rechnungsnummer.`);
    const { data, error } = await db.rpc("next_customer_invoice_number", { p_user: uid, p_customer: customerId });
    if (error) throw error;
    const digits = Math.min(Math.max(parseInt(s.number_digits, 10) || 4, 1), 8);
    const prefix = String(s.prefix ?? "");
    return `${prefix}${prefix && !/[-_/]$/.test(prefix) ? "-" : ""}${kn}-${String(data).padStart(digits, "0")}`;
  }
  const year = Number(isoDate.slice(0, 4));
  const withYear = isOn(s.number_year);
  const { data, error } = await db.rpc("next_invoice_number", {
    p_user: uid,
    p_year: withYear ? year : 0,
    p_min: Math.max(1, parseInt(s.number_start, 10) || 1),
  });
  if (error) throw error;
  const digits = Math.min(Math.max(parseInt(s.number_digits, 10) || 4, 1), 8);
  const nr = String(data).padStart(digits, "0");
  const prefix = String(s.prefix ?? "");
  return withYear ? `${prefix}${prefix && !/[-_/]$/.test(prefix) ? "-" : ""}${year}-${nr}` : `${prefix}${nr}`;
}

// ---------- Abschließen ----------

const ISO = /^\d{4}-\d{2}-\d{2}$/;
// Frühestes Datum für Nachträge und Statistik
const HISTORY_START = "2024-01-01";
// Datum für Nachträge prüfen: gültig, nicht in der Zukunft, nicht vor 2024
function pastDate(v: unknown, label: string): string | null {
  if (v === undefined || v === null || v === "") return null;
  const d = String(v).slice(0, 10);
  if (!ISO.test(d)) throw new UserError(`${label} ist ungültig.`);
  if (d < HISTORY_START) throw new UserError(`${label} darf nicht vor dem 01.01.2024 liegen.`);
  if (d > today()) throw new UserError(`${label} darf nicht in der Zukunft liegen.`);
  return d;
}

async function issue(uid: string, id: string, send: boolean, opt: { issueDate?: string; paidAt?: string; paid?: boolean } = {}) {
  const inv = await getInvoice(uid, id);
  if (inv.status !== "draft") throw new UserError("Diese Rechnung ist bereits abgeschlossen.");
  const s = await getSettings(uid);
  checkCompany(s);
  if (!inv.customer_id) throw new UserError("Bitte einen Kunden wählen.");
  const cust = await getCustomer(uid, inv.customer_id);
  const small = isOn(s.small_business);
  const items = (inv.items ?? []).filter((i: Any) => i.description || Number(i.price))
    .map((i: Any) => (small ? { ...i, vat: 0 } : i));
  if (!items.length) throw new UserError("Bitte mindestens eine Position eintragen.");
  if (!String(inv.service_text ?? "").trim()) throw new UserError("Bitte Leistungsdatum oder -zeitraum angeben.");
  if (send && !cust.email) throw new UserError("Für diesen Kunden ist keine E-Mail-Adresse hinterlegt.");

  const t = totals(items, small);
  const issueDate = pastDate(opt.issueDate, "Das Rechnungsdatum") ?? today();
  const paidAt = opt.paid ? (pastDate(opt.paidAt, "Das Zahlungsdatum") ?? issueDate) : null;
  if (paidAt && paidAt < issueDate) throw new UserError("Das Zahlungsdatum liegt vor dem Rechnungsdatum.");
  const number = await nextNumber(uid, s, issueDate, inv.customer_id);
  const { data: upd, error } = await db.from("invoices").update({
    number,
    status: paidAt ? "paid" : "open",
    paid_at: paidAt ? new Date(paidAt + "T12:00:00Z").toISOString() : null,
    sent_at: issueDate < today() ? new Date(issueDate + "T09:00:00Z").toISOString() : null,
    issue_date: issueDate,
    due_date: addDays(issueDate, Number(s.payment_days) || 14),
    customer: snapshot(cust),
    items,
    net: t.net,
    vat: t.vat,
    gross: t.gross,
  }).eq("id", id).eq("user_id", uid).select().single();
  if (error) throw error;

  let mail = null;
  if (send) mail = await sendInvoice(uid, id);
  return { invoice: upd, mail };
}

// ---------- Korrektur / Storno ----------

async function correct(uid: string, id: string, mode: "replace" | "cancel") {
  const inv = await getInvoice(uid, id);
  if (inv.kind !== "invoice" || !["open", "paid"].includes(inv.status)) {
    throw new UserError("Nur offene oder bezahlte Rechnungen können korrigiert oder storniert werden.");
  }
  const s = await getSettings(uid);
  const date = today();
  const number = await nextNumber(uid, s, date, inv.customer_id);
  const stornoItems = (inv.items ?? []).map((it: Any) => ({ ...it, quantity: -(Number(it.quantity) || 0) }));
  const t = totals(stornoItems);
  const { data: storno, error } = await db.from("invoices").insert({
    user_id: uid,
    number,
    kind: "storno",
    status: "cancelled",
    customer_id: inv.customer_id,
    customer: inv.customer,
    issue_date: date,
    service_text: inv.service_text,
    items: stornoItems,
    net: t.net,
    vat: t.vat,
    gross: t.gross,
    ref_invoice_id: inv.id,
  }).select().single();
  if (error) throw error;
  const { error: e2 } = await db.from("invoices").update({ status: "cancelled" }).eq("id", inv.id);
  if (e2) throw e2;

  if (mode === "cancel") {
    let mail = null;
    let mailError = null;
    try {
      mail = await sendInvoice(uid, storno.id, "cancel");
    } catch (e) {
      mailError = e instanceof Error ? e.message : String(e);
    }
    return { storno, mail, mailError };
  }

  const { data: draft, error: e3 } = await db.from("invoices").insert({
    user_id: uid,
    kind: "invoice",
    status: "draft",
    customer_id: inv.customer_id,
    items: inv.items,
    service_text: inv.service_text,
    intro: inv.intro,
    notes: inv.notes,
    ref_invoice_id: inv.id,
  }).select().single();
  if (e3) throw e3;
  return { storno, draft };
}

// ---------- PDF & Versand ----------

async function renderPdf(inv: Any, s: Any) {
  let ref = null;
  if (inv.ref_invoice_id) {
    ref = (await db.from("invoices").select("number,issue_date").eq("id", inv.ref_invoice_id).maybeSingle()).data;
  }
  let customer = inv.customer;
  if (!customer && inv.customer_id) {
    const { data } = await db.from("customers").select("*").eq("id", inv.customer_id).maybeSingle();
    if (data) customer = snapshot(data);
  }
  const bytes = await buildInvoicePdf({ inv: { ...inv, customer }, company: s, ref });
  const filename = `${inv.kind === "storno" ? "Stornorechnung" : "Rechnung"}_${inv.number ?? "Entwurf"}.pdf`;
  return { bytes, filename };
}

type MailType = "invoice" | "correction" | "cancel" | "reminder";

async function sendInvoice(uid: string, id: string, forced?: MailType) {
  const inv = await getInvoice(uid, id);
  if (inv.status === "draft") throw new UserError("Entwürfe können nicht versendet werden.");
  const s = await getSettings(uid);
  const type: MailType = forced ?? (inv.kind === "storno" ? "cancel" : inv.ref_invoice_id ? "correction" : "invoice");

  let to = inv.customer?.email;
  if (inv.customer_id) {
    const { data } = await db.from("customers").select("email").eq("id", inv.customer_id).maybeSingle();
    if (data?.email) to = data.email;
  }
  if (!to) throw new UserError("Für diesen Kunden ist keine E-Mail-Adresse hinterlegt.");

  let ref: Any = null;
  if (inv.ref_invoice_id) ref = (await db.from("invoices").select("*").eq("id", inv.ref_invoice_id).maybeSingle()).data;

  const attachments: { bytes: Uint8Array; filename: string }[] = [];
  if (type === "correction" && ref) {
    const { data: st } = await db.from("invoices").select("*").eq("kind", "storno").eq("ref_invoice_id", ref.id)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (st) attachments.push(await renderPdf(st, s));
  }
  attachments.push(await renderPdf(inv, s));

  const vars: Record<string, string> = {
    nummer: inv.number ?? "",
    alte_nummer: ref?.number ?? "",
    kunde: inv.customer?.name ?? "",
    anrede: inv.customer?.contact ? `Guten Tag ${inv.customer.contact}` : "Sehr geehrte Damen und Herren",
    betrag: eur(Number(inv.gross)),
    datum: fmtDate(inv.issue_date),
    faellig: fmtDate(inv.due_date),
    leistung: inv.service_text ?? "",
    firma: s.name ?? "",
  };
  const subject = fill(s[`tpl_${type}_subject`], vars);
  const text = fill(s[`tpl_${type}_body`], vars);

  let status = "sent";
  let error: string | null = null;
  try {
    await sendMail(s, to, subject, text, attachments);
  } catch (e) {
    status = "error";
    error = e instanceof Error ? e.message : String(e);
  }
  await db.from("mail_log").insert({ user_id: uid, invoice_id: inv.id, type, recipient: to, subject, status, error });
  if (status === "error") throw new UserError(`Versand fehlgeschlagen: ${error}`);

  if (type === "reminder") {
    await db.from("invoices").update({ reminders_sent: (inv.reminders_sent ?? 0) + 1, last_reminder_at: today() }).eq("id", inv.id);
  } else {
    await db.from("invoices").update({ sent_at: new Date().toISOString() }).eq("id", inv.id);
  }
  return { to, type };
}

function b64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const textToHtml = (t: string) =>
  `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1c21">${
    escHtml(t).replace(/\n/g, "<br>")
  }</div>`;

async function sendMail(s: Any, to: string, subject: string, text: string, atts: { bytes: Uint8Array; filename: string }[]) {
  if (!MAIL_API_KEY) throw new Error("MAIL_API_KEY fehlt (in Supabase unter Edge Functions → Secrets eintragen).");
  if (!s.sender_email) throw new Error("Absender-E-Mail fehlt in den Einstellungen.");
  const fromName = String(s.sender_name || s.name || "").replace(/["<>]/g, "");
  const replyTo = s.reply_to || s.email || undefined;
  const bccAddr = s.bcc_self ? (s.reply_to || s.email || s.sender_email) : undefined;
  const bcc = bccAddr && bccAddr.toLowerCase() !== to.toLowerCase() ? bccAddr : undefined;
  const html = textToHtml(text);

  if (MAIL_PROVIDER === "brevo") {
    const r = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": MAIL_API_KEY, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: { name: fromName || undefined, email: s.sender_email },
        to: [{ email: to }],
        bcc: bcc ? [{ email: bcc }] : undefined,
        replyTo: replyTo ? { email: replyTo } : undefined,
        subject,
        textContent: text,
        htmlContent: html,
        attachment: atts.length ? atts.map((a) => ({ name: a.filename, content: b64(a.bytes) })) : undefined,
      }),
    });
    if (!r.ok) throw new Error(`Brevo ${r.status}: ${await r.text()}`);
    return;
  }

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${MAIL_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: fromName ? `"${fromName}" <${s.sender_email}>` : s.sender_email,
      to: [to],
      bcc: bcc ? [bcc] : undefined,
      reply_to: replyTo,
      subject,
      text,
      html,
      attachments: atts.map((a) => ({ filename: a.filename, content: b64(a.bytes) })),
    }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
}

async function testMail(uid: string, userEmail: string) {
  const s = await getSettings(uid);
  const to = s.reply_to || s.email || userEmail;
  if (!to) throw new UserError("Bitte zuerst deine E-Mail-Adresse in den Einstellungen eintragen.");
  await sendMail(
    { ...s, bcc_self: false },
    to,
    "Testmail aus deiner Rechnungs-App",
    "Hallo,\n\nder E-Mail-Versand deiner Rechnungs-App funktioniert.\n\nViele Grüße\nDeine Rechnungs-App",
    [],
  );
  return { to };
}



// ---------- Bestehende Rechnung (z. B. aus Lexoffice) übernehmen ----------

async function importInvoice(uid: string, b: Any) {
  const number = String(b.number ?? "").trim();
  if (!number) throw new UserError("Bitte die Rechnungsnummer angeben.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.issue_date ?? ""))) throw new UserError("Bitte ein gültiges Rechnungsdatum angeben.");
  if (!b.customer_id) throw new UserError("Bitte einen Kunden wählen.");
  const { data: dup } = await db.from("invoices").select("id").eq("user_id", uid).eq("number", number).maybeSingle();
  if (dup) throw new UserError(`Die Rechnungsnummer ${number} gibt es schon.`);
  const cust = await getCustomer(uid, b.customer_id);
  const items = (Array.isArray(b.items) ? b.items : []).filter((i: Any) => i.description || Number(i.price));
  if (!items.length) throw new UserError("Bitte mindestens eine Position angeben.");
  const t = totals(items);
  const s = await getSettings(uid);
  pastDate(b.issue_date, "Das Rechnungsdatum");
  const due = /^\d{4}-\d{2}-\d{2}$/.test(String(b.due_date ?? "")) ? b.due_date : addDays(b.issue_date, Number(s.payment_days) || 14);
  const paid = b.status === "paid";
  const { data, error } = await db.from("invoices").insert({
    user_id: uid,
    number,
    kind: "invoice",
    status: paid ? "paid" : "open",
    customer_id: cust.id,
    customer: snapshot(cust),
    issue_date: b.issue_date,
    due_date: due,
    service_text: b.service_text ?? "",
    items,
    net: t.net,
    vat: t.vat,
    gross: t.gross,
    intro: b.intro ?? s.intro,
    notes: b.notes ?? null,
    sent_at: new Date(b.issue_date + "T09:00:00Z").toISOString(),
    paid_at: paid && /^\d{4}-\d{2}-\d{2}/.test(String(b.paid_at ?? "")) ? new Date(String(b.paid_at).slice(0, 10) + "T12:00:00Z").toISOString() : null,
    imported: true,
  }).select().single();
  if (error) throw error;
  return { invoice: data };
}

// ---------- Angebote ----------

async function getQuote(uid: string, id: string) {
  const { data } = await db.from("quotes").select("*").eq("id", id).eq("user_id", uid).maybeSingle();
  if (!data) throw new UserError("Angebot nicht gefunden.");
  return data;
}

// Eigene Nummernfolge für Angebote (Zähler mit negativem Jahr, getrennt von den Rechnungen)
async function nextQuoteNumber(uid: string, s: Any, isoDate: string) {
  const year = Number(isoDate.slice(0, 4));
  const withYear = isOn(s.number_year);
  const { data, error } = await db.rpc("next_invoice_number", { p_user: uid, p_year: withYear ? -year : -1, p_min: 1 });
  if (error) throw error;
  const digits = Math.min(Math.max(parseInt(s.number_digits, 10) || 4, 1), 8);
  const nr = String(data).padStart(digits, "0");
  const prefix = String(s.quote_prefix ?? "AN");
  return withYear ? `${prefix}${prefix && !/[-_/]$/.test(prefix) ? "-" : ""}${year}-${nr}` : `${prefix}${nr}`;
}

async function renderQuotePdf(q: Any, s: Any) {
  let customer = q.customer;
  if ((!customer || q.status === "draft") && q.customer_id) {
    const { data } = await db.from("customers").select("*").eq("id", q.customer_id).maybeSingle();
    if (data) customer = snapshot(data);
  }
  const bytes = await buildInvoicePdf({ inv: { ...q, kind: "quote", customer }, company: s });
  return { bytes, filename: `Angebot_${q.number ?? "Entwurf"}.pdf` };
}

async function issueQuote(uid: string, id: string, send: boolean, issueDateIn?: string) {
  const q = await getQuote(uid, id);
  const s = await getSettings(uid);
  checkCompany(s);
  if (!q.customer_id) throw new UserError("Bitte einen Kunden wählen.");
  const cust = await getCustomer(uid, q.customer_id);
  const small = isOn(s.small_business);
  const items = (q.items ?? []).filter((i: Any) => i.description || Number(i.price)).map((i: Any) => (small ? { ...i, vat: 0 } : i));
  if (!items.length) throw new UserError("Bitte mindestens eine Position eintragen.");
  if (send && !cust.email) throw new UserError("Für diesen Kunden ist keine E-Mail-Adresse hinterlegt.");
  const t = totals(items, small);
  const date = pastDate(issueDateIn, "Das Angebotsdatum") ?? today();
  const patch: Any = {
    customer: snapshot(cust), items, net: t.net, vat: t.vat, gross: t.gross,
    status: q.status === "draft" ? "sent" : q.status,
  };
  if (!q.number) {
    patch.number = await nextQuoteNumber(uid, s, date);
    patch.issue_date = date;
  }
  if (!q.valid_until) patch.valid_until = addDays(patch.issue_date ?? q.issue_date ?? date, Number(s.quote_valid_days) || 30);
  const { data: upd, error } = await db.from("quotes").update(patch).eq("id", id).eq("user_id", uid).select().single();
  if (error) throw error;
  let mail = null;
  if (send) mail = await sendQuote(uid, id);
  return { quote: upd, mail };
}

async function sendQuote(uid: string, id: string) {
  const q = await getQuote(uid, id);
  if (!q.number) throw new UserError("Bitte das Angebot zuerst abschließen.");
  const s = await getSettings(uid);
  let to = q.customer?.email;
  if (q.customer_id) {
    const { data } = await db.from("customers").select("email").eq("id", q.customer_id).maybeSingle();
    if (data?.email) to = data.email;
  }
  if (!to) throw new UserError("Für diesen Kunden ist keine E-Mail-Adresse hinterlegt.");
  const pdf = await renderQuotePdf(q, s);
  const vars: Record<string, string> = {
    nummer: q.number ?? "",
    kunde: q.customer?.name ?? "",
    anrede: q.customer?.contact ? `Guten Tag ${q.customer.contact}` : "Sehr geehrte Damen und Herren",
    betrag: splitByBilling(q.items).map((g) => {
      const v = eur(totals(g.items, isOn(s.small_business)).gross);
      return g.billing === "once" ? (splitByBilling(q.items).length > 1 ? `${v} einmalig` : v) : v + BILLING_SUFFIX[g.billing];
    }).join(" zzgl. "),
    datum: fmtDate(q.issue_date),
    gueltig: fmtDate(q.valid_until),
    leistung: q.service_text ?? "",
    firma: s.name ?? "",
  };
  const subject = fill(s.tpl_quote_subject, vars);
  const text = fill(s.tpl_quote_body, vars);
  let status = "sent";
  let error: string | null = null;
  try {
    await sendMail(s, to, subject, text, [pdf]);
  } catch (e) {
    status = "error";
    error = e instanceof Error ? e.message : String(e);
  }
  await db.from("mail_log").insert({ user_id: uid, quote_id: q.id, type: "quote", recipient: to, subject, status, error });
  if (status === "error") throw new UserError(`Versand fehlgeschlagen: ${error}`);
  await db.from("quotes").update({ sent_at: new Date().toISOString() }).eq("id", q.id);
  return { to, type: "quote" };
}

// ---------- Abos & täglicher Lauf ----------

const STEP: Record<string, number> = { monthly: 1, quarterly: 3, yearly: 12 };

async function createFromRecurring(r: Any) {
  const s = await getSettings(r.user_id);
  const start = r.next_date;
  const next = addMonths(start, STEP[r.interval] ?? 1);
  const service = `${fmtDate(start)} – ${fmtDate(addDays(next, -1))}`;
  const { data: draft, error } = await db.from("invoices").insert({
    user_id: r.user_id,
    kind: "invoice",
    status: "draft",
    customer_id: r.customer_id,
    items: r.items,
    service_text: service,
    intro: s.intro,
    recurring_id: r.id,
  }).select().single();
  if (error) throw error;
  // Termin zuerst weiterschieben, damit nie doppelt erzeugt wird
  await db.from("recurring").update({ next_date: next }).eq("id", r.id);
  r.next_date = next;
  try {
    return await issue(r.user_id, draft.id, !!r.auto_send);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new UserError(`Rechnung als Entwurf angelegt, aber nicht abgeschlossen: ${msg}`);
  }
}

// Abo mit Startdatum in der Vergangenheit: vergangene Zeiträume nachtragen, ohne E-Mail
function workday(iso: string) {
  const d = new Date(iso + "T00:00:00Z");
  const wd = d.getUTCDay();
  return wd === 6 ? addDays(iso, 2) : wd === 0 ? addDays(iso, 1) : iso;
}
async function backfillRecurring(r: Any, mode: "paid" | "open") {
  if (r.next_date < HISTORY_START) throw new UserError("Abos können höchstens bis 01.01.2024 zurück nachgetragen werden.");
  const s = await getSettings(r.user_id);
  const t = today();
  const created: string[] = [];
  let guard = 0;
  while (r.next_date <= t && guard++ < 120) {
    const start = r.next_date;
    const next = addMonths(start, STEP[r.interval] ?? 1);
    const { data: draft, error } = await db.from("invoices").insert({
      user_id: r.user_id, kind: "invoice", status: "draft", customer_id: r.customer_id, items: r.items,
      service_text: `${fmtDate(start)} – ${fmtDate(addDays(next, -1))}`, intro: s.intro, recurring_id: r.id,
    }).select().single();
    if (error) throw error;
    await db.from("recurring").update({ next_date: next }).eq("id", r.id);
    r.next_date = next;
    const issueDate = workday(start) > t ? t : workday(start);
    const res = await issue(r.user_id, draft.id, false, { issueDate, paid: mode === "paid", paidAt: issueDate });
    created.push(res.invoice.number);
  }
  return { created, next_date: r.next_date };
}

async function runDaily() {
  const t = today();
  const report = { date: t, recurring: 0, reminders: 0, errors: [] as string[] };

  const { data: recs } = await db.from("recurring").select("*").eq("active", true).lte("next_date", t);
  for (const r of recs ?? []) {
    let guard = 0;
    while (r.next_date <= t && guard++ < 12) {
      try {
        await createFromRecurring(r);
        report.recurring++;
      } catch (e) {
        report.errors.push(`Abo ${r.id}: ${e instanceof Error ? e.message : e}`);
        break;
      }
    }
  }

  const { data: overdue } = await db.from("invoices")
    .select("id,user_id,due_date,reminders_sent,last_reminder_at")
    .eq("kind", "invoice").eq("status", "open").lt("due_date", t);
  const cache = new Map<string, Any>();
  for (const inv of overdue ?? []) {
    if (!cache.has(inv.user_id)) cache.set(inv.user_id, await getSettings(inv.user_id));
    const s = cache.get(inv.user_id);
    if (!s.reminders_enabled || s.reminders_enabled === "false") continue;
    if ((inv.reminders_sent ?? 0) >= Number(s.max_reminders || 0)) continue;
    const base = inv.last_reminder_at ?? inv.due_date;
    if (addDays(base, Number(s.reminder_interval) || 7) > t) continue;
    try {
      await sendInvoice(inv.user_id, inv.id, "reminder");
      report.reminders++;
    } catch (e) {
      report.errors.push(`Erinnerung ${inv.id}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return report;
}
