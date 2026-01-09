// FILE: app.js
// Minimal RP terminal for Supabase: anonymous auth + RPName/PIN binding + CRUD with RLS.
//
// Setup needed in Supabase dashboard:
// - Enable Anonymous Sign-ins (Auth settings) :contentReference[oaicite:5]{index=5}
// - Create tables + RLS via supabase_schema.sql (provided earlier) :contentReference[oaicite:6]{index=6}
//
// IMPORTANT: Put your own values here:
const SUPABASE_URL = "https://YOUR_PROJECT_REF.supabase.co";
const SUPABASE_ANON_KEY = "YOUR_SUPABASE_ANON_PUBLIC_KEY";

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

const el = (id) => document.getElementById(id);

function show(id) { el(id).classList.remove("hidden"); }
function hide(id) { el(id).classList.add("hidden"); }
function msg(id, text) { el(id).textContent = text || ""; }

function setWhoami(text) {
  el("whoami").textContent = text ? `Eingeloggt: ${text}` : "";
}

async function ensureAnonSession() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) return session;

  // Anonymous sign-in (no email, no PII) :contentReference[oaicite:7]{index=7}
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  return data.session;
}

async function loadEmployeesDropdown() {
  const { data, error } = await supabase
    .from("employees")
    .select("id,rp_name")
    .eq("active", true)
    .order("rp_name", { ascending: true });

  if (error) throw error;

  const sel = el("rpName");
  sel.innerHTML = "";
  for (const row of data) {
    const opt = document.createElement("option");
    opt.value = row.id;
    opt.textContent = row.rp_name;
    sel.appendChild(opt);
  }
}

async function verifyPin(employeeId, pin) {
  // We cannot verify bcrypt hash in client without exposing it.
  // So we call a safe SQL RPC? Here we use a simple approach:
  // We'll fetch pin_hash via a Postgres function with SECURITY DEFINER? No.
  //
  // Better: do verification in Postgres with a dedicated RPC function.
  // Let's create it on first run (you can also create in SQL editor).

  const { data, error } = await supabase.rpc("verify_employee_pin", {
    p_employee_id: employeeId,
    p_pin: pin,
  });
  if (error) throw error;
  return data === true;
}

async function bindCurrentUserToEmployee(employeeId) {
  // Insert link row user_id -> employee_id (RLS allows insert for own user_id)
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Kein User in Session.");

  const { error } = await supabase
    .from("employee_accounts")
    .insert({ user_id: user.id, employee_id: employeeId });

  // If already exists, ignore (PK conflict)
  if (error) {
    // PostgREST duplicate key usually returns 409
    if (String(error.code) === "23505" || error.status === 409) return;
    // Or "duplicate key value violates unique constraint"
    if ((error.message || "").toLowerCase().includes("duplicate")) return;
    throw error;
  }
}

async function getMyEmployee() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  // Read the link row
  const { data, error } = await supabase
    .from("employee_accounts")
    .select("employee_id, employees(rp_name, role)")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    employee_id: data.employee_id,
    rp_name: data.employees?.rp_name || "(unbekannt)",
    role: data.employees?.role || "artist",
  };
}

async function loadCustomersIntoSelect() {
  const { data, error } = await supabase
    .from("customers")
    .select("id,name,phone")
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) throw error;

  const sel = el("sessionCustomer");
  sel.innerHTML = "";
  for (const c of data) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.phone ? `${c.name} (${c.phone})` : c.name;
    sel.appendChild(opt);
  }
}

function renderCustomers(list) {
  const root = el("customersList");
  root.innerHTML = "";
  if (!list.length) {
    root.innerHTML = `<div class="muted">Keine Kunden gefunden.</div>`;
    return;
  }
  for (const c of list) {
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <div class="title">${escapeHtml(c.name)}</div>
      <div class="meta">${escapeHtml(c.phone || "")}</div>
      <div class="meta">${escapeHtml(c.notes || "")}</div>
      <button data-id="${c.id}">Bearbeiten</button>
    `;
    div.querySelector("button").addEventListener("click", () => editCustomer(c));
    root.appendChild(div);
  }
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function loadCustomers(search = "") {
  let q = supabase.from("customers").select("id,name,phone,notes,status,created_at").order("created_at", { ascending: false }).limit(200);
  if (search.trim()) {
    // naive search: name ilike or phone ilike
    const like = `%${search.trim()}%`;
    q = q.or(`name.ilike.${like},phone.ilike.${like}`);
  }
  const { data, error } = await q;
  if (error) throw error;
  renderCustomers(data || []);
}

function editCustomer(c) {
  // Simple inline edit prompt (minimal UI)
  const name = prompt("Name:", c.name ?? "");
  if (name === null) return;
  const phone = prompt("Telefon:", c.phone ?? "");
  if (phone === null) return;
  const notes = prompt("Notizen:", c.notes ?? "");
  if (notes === null) return;

  (async () => {
    try {
      const { error } = await supabase.from("customers").update({ name, phone, notes }).eq("id", c.id);
      if (error) throw error;
      await loadCustomers(el("custSearch").value || "");
    } catch (e) {
      alert(`Fehler: ${e.message || e}`);
    }
  })();
}

async function createCustomer(employeeId) {
  const name = el("custName").value.trim();
  const phone = el("custPhone").value.trim();
  const notes = el("custNotes").value.trim();
  if (!name) throw new Error("Bitte Kundenname eingeben.");

  const { error } = await supabase.from("customers").insert({
    name,
    phone: phone || null,
    notes: notes || null,
    created_by: employeeId,
  });
  if (error) throw error;

  el("custName").value = "";
  el("custPhone").value = "";
  el("custNotes").value = "";
}

function renderSessions(list) {
  const root = el("sessionsList");
  root.innerHTML = "";
  if (!list.length) {
    root.innerHTML = `<div class="muted">Keine Termine.</div>`;
    return;
  }
  for (const s of list) {
    const div = document.createElement("div");
    div.className = "item";
    const time = `${s.start_time || ""}${s.end_time ? "–" + s.end_time : ""}`.replaceAll("undefined", "").trim();
    div.innerHTML = `
      <div class="title">${escapeHtml(s.session_date)} ${escapeHtml(time)}</div>
      <div class="meta">${escapeHtml(s.customers?.name || "")} — ${escapeHtml(s.work_done || "")}</div>
      <div class="meta">${s.paid ? "✅ Bezahlt" : "❌ Offen"} ${escapeHtml(s.payment_method || "")}</div>
      <div class="meta">${escapeHtml(s.note || "")}</div>
    `;
    root.appendChild(div);
  }
}

async function loadMySessions(employeeId) {
  const { data, error } = await supabase
    .from("sessions")
    .select("id,session_date,start_time,end_time,work_done,paid,payment_method,note, customers(name)")
    .eq("employee_id", employeeId)
    .order("session_date", { ascending: true })
    .order("start_time", { ascending: true })
    .limit(200);

  if (error) throw error;
  renderSessions(data || []);
}

async function createSession(employeeId) {
  const customerId = el("sessionCustomer").value;
  const sessionDate = el("sessionDate").value;
  const start = el("sessionStart").value || null;
  const end = el("sessionEnd").value || null;
  const workDone = el("workDone").value.trim() || null;
  const paid = el("paid").checked;
  const paymentMethod = el("paymentMethod").value.trim() || null;
  const note = el("sessionNote").value.trim() || null;

  if (!customerId) throw new Error("Bitte Kunden auswählen.");
  if (!sessionDate) throw new Error("Bitte Datum wählen.");

  const { error } = await supabase.from("sessions").insert({
    customer_id: customerId,
    employee_id: employeeId,
    session_date: sessionDate,
    start_time: start,
    end_time: end,
    work_done: workDone,
    paid,
    payment_method: paymentMethod,
    note,
  });

  if (error) throw error;

  el("workDone").value = "";
  el("paid").checked = false;
  el("paymentMethod").value = "";
  el("sessionNote").value = "";
}

function hideAllPanels() {
  hide("panel-new-session");
  hide("panel-sessions");
  hide("panel-customers");
  hide("panel-new-customer");
}

async function setupDefaultDate() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  el("sessionDate").value = `${yyyy}-${mm}-${dd}`;
}

async function ensureVerifyFunctionExists() {
  // Create RPC function verify_employee_pin in DB, idempotent.
  // This keeps pin_hash private; client only gets boolean.
  const sql = `
create or replace function public.verify_employee_pin(p_employee_id uuid, p_pin text)
returns boolean
language sql
stable
security definer
as $$
  select exists (
    select 1
    from public.employees e
    where e.id = p_employee_id
      and e.active = true
      and e.pin_hash = crypt(p_pin, e.pin_hash)
  );
$$;

revoke all on function public.verify_employee_pin(uuid, text) from public;
grant execute on function public.verify_employee_pin(uuid, text) to authenticated;
`;
  // This uses the SQL endpoint via "rpc" is not possible; we must rely on manual creation in SQL editor.
  // We'll simply warn if missing later.
  return sql;
}

async function init() {
  try {
    await ensureAnonSession();

    // Load employees for login dropdown
    await loadEmployeesDropdown();

    // If already bound, skip login screen
    const me = await getMyEmployee();
    if (me) {
      setWhoami(me.rp_name);
      hide("screen-login");
      show("screen-terminal");
      hideAllPanels();
      await loadCustomersIntoSelect();
      await setupDefaultDate();
      await loadMySessions(me.employee_id);
      return;
    }

    setWhoami("");
    show("screen-login");
    hide("screen-terminal");

    // Show note about RPC function if needed
    const rpcSql = await ensureVerifyFunctionExists();
    msg("loginMsg", "Wenn der PIN-Check gleich fehlschlägt: In Supabase im SQL Editor die Funktion 'verify_employee_pin' anlegen (Code liegt im app.js, Suche nach ensureVerifyFunctionExists).");
    console.log("If needed, create verify_employee_pin with this SQL:\n", rpcSql);
  } catch (e) {
    msg("loginMsg", `Fehler beim Start: ${e.message || e}`);
  }
}

el("btnLogin").addEventListener("click", async () => {
  msg("loginMsg", "");
  try {
    await ensureAnonSession();

    const employeeId = el("rpName").value;
    const pin = el("pin").value.trim();
    if (!employeeId) throw new Error("Bitte RP-Name auswählen.");
    if (!pin) throw new Error("Bitte PIN eingeben.");

    // Verify pin via RPC
    const ok = await verifyPin(employeeId, pin);
    if (!ok) throw new Error("PIN falsch oder Mitarbeiter inaktiv.");

    await bindCurrentUserToEmployee(employeeId);

    const me = await getMyEmployee();
    setWhoami(me?.rp_name || "Mitarbeiter");
    hide("screen-login");
    show("screen-terminal");
    hideAllPanels();
    await loadCustomersIntoSelect();
    await setupDefaultDate();
    await loadMySessions(me.employee_id);
  } catch (e) {
    msg("loginMsg", `Login fehlgeschlagen: ${e.message || e}`);
  }
});

el("btnLogout").addEventListener("click", async () => {
  await supabase.auth.signOut();
  location.reload();
});

el("goNewSession").addEventListener("click", async () => {
  hideAllPanels();
  show("panel-new-session");
  const me = await getMyEmployee();
  if (me) await loadCustomersIntoSelect();
});

el("goSessions").addEventListener("click", async () => {
  hideAllPanels();
  show("panel-sessions");
  const me = await getMyEmployee();
  if (me) await loadMySessions(me.employee_id);
});

el("goCustomers").addEventListener("click", async () => {
  hideAllPanels();
  show("panel-customers");
  await loadCustomers(el("custSearch").value || "");
});

el("goNewCustomer").addEventListener("click", async () => {
  hideAllPanels();
  show("panel-new-customer");
});

el("custSearch").addEventListener("input", async () => {
  await loadCustomers(el("custSearch").value || "");
});

el("btnCreateCustomer").addEventListener("click", async () => {
  msg("custMsg", "");
  try {
    const me = await getMyEmployee();
    if (!me) throw new Error("Nicht eingeloggt.");
    await createCustomer(me.employee_id);
    msg("custMsg", "✅ Kunde gespeichert.");
    await loadCustomersIntoSelect();
  } catch (e) {
    msg("custMsg", `Fehler: ${e.message || e}`);
  }
});

el("btnCreateSession").addEventListener("click", async () => {
  msg("sessionMsg", "");
  try {
    const me = await getMyEmployee();
    if (!me) throw new Error("Nicht eingeloggt.");
    await createSession(me.employee_id);
    msg("sessionMsg", "✅ Termin gespeichert.");
    await loadMySessions(me.employee_id);
  } catch (e) {
    msg("sessionMsg", `Fehler: ${e.message || e}`);
  }
});

init();
