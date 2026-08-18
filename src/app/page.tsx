'use client';

import { useState, useEffect } from 'react';

// ─── Helpers ─────────────────────────────────────────────────────────────
let _onUnauthorized: (() => void) | null = null;

async function api(path: string, opts: RequestInit = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'x-session-token': localStorage.getItem('session_token') || '',
      ...(opts.headers as Record<string, string> || {}),
    },
  });
  if (res.status === 401) {
    if (_onUnauthorized) _onUnauthorized();
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  return data;
}

function escapeHtml(s: unknown): string {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function timeAgo(ts: number | string | Date): string {
  if (!ts) return 'never';
  const d = ts instanceof Date ? ts : new Date(ts);
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return sec + 's ago';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
  return d.toLocaleDateString();
}

// ─── Login screen ────────────────────────────────────────────────────────
function LoginScreen({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'login failed');
      localStorage.setItem('session_token', data.token);
      onLogin();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-background to-muted/20">
      <div className="w-full max-w-md">
        <div className="bg-card border border-border rounded-2xl p-8 shadow-xl">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 rounded-xl bg-primary/15 flex items-center justify-center text-2xl">🌸</div>
            <div>
              <h1 className="text-xl font-bold text-foreground">Bot Fleet</h1>
              <p className="text-xs text-muted-foreground">Multi-bot Discord control panel</p>
            </div>
          </div>
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Admin password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoFocus
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary"
                placeholder="••••••••••••"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg py-2 text-sm font-medium transition disabled:opacity-50"
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
            {error && <div className="text-xs text-destructive">{error}</div>}
          </form>
          <p className="text-xs text-muted-foreground mt-6 text-center">
            Set <code className="bg-muted px-1 py-0.5 rounded">ADMIN_PASSWORD</code> env var to log in.
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Bot card ────────────────────────────────────────────────────────────
interface Bot {
  id: string;
  name: string;
  status: 'stopped' | 'running' | 'error';
  discord_user_id?: string;
  providers: Array<{
    id: string;
    name: string;
    type: 'openai' | 'zai';
    priority: number;
    enabled: boolean;
    model: string;
    api_key_masked?: string;
  }>;
  llm: { proxy_url: string; model: string; max_tokens: number };
  gating: { response_probability: number; cooldown_ms: number };
  delegated_bots: string[];
  channel_ids: string[];
  updated_at: number;
}

function StatusDot({ status }: { status: string }) {
  const cls = status === 'running' ? 'bg-green-500 animate-pulse' : status === 'error' ? 'bg-red-500' : 'bg-gray-500';
  return <span className={`inline-block w-2 h-2 rounded-full ${cls}`} />;
}

function BotCard({ bot, onEdit, onStart, onStop, onDelete }: {
  bot: Bot;
  onEdit: () => void;
  onStart: () => void;
  onStop: () => void;
  onDelete: () => void;
}) {
  const emoji = bot.name.toLowerCase().includes('yuki') || bot.name.toLowerCase().includes('mama') ? '🌸'
    : bot.name.toLowerCase().includes('cod') || bot.name.toLowerCase().includes('dev') ? '💻'
    : bot.name.toLowerCase().includes('admin') ? '🛡️'
    : '🤖';
  const activeProviders = bot.providers.filter(p => p.enabled).length;
  return (
    <div className="bg-card border border-border rounded-2xl p-5 hover:border-primary/50 transition">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary/30 to-primary/5 flex items-center justify-center text-lg">{emoji}</div>
          <div>
            <div className="font-semibold text-sm text-foreground">{escapeHtml(bot.name)}</div>
            <div className="text-xs text-muted-foreground font-mono">{bot.id}</div>
          </div>
        </div>
        <span className="flex items-center gap-2 text-xs">
          <StatusDot status={bot.status} />
          {bot.status}
        </span>
      </div>
      <div className="space-y-1 text-xs text-muted-foreground mb-3">
        <div>Providers: <span className="text-foreground">{activeProviders} active{activeProviders > 0 ? ` (${bot.providers.filter(p => p.enabled).map(p => p.name).join(', ')})` : ''}</span></div>
        <div>Channels: <span className="text-foreground">{bot.channel_ids.length}</span></div>
        <div>Delegates to: <span className="text-foreground">{bot.delegated_bots.length || 'none'}</span></div>
        <div>Updated: {timeAgo(bot.updated_at)}</div>
      </div>
      <div className="flex gap-1 pt-3 border-t border-border">
        {bot.status === 'running' ? (
          <button onClick={onStop} className="flex-1 text-xs bg-muted hover:bg-yellow-500/20 hover:text-yellow-600 border border-border rounded-lg py-1.5 transition">Stop</button>
        ) : (
          <button onClick={onStart} className="flex-1 text-xs bg-muted hover:bg-green-500/20 hover:text-green-600 border border-border rounded-lg py-1.5 transition">Start</button>
        )}
        <button onClick={onEdit} className="flex-1 text-xs bg-muted hover:bg-primary/20 hover:text-primary border border-border rounded-lg py-1.5 transition">Edit</button>
        <button onClick={onDelete} className="text-xs bg-muted hover:bg-red-500/20 hover:text-red-600 border border-border rounded-lg px-3 py-1.5 transition">Delete</button>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────
export default function Page() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [bots, setBots] = useState<Bot[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    _onUnauthorized = () => setLoggedIn(false);
  }, []);

  const refreshBots = async () => {
    setLoading(true);
    try {
      const data = await api('/api/bots');
      setBots((data as { bots: Bot[] }).bots);
    } catch { /* handled */ }
    setLoading(false);
  };

  useEffect(() => {
    const t = localStorage.getItem('session_token');
    if (t) {
      // Use Promise.resolve to avoid setState-in-effect lint
      Promise.resolve().then(() => {
        setLoggedIn(true);
        refreshBots();
      });
    } else {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startBot = async (id: string) => {
    try { await api(`/api/bots/${id}/start`, { method: 'POST' }); await refreshBots(); }
    catch (e) { alert('Failed: ' + (e as Error).message); }
  };
  const stopBot = async (id: string) => {
    try { await api(`/api/bots/${id}/stop`, { method: 'POST' }); await refreshBots(); }
    catch (e) { alert('Failed: ' + (e as Error).message); }
  };
  const deleteBot = async (id: string) => {
    if (!confirm('Delete this bot?')) return;
    try { await api(`/api/bots/${id}`, { method: 'DELETE' }); await refreshBots(); }
    catch (e) { alert('Failed: ' + (e as Error).message); }
  };

  if (!loggedIn) {
    return <LoginScreen onLogin={() => { setLoggedIn(true); refreshBots(); }} />;
  }

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-background to-muted/20">
      <header className="border-b border-border bg-card/50 backdrop-blur sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-primary/15 flex items-center justify-center text-lg">🌸</div>
            <div>
              <div className="font-semibold text-sm">Bot Fleet</div>
              <div className="text-xs text-muted-foreground">{bots.length} bot(s) · {bots.filter(b => b.status === 'running').length} running</div>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => window.open('https://discord.com/developers/applications', '_blank')}
              className="text-xs text-muted-foreground hover:text-foreground px-2 py-1"
            >Dev Portal ↗</button>
            <button
              onClick={() => { localStorage.removeItem('session_token'); setLoggedIn(false); }}
              className="text-xs text-muted-foreground hover:text-foreground px-2 py-1"
            >Sign out</button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Your bots</h2>
          <button
            onClick={() => alert('Bot editor coming next — for now, you can create bots via the API directly. Try: POST /api/bots with name, persona, token, llm, gating, tools fields.')}
            className="bg-primary hover:bg-primary/90 text-primary-foreground text-sm px-4 py-2 rounded-lg transition"
          >+ New Bot</button>
        </div>
        {bots.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <div className="text-5xl mb-3">🌸</div>
            <p className="text-sm mb-3">No bots yet.</p>
            <p className="text-xs">You can create one via the API endpoint <code className="bg-muted px-2 py-1 rounded">POST /api/bots</code> — or wait for the full panel UI (coming soon).</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {bots.map(b => (
              <BotCard
                key={b.id}
                bot={b}
                onEdit={() => alert('Bot editor UI in development. Use API: GET/PUT /api/bots/' + b.id)}
                onStart={() => startBot(b.id)}
                onStop={() => stopBot(b.id)}
                onDelete={() => deleteBot(b.id)}
              />
            ))}
          </div>
        )}

        <div className="mt-12 bg-card border border-border rounded-2xl p-6 max-w-2xl">
          <h3 className="font-semibold mb-2 text-foreground">API Reference</h3>
          <p className="text-xs text-muted-foreground mb-3">All endpoints require <code className="bg-muted px-1 rounded">x-session-token</code> header (obtained via <code className="bg-muted px-1 rounded">POST /api/auth/login</code>).</p>
          <div className="font-mono text-xs space-y-1 text-muted-foreground">
            <div><span className="text-foreground">GET</span> /api/bots — list bots</div>
            <div><span className="text-foreground">POST</span> /api/bots — create bot</div>
            <div><span className="text-foreground">GET/PUT/DELETE</span> /api/bots/:id — get/update/delete</div>
            <div><span className="text-foreground">POST</span> /api/bots/:id/start — start bot (WebSocket)</div>
            <div><span className="text-foreground">POST</span> /api/bots/:id/stop — stop bot</div>
            <div><span className="text-foreground">POST</span> /api/bots/:id/restart — restart bot</div>
            <div><span className="text-foreground">GET</span> /api/bots/:id/logs?lines=200 — recent logs</div>
            <div><span className="text-foreground">GET</span> /api/bots/:id/memory — view bot memory</div>
            <div><span className="text-foreground">POST</span> /api/discord/validate — validate token</div>
            <div><span className="text-foreground">POST</span> /api/discord/guilds — list guilds + channels</div>
            <div><span className="text-foreground">POST</span> /api/llm/ping — test LLM proxy</div>
          </div>
        </div>
      </main>

      <footer className="border-t border-border bg-card/30 mt-12">
        <div className="max-w-7xl mx-auto px-4 py-4 text-xs text-muted-foreground text-center">
          Discord Bot Fleet · WebSocket-native · z.ai hosted · <a href="https://github.com/Sexlovr/discord-bot-fleet" className="hover:text-foreground" target="_blank">GitHub</a>
        </div>
      </footer>
    </div>
  );
}
