import { useCallback, useEffect, useState, type FormEvent } from "react";

type User = { id: string; email: string; role: "admin" | "member" };
type Server = {
  id: string;
  slug: string;
  name: string;
  url: string;
  authType: "none" | "bearer" | "header";
  headerName: string | null;
  hasCredential: boolean;
  enabled: boolean;
  status: "unknown" | "connected" | "unreachable";
  lastError: string | null;
  lastCheckedAt: string | null;
  tools: string[];
};
type ApiKey = {
  id: string;
  prefix: string;
  userId: string;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  userEmail: string;
};
type Member = {
  id: string;
  email: string;
  role: "member";
  createdAt: string;
};
type AuditEntry = {
  id: string;
  userEmail: string | null;
  source: "chat" | "mcp" | "admin";
  serverSlug: string | null;
  tool: string | null;
  detail: string | null;
  startedAt: string;
  durationMs: number;
  outcome: "success" | "error" | "rejected";
  errorMessage: string | null;
};
type Page = "servers" | "members" | "keys" | "audit";

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: "include",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      const body: unknown = await response.json();
      if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") {
        message = body.error;
      }
    } catch {
      message = `Request failed (${response.status}); the server did not return a readable error.`;
    }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function date(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "Never";
}

function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ user: User }>("/api/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      onLogin(result.user);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <div className="brand-mark">U</div>
        <p className="eyebrow">URUMI MCP GATEWAY</p>
        <h1>Welcome back</h1>
        <p className="muted">Sign in to manage your connected tools.</p>
        {error && <div className="alert error">{error}</div>}
        <label>Email address<input autoComplete="username" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
        <label>Password<input autoComplete="current-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
        <button className="primary full" disabled={busy}>{busy ? "Signing in..." : "Sign in"}</button>
      </form>
    </main>
  );
}

function ServersPage() {
  const [servers, setServers] = useState<Server[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [url, setUrl] = useState("");
  const [authType, setAuthType] = useState<Server["authType"]>("none");
  const [headerName, setHeaderName] = useState("");
  const [credential, setCredential] = useState("");

  const refresh = useCallback(async () => {
    try {
      const result = await api<{ servers: Server[] }>("/api/servers");
      setServers(result.servers);
      setError("");
    } catch (err) {
      setError(messageOf(err));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function createServer(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/servers", {
        method: "POST",
        body: JSON.stringify({
          slug, name, url, authType,
          ...(authType === "header" ? { headerName } : {}),
          ...(authType !== "none" ? { credential } : {}),
        }),
      });
      setShowCreate(false);
      setName(""); setSlug(""); setUrl(""); setAuthType("none"); setHeaderName(""); setCredential("");
      await refresh();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleServer(server: Server) {
    setError("");
    try {
      await api(`/api/servers/${server.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !server.enabled }),
      });
      await refresh();
    } catch (err) {
      setError(messageOf(err));
    }
  }

  async function saveServer(server: Server, form: HTMLFormElement) {
    const data = new FormData(form);
    const updates: Record<string, string> = {
      name: String(data.get("name") ?? ""),
      url: String(data.get("url") ?? ""),
    };
    const replacement = String(data.get("credential") ?? "");
    if (replacement) updates.credential = replacement;
    setError("");
    try {
      await api(`/api/servers/${server.id}`, { method: "PATCH", body: JSON.stringify(updates) });
      setEditing(null);
      await refresh();
    } catch (err) {
      setError(messageOf(err));
    }
  }

  async function deleteServer(server: Server) {
    if (!window.confirm(`Delete upstream "${server.name}"?`)) return;
    setError("");
    try {
      await api(`/api/servers/${server.id}`, { method: "DELETE" });
      await refresh();
    } catch (err) {
      setError(messageOf(err));
    }
  }

  return (
    <section className="page">
      <div className="page-heading">
        <div><p className="eyebrow">UPSTREAMS</p><h1>Servers</h1><p className="muted">Manage MCP connections and the tools they provide.</p></div>
        <div className="actions"><button className="secondary" onClick={() => void refresh()}>Refresh</button><button className="primary" onClick={() => setShowCreate(!showCreate)}>{showCreate ? "Cancel" : "Add server"}</button></div>
      </div>
      {error && <div className="alert error">{error}</div>}
      {showCreate && <form className="panel form-grid" onSubmit={createServer}>
        <h2 className="wide">Register an upstream</h2>
        <label>Display name<input value={name} onChange={(event) => setName(event.target.value)} required maxLength={100} /></label>
        <label>Slug<input value={slug} onChange={(event) => setSlug(event.target.value)} required maxLength={20} pattern="[a-z0-9]+(_[a-z0-9]+)*" placeholder="e.g. notes" /></label>
        <label className="wide">Streamable HTTP URL<input type="url" value={url} onChange={(event) => setUrl(event.target.value)} required placeholder="http://service.namespace.svc.cluster.local/mcp" /></label>
        <label>Authentication<select value={authType} onChange={(event) => setAuthType(event.target.value as Server["authType"])}><option value="none">None</option><option value="bearer">Bearer token</option><option value="header">Custom header</option></select></label>
        {authType === "header" && <label>Header name<input value={headerName} onChange={(event) => setHeaderName(event.target.value)} required /></label>}
        {authType !== "none" && <label className="wide">Upstream credential<input type="password" value={credential} onChange={(event) => setCredential(event.target.value)} required autoComplete="new-password" /></label>}
        <div className="wide"><button className="primary" disabled={busy}>{busy ? "Adding..." : "Register server"}</button></div>
      </form>}
      <div className="server-grid">
        {servers.map((server) => <article className="panel server-card" key={server.id}>
          <div className="card-top"><div><span className="slug">{server.slug}</span><h2>{server.name}</h2></div><span className={`badge ${server.enabled ? server.status : "disabled"}`}>{server.enabled ? server.status : "disabled"}</span></div>
          {editing === server.id ? <form className="edit-form" onSubmit={(event) => { event.preventDefault(); void saveServer(server, event.currentTarget); }}>
            <label>Name<input name="name" defaultValue={server.name} required /></label>
            <label>URL<input name="url" type="url" defaultValue={server.url} required /></label>
            {server.hasCredential && <p className="hint">Credential is set. Leave blank to keep it unchanged.</p>}
            {server.authType !== "none" && <label>Replace credential<input name="credential" type="password" autoComplete="new-password" /></label>}
            <div className="actions"><button className="primary">Save</button><button type="button" className="secondary" onClick={() => setEditing(null)}>Cancel</button></div>
          </form> : <>
            <p className="server-url">{server.url}</p>
            <p className="hint">Credential: {server.hasCredential ? "configured" : "none"} · Checked: {date(server.lastCheckedAt)}</p>
            {server.lastError && <p className="server-error">{server.lastError}</p>}
            <details><summary>Tools ({server.tools.length})</summary>{server.tools.length ? <ul className="tool-list">{server.tools.map((tool) => <li key={tool}>{tool}</li>)}</ul> : <p className="hint">No tools available while disconnected.</p>}</details>
            <div className="actions card-actions"><button className="secondary" onClick={() => setEditing(server.id)}>Edit</button><button className="secondary" onClick={() => void toggleServer(server)}>{server.enabled ? "Disable" : "Enable"}</button><button className="danger" onClick={() => void deleteServer(server)}>Delete</button></div>
          </>}
        </article>)}
      </div>
      {!servers.length && !error && <div className="empty panel">No upstream servers registered.</div>}
    </section>
  );
}

function KeysPage({ user }: { user: User }) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [createdKey, setCreatedKey] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    try {
      const result = await api<{ keys: ApiKey[] }>("/api/keys");
      setKeys(result.keys);
      setError("");
    } catch (err) {
      setError(messageOf(err));
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  async function createKey() {
    setError(""); setNotice("");
    try {
      const result = await api<{ key: string }>("/api/keys", { method: "POST" });
      setCreatedKey(result.key);
      await refresh();
    } catch (err) { setError(messageOf(err)); }
  }

  async function revokeKey(key: ApiKey) {
    if (!window.confirm(`Revoke API key ${key.prefix}? It will stop working immediately.`)) return;
    setError("");
    try {
      await api(`/api/keys/${key.id}`, { method: "DELETE" });
      if (createdKey) setCreatedKey("");
      await refresh();
    } catch (err) { setError(messageOf(err)); }
  }

  async function copy(value: string) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        setNotice("Copied to clipboard.");
        return;
      }
    } catch {
      // Fall back for HTTP origins where the Clipboard API is unavailable.
    }

    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    } finally {
      textarea.remove();
    }

    if (copied) {
      setNotice("Copied to clipboard.");
    } else {
      setError("Clipboard access failed. Select and copy the displayed value manually.");
    }
  }

  const cliCommand = `claude mcp add --transport http urumi ${window.location.origin}/mcp --header "Authorization: Bearer ${createdKey}"`;
  return <section className="page">
    <div className="page-heading"><div><p className="eyebrow">ACCESS</p><h1>API keys</h1><p className="muted">{user.role === "admin" ? "Keys for all team members." : "Your gateway keys."} Full key values are shown only once.</p></div><button className="primary" onClick={() => void createKey()}>Generate key</button></div>
    {error && <div className="alert error">{error}</div>}
    {notice && <div className="alert success">{notice}</div>}
    {createdKey && <div className="panel new-key">
      <div><p className="eyebrow">COPY NOW — THIS VALUE WON'T BE SHOWN AGAIN</p><code>{createdKey}</code></div>
      <div className="actions"><button className="secondary" onClick={() => void copy(createdKey)}>Copy key</button><button className="secondary" onClick={() => void copy(cliCommand)}>Copy Claude command</button><button className="plain" onClick={() => setCreatedKey("")}>Hide</button></div>
      <details><summary>Claude Code connection command</summary><code className="command">{cliCommand}</code></details>
    </div>}
    <div className="panel table-wrap"><table><thead><tr><th>Key prefix</th>{user.role === "admin" && <th>Owner</th>}<th>Created</th><th>Last used</th><th>Status</th><th></th></tr></thead>
      <tbody>{keys.map((key) => <tr key={key.id}><td><code>{key.prefix}…</code></td>{user.role === "admin" && <td>{key.userEmail}</td>}<td>{date(key.createdAt)}</td><td>{date(key.lastUsedAt)}</td><td><span className={`badge ${key.revokedAt ? "disabled" : "connected"}`}>{key.revokedAt ? "revoked" : "active"}</span></td><td>{!key.revokedAt && <button className="danger" onClick={() => void revokeKey(key)}>Revoke</button>}</td></tr>)}</tbody></table>
      {!keys.length && <p className="empty">No API keys yet.</p>}
    </div>
  </section>;
}

function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [server, setServer] = useState("");
  const [outcome, setOutcome] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const query = new URLSearchParams({ limit: "100" });
    if (server) query.set("server", server);
    if (outcome) query.set("outcome", outcome);
    try {
      const result = await api<{ entries: AuditEntry[] }>(`/api/audit?${query.toString()}`);
      setEntries(result.entries);
      setError("");
    } catch (err) { setError(messageOf(err)); }
  }, [server, outcome]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return <section className="page">
    <div className="page-heading"><div><p className="eyebrow">ACTIVITY</p><h1>Audit log</h1><p className="muted">Latest 100 tool calls and server/API-key admin actions. Refreshes every 15 seconds.</p></div><button className="secondary" onClick={() => void refresh()}>Refresh now</button></div>
    {error && <div className="alert error">{error}</div>}
    <div className="filters"><label>Server<input value={server} onChange={(event) => setServer(event.target.value)} placeholder="All servers" /></label><label>Outcome<select value={outcome} onChange={(event) => setOutcome(event.target.value)}><option value="">All outcomes</option><option value="success">Success</option><option value="error">Error</option><option value="rejected">Rejected</option></select></label></div>
    <div className="panel table-wrap"><table><thead><tr><th>Time</th><th>User</th><th>Source</th><th>Server / tool</th><th>Detail</th><th>Duration</th><th>Outcome</th><th>Error</th></tr></thead>
      <tbody>{entries.map((entry) => <tr key={entry.id}><td>{date(entry.startedAt)}</td><td>{entry.userEmail ?? "Unknown"}</td><td>{entry.source}</td><td>{entry.serverSlug ?? (entry.source === "admin" ? "Admin action" : "—")} / {entry.tool ?? "—"}</td><td>{entry.detail ?? "—"}</td><td>{entry.durationMs} ms</td><td><span className={`badge ${entry.outcome}`}>{entry.outcome}</span></td><td className="error-cell">{entry.errorMessage ?? "—"}</td></tr>)}</tbody></table>
      {!entries.length && !error && <p className="empty">No audit events match these filters.</p>}
    </div>
  </section>;
}

function MembersPage() {
  const [members, setMembers] = useState<Member[]>([]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await api<{ members: Member[] }>("/api/members");
      setMembers(result.members);
      setError("");
    } catch (err) {
      setError(messageOf(err));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function createMember(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api("/api/members", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      setEmail("");
      setPassword("");
      setNotice("Member created. Share their sign-in details securely.");
      await refresh();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeMember(member: Member) {
    if (!window.confirm(`Remove ${member.email}? Their API keys will be revoked and their audit history retained.`)) return;
    setRemovingId(member.id);
    setError("");
    setNotice("");
    try {
      await api(`/api/members/${member.id}`, { method: "DELETE" });
      setNotice(`${member.email} was removed.`);
      await refresh();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setRemovingId(null);
    }
  }

  return <section className="page">
    <div className="page-heading">
      <div><p className="eyebrow">TEAM</p><h1>Members</h1><p className="muted">Create accounts with the member role.</p></div>
    </div>
    {error && <div className="alert error">{error}</div>}
    {notice && <div className="alert success">{notice}</div>}
    <form className="panel form-grid" onSubmit={createMember}>
      <h2 className="wide">Add a member</h2>
      <label>Email address<input type="email" autoComplete="off" value={email} onChange={(event) => setEmail(event.target.value)} required maxLength={254} /></label>
      <label>Password<input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={12} maxLength={128} /></label>
      <div className="wide"><button className="primary" disabled={busy}>{busy ? "Creating..." : "Create member"}</button></div>
    </form>
    <div className="panel table-wrap"><table><thead><tr><th>Email</th><th>Role</th><th>Created</th><th></th></tr></thead>
      <tbody>{members.map((member) => <tr key={member.id}><td>{member.email}</td><td><span className="badge">member</span></td><td>{date(member.createdAt)}</td><td><button className="danger" disabled={removingId === member.id} onClick={() => void removeMember(member)}>{removingId === member.id ? "Removing..." : "Remove"}</button></td></tr>)}</tbody></table>
      {!members.length && !error && <p className="empty">No members yet.</p>}
    </div>
  </section>;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [page, setPage] = useState<Page>("servers");
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ user: User }>("/api/me")
      .then((result) => setUser(result.user))
      .catch(() => setUser(null))
      .finally(() => setChecking(false));
  }, []);

  async function logout() {
    setError("");
    try {
      await api("/api/logout", { method: "POST" });
      setUser(null);
    } catch (err) {
      setError(messageOf(err));
    }
  }

  if (checking) return <main className="loading">Loading your workspace…</main>;
  if (!user) return <Login onLogin={setUser} />;

  const nav: Array<{ id: Page; label: string; adminOnly?: boolean }> = [
    { id: "servers", label: "Servers", adminOnly: true },
    { id: "members", label: "Members", adminOnly: true },
    { id: "keys", label: "API keys" },
    { id: "audit", label: "Audit log", adminOnly: true },
  ];
  const allowedNav = nav.filter((item) => !item.adminOnly || user.role === "admin");
  const currentPage = allowedNav.some((item) => item.id === page) ? page : "keys";

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark small">U</span><span>urumi<span className="brand-light"> gateway</span></span></div>
      <p className="nav-caption">WORKSPACE</p>
      <nav>{allowedNav.map((item) => <button key={item.id} className={`nav-item ${currentPage === item.id ? "selected" : ""}`} onClick={() => setPage(item.id)}>{item.label}</button>)}</nav>
      <div className="sidebar-bottom"><span className="avatar">{user.email.slice(0, 1).toUpperCase()}</span><div className="identity"><strong>{user.email}</strong><span>{user.role}</span></div><button className="plain logout" onClick={() => void logout()}>Sign out</button></div>
    </aside>
    <main className="main-content">
      {error && <div className="alert error">{error}</div>}
      {currentPage === "servers" && user.role === "admin" && <ServersPage />}
      {currentPage === "members" && user.role === "admin" && <MembersPage />}
      {currentPage === "keys" && <KeysPage user={user} />}
      {currentPage === "audit" && user.role === "admin" && <AuditPage />}
    </main>
  </div>;
}
